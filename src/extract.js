import { Buffer } from 'buffer'
import { PSTFile } from 'pst-extractor'
import { ForensicCollector, classifyFolder } from './forensic.js'

const MAX_ATTACH_NAMES = 20 // names captured per message for the forensic scan

// ---------------------------------------------------------------------------
// Large-file support
//
// pst-extractor normally needs the entire PST as one in-memory Buffer, which
// caps usable files at a few hundred MB before the browser runs out of memory.
// Every byte the library reads, however, funnels through PSTFile.readSync(),
// so we swap that single method to pull 1 MiB slices straight from the File on
// demand (via FileReaderSync, which only exists in Web Workers) with a small
// LRU block cache. This lets us open multi-gigabyte PSTs without ever holding
// the whole file in memory.
// ---------------------------------------------------------------------------
const BLOCK_SIZE = 1 << 20 // 1 MiB read granularity
const MAX_CACHED_BLOCKS = 64 // ~64 MiB resident working set

// Patch readSync once so a file-backed instance routes reads through its own
// reader while plain Buffer-backed instances (used by tests) keep working.
let pendingReader = null
const originalReadSync = PSTFile.prototype.readSync
PSTFile.prototype.readSync = function (buffer, length, position) {
  const reader = this._sliceReader || pendingReader
  if (reader) {
    if (!this._sliceReader) this._sliceReader = reader
    return reader(buffer, length, position)
  }
  return originalReadSync.call(this, buffer, length, position)
}

function makeSliceReader(file) {
  const fileReader = new FileReaderSync()
  const size = file.size
  const cache = new Map() // blockIndex -> Uint8Array, iteration order = LRU

  const readBlock = (index) => {
    const cached = cache.get(index)
    if (cached) {
      cache.delete(index)
      cache.set(index, cached) // mark most-recently-used
      return cached
    }
    const start = index * BLOCK_SIZE
    const end = Math.min(start + BLOCK_SIZE, size)
    const block = new Uint8Array(fileReader.readAsArrayBuffer(file.slice(start, end)))
    cache.set(index, block)
    if (cache.size > MAX_CACHED_BLOCKS) cache.delete(cache.keys().next().value)
    return block
  }

  return (buffer, length, position) => {
    let written = 0
    let pos = position
    while (written < length && pos < size) {
      const index = Math.floor(pos / BLOCK_SIZE)
      const block = readBlock(index)
      const offset = pos - index * BLOCK_SIZE
      const take = Math.min(block.length - offset, length - written)
      if (take <= 0) break
      buffer.set(block.subarray(offset, offset + take), written)
      written += take
      pos += take
    }
    return written
  }
}

function openPstFile(source) {
  // Stream from a File/Blob without loading it all into memory.
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    pendingReader = makeSliceReader(source)
    try {
      const pst = new PSTFile(Buffer.alloc(0)) // header read goes through pendingReader
      pst._sliceReader = pendingReader
      return pst
    } finally {
      pendingReader = null
    }
  }
  // Buffer path (Node tests, small files): hand the whole thing to the library.
  return new PSTFile(source)
}

const EMAIL_RE = /^[^\s@<>,;:"'()[\]\\]+@[^\s@<>,;:"'()[\]\\]+\.[A-Za-z]{2,}$/
// Exchange IMCEA-encapsulated foreign addresses (IMCEANOTES-..., IMCEAEX-...)
// look like SMTP addresses but are not deliverable.
const IMCEA_RE = /^imcea[a-z0-9]*-/i

export function isValidEmail(addr) {
  if (typeof addr !== 'string') return false
  const trimmed = addr.trim()
  return EMAIL_RE.test(trimmed) && !IMCEA_RE.test(trimmed)
}

// Reduce an address to one canonical form so the same mailbox never shows up
// as several rows. Strips a "Display Name <addr>" wrapper, mailto:/smtp:
// schemes and stray angle brackets, then lower-cases it. Returns '' when the
// result isn't a real, deliverable address. Lower-casing is what guarantees
// John@X.com and john@x.com collapse to a single entry.
export function canonicalEmail(raw) {
  if (typeof raw !== 'string') return ''
  let s = raw.trim()
  const wrapped = s.match(/<([^<>]+)>/) // "Name <addr>" or "<addr>"
  if (wrapped) s = wrapped[1].trim()
  s = s.replace(/^(?:mailto|smtp):/i, '').trim()
  if (!EMAIL_RE.test(s) || IMCEA_RE.test(s)) return ''
  return s.toLowerCase()
}

const RECIPIENT_TYPES = { 1: 'to', 2: 'cc', 3: 'bcc' }

// On very large mailboxes (a 100 GB PST can hold millions of messages) we
// can't keep a browsable summary for every message in browser memory. We
// still scan ALL of them for email addresses — that map is memory-light — but
// cap how many full message rows we retain so the tab stays responsive and
// doesn't run out of memory. Address harvesting is never capped.
const MAX_RETAINED_MESSAGES = 100000

/**
 * Holds an open PST and the PSTMessage references discovered while walking it,
 * so message bodies can be decoded lazily instead of kept in memory for the
 * whole mailbox.
 */
export class PstSession {
  #messageRefs = []

  constructor(source) {
    this.pstFile = openPstFile(source)
  }

  parse(onProgress = () => {}, scope) {
    this.#scope = {
      addresses: scope ? scope.addresses !== false : true,
      messages: scope ? scope.messages !== false : true,
      contacts: scope ? scope.contacts !== false : true,
      forensic: scope ? scope.forensic === true : false,
      deepScan: scope ? scope.deepScan === true : false,
    }
    this.folders = []
    this.messages = []
    this.contacts = []
    this.totalMessages = 0 // every message scanned, even when not retained
    this.messagesTruncated = false
    this.#addressMap = new Map()
    this.#forensic = this.#scope.forensic ? new ForensicCollector({ deepScan: this.#scope.deepScan }) : null
    this.#progress = onProgress
    this.#processed = 0

    this.#walk(this.pstFile.getRootFolder(), '', null, 'other')

    return {
      folders: this.folders,
      messages: this.messages,
      contacts: this.contacts,
      addresses: this.#finalizeAddresses(),
      forensic: this.#forensic ? this.#finalizeForensic() : null,
      totalMessages: this.totalMessages,
      messagesTruncated: this.messagesTruncated,
      retainedMessages: this.messages.length,
    }
  }

  /** Decode bodies/headers for the given message ids. */
  getDetails(ids) {
    return ids.map((id) => {
      const msg = this.#messageRefs[id]
      if (!msg) return { id, body: '', bodyHTML: '', headers: '' }
      const detail = { id, body: '', bodyHTML: '', headers: '' }
      try { detail.body = msg.body || '' } catch { /* corrupt property */ }
      try { detail.bodyHTML = msg.bodyHTML || '' } catch { /* corrupt property */ }
      try { detail.headers = msg.transportMessageHeaders || '' } catch { /* corrupt property */ }
      return detail
    })
  }

  /** Scan retained message bodies for a phrase (case-insensitive). */
  searchBodies(query, { limit = 300 } = {}) {
    const q = String(query || '').toLowerCase().trim()
    const hits = []
    let scanned = 0
    if (!q) return { hits, scanned, truncated: false }
    for (let id = 0; id < this.#messageRefs.length; id++) {
      const msg = this.#messageRefs[id]
      if (!msg) continue
      scanned++
      const text = this.#messageText(msg)
      const idx = text.toLowerCase().indexOf(q)
      if (idx < 0) continue
      const start = Math.max(0, idx - 70)
      const snip = text.slice(start, idx + q.length + 70).replace(/\s+/g, ' ').trim()
      hits.push({ id, snippet: (start ? '…' : '') + snip + '…' })
      if (hits.length >= limit) return { hits, scanned, truncated: true }
    }
    return { hits, scanned, truncated: false }
  }

  /** Attachment list (names/sizes only) for a retained message. */
  getAttachments(id) {
    const msg = this.#messageRefs[id]
    if (!msg) return []
    const out = []
    const count = safeGet(() => msg.numberOfAttachments) || 0
    for (let i = 0; i < count; i++) {
      let a = null
      try { a = msg.getAttachment(i) } catch { continue }
      if (!a) continue
      const embedded = !!safeGet(() => a.embeddedPSTMessage)
      out.push({
        index: i,
        name: safeGet(() => a.longFilename) || safeGet(() => a.filename)
          || (embedded ? safeGet(() => a.embeddedPSTMessage.subject) : '') || `attachment-${i + 1}`,
        size: safeGet(() => a.filesize) || 0,
        mime: safeGet(() => a.mimeTag) || '',
        embedded,
      })
    }
    return out
  }

  /** Raw bytes of one attachment, as a transferable ArrayBuffer. */
  getAttachment(id, index) {
    const msg = this.#messageRefs[id]
    if (!msg) throw new Error('Message not available')
    const a = msg.getAttachment(index)
    if (!a) throw new Error('Attachment not found')
    const stream = a.fileInputStream
    if (!stream) throw new Error('This attachment is an embedded message and cannot be saved as a file')
    let size = safeGet(() => a.filesize) || 0
    try {
      const len = stream.length
      if (len && typeof len.toNumber === 'function') size = Math.max(size, len.toNumber())
    } catch { /* use filesize */ }
    const buf = Buffer.alloc(size)
    stream.readCompletely(buf)
    const name = safeGet(() => a.longFilename) || safeGet(() => a.filename) || `attachment-${index + 1}`
    const mime = safeGet(() => a.mimeTag) || 'application/octet-stream'
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
    return { name, mime, size, data }
  }

  #addressMap
  #forensic
  #progress
  #processed
  #scope = { addresses: true, messages: true, contacts: true, forensic: false, deepScan: false }

  #walk(folder, parentPath, parentId, parentCategory) {
    const id = this.folders.length
    const name = safeGet(() => folder.displayName) || (parentId === null ? 'Root' : '(unnamed)')
    const path = parentPath ? `${parentPath}/${name}` : name
    const category = parentId === null ? 'other' : classifyFolder(name, parentCategory)
    this.folders.push({ id, parentId, name, path, category, messageCount: 0 })

    if (safeGet(() => folder.contentCount) > 0) {
      for (;;) {
        let child = null
        try {
          child = folder.getNextChild()
        } catch {
          break
        }
        if (!child) break
        try {
          this.#collect(child, id, path, category)
        } catch { /* skip unreadable item */ }
        this.#processed++
        if (this.#processed % 100 === 0) {
          this.#progress({
            folders: this.folders.length,
            items: this.#processed,
            currentFolder: path,
          })
        }
      }
    }

    if (safeGet(() => folder.hasSubfolders)) {
      let subFolders = []
      try {
        subFolders = folder.getSubFolders()
      } catch { /* unreadable subtree */ }
      for (const sub of subFolders) this.#walk(sub, path, id, category)
    }
  }

  #collect(item, folderId, folderPath, folderCategory) {
    const messageClass = safeGet(() => item.messageClass) || ''
    if (messageClass.startsWith('IPM.Contact')) {
      // Process contacts when either Contacts or Addresses is in scope.
      if (this.#scope.contacts || this.#scope.addresses) this.#collectContact(item)
      return
    }
    // Process messages when Messages, Addresses, or Forensic is in scope.
    if (this.#scope.messages || this.#scope.addresses || this.#scope.forensic) {
      this.#collectMessage(item, folderId, folderPath, messageClass, folderCategory)
    }
  }

  #collectMessage(msg, folderId, folderPath, messageClass, folderCategory) {
    const senderName = safeGet(() => msg.senderName) || ''
    // Prefer the sender's address field; some items stash the address in the
    // name field instead, so fall back to it.
    const senderEmail = canonicalEmail(safeGet(() => msg.senderEmailAddress)) || canonicalEmail(senderName)

    const recipients = []
    const count = safeGet(() => msg.numberOfRecipients) || 0
    for (let i = 0; i < count; i++) {
      let r = null
      try { r = msg.getRecipient(i) } catch { continue }
      if (!r) continue
      const email = canonicalEmail(safeGet(() => r.smtpAddress)) || canonicalEmail(safeGet(() => r.emailAddress))
      recipients.push({
        name: safeGet(() => r.displayName) || '',
        email,
        type: RECIPIENT_TYPES[safeGet(() => r.recipientType)] || 'to',
      })
    }

    // Harvest addresses for every message — this is the memory-light path that
    // must scale to the whole mailbox.
    this.totalMessages++
    if (this.#scope.addresses) {
      if (senderEmail) this.#addAddress(senderEmail, senderName, 'sent')
      for (const r of recipients) {
        if (r.email) this.#addAddress(r.email, r.name, 'received')
      }
    }

    // Common metadata (computed once, reused by forensic + retained row).
    const date = safeGet(() => msg.clientSubmitTime) || safeGet(() => msg.messageDeliveryTime) || null
    const subject = safeGet(() => msg.subject) || ''
    const hasAttachments = !!safeGet(() => msg.hasAttachments)
    const isRead = !!safeGet(() => msg.isRead)
    const willRetain = this.#scope.messages && this.messages.length < MAX_RETAINED_MESSAGES

    // Feed the forensic collector for EVERY message (all folders), regardless
    // of the retention cap — the report must reflect the whole mailbox.
    let ref = null
    if (this.#forensic) {
      ref = this.#forensic.addMessage({
        id: willRetain ? this.messages.length : null,
        subject, senderName, senderEmail, date, folderPath, folderCategory,
        hasAttachments, isRead,
        messageId: safeGet(() => msg.internetMessageId) || '',
        topic: safeGet(() => msg.conversationTopic) || '',
        recipientEmails: recipients.map((r) => r.email).filter(Boolean),
        attachmentNames: hasAttachments ? this.#attachmentNames(msg) : [],
        bodyText: this.#scope.deepScan ? this.#messageText(msg) : '',
      })
    }

    // Nothing more to keep when the user didn't ask for the message list.
    if (!this.#scope.messages) return

    // Retain a browsable summary only up to the cap, to bound memory on huge
    // mailboxes. Beyond the cap, messages are still counted and scanned above.
    if (this.messages.length >= MAX_RETAINED_MESSAGES) {
      this.messagesTruncated = true
      return
    }

    const id = this.messages.length
    this.messages.push({
      id,
      ref, // forensic exhibit reference (null when forensic scan is off)
      folderId,
      folderPath,
      date,
      senderName,
      senderEmail, // canonical or ''
      subject,
      to: safeGet(() => msg.displayTo) || '',
      cc: safeGet(() => msg.displayCC) || '',
      bcc: safeGet(() => msg.displayBCC) || '',
      recipients,
      messageClass,
      hasAttachments,
      isRead,
    })
    this.#messageRefs[id] = msg
    this.folders[folderId].messageCount++
  }

  /** Attachment filenames (names only, capped) for the forensic scan. */
  #attachmentNames(msg) {
    const names = []
    const n = Math.min(safeGet(() => msg.numberOfAttachments) || 0, MAX_ATTACH_NAMES)
    for (let i = 0; i < n; i++) {
      let a = null
      try { a = msg.getAttachment(i) } catch { continue }
      if (!a) continue
      const name = safeGet(() => a.longFilename) || safeGet(() => a.filename) || safeGet(() => a.displayName) || ''
      if (name) names.push(name)
    }
    return names
  }

  /** Plain-text body for deep content scanning (HTML stripped as a fallback). */
  #messageText(msg) {
    let text = ''
    try { text = msg.body || '' } catch { /* corrupt */ }
    if (!text) {
      let html = ''
      try { html = msg.bodyHTML || '' } catch { /* corrupt */ }
      text = html.replace(/<[^>]+>/g, ' ')
    }
    return text
  }

  #collectContact(contact) {
    const emails = []
    for (const key of ['email1EmailAddress', 'email2EmailAddress', 'email3EmailAddress']) {
      const addr = canonicalEmail(safeGet(() => contact[key]))
      if (addr && !emails.includes(addr)) emails.push(addr)
    }
    const name = safeGet(() => contact.displayName) || ''
    if (this.#scope.addresses) {
      for (const addr of emails) this.#addAddress(addr, name, 'contact')
    }
    if (!this.#scope.contacts) return
    this.contacts.push({
      name,
      firstName: safeGet(() => contact.givenName) || '',
      lastName: safeGet(() => contact.surname) || '',
      emails,
      mobilePhone: safeGet(() => contact.mobileTelephoneNumber) || '',
      businessPhone: safeGet(() => contact.businessTelephoneNumber) || '',
      homePhone: safeGet(() => contact.homeTelephoneNumber) || '',
      company: safeGet(() => contact.companyName) || '',
      jobTitle: safeGet(() => contact.title) || '',
    })
  }

  #addAddress(email, name, role) {
    // email arrives already canonical (lower-cased + validated), so the map key
    // and the stored/displayed address are identical — no near-duplicate rows.
    let entry = this.#addressMap.get(email)
    if (!entry) {
      entry = { email, names: new Map(), sent: 0, received: 0, contact: false }
      this.#addressMap.set(email, entry)
    }
    if (role === 'sent') entry.sent++
    else if (role === 'received') entry.received++
    else entry.contact = true
    const cleanName = (name || '').trim()
    if (cleanName && !canonicalEmail(cleanName)) {
      entry.names.set(cleanName, (entry.names.get(cleanName) || 0) + 1)
    }
  }

  #finalizeAddresses() {
    const out = []
    for (const entry of this.#addressMap.values()) {
      let bestName = ''
      let bestCount = 0
      for (const [name, count] of entry.names) {
        if (count > bestCount) { bestName = name; bestCount = count }
      }
      out.push({
        email: entry.email,
        name: bestName,
        sent: entry.sent,
        received: entry.received,
        contact: entry.contact,
        total: entry.sent + entry.received,
      })
    }
    out.sort((a, b) => b.total - a.total || a.email.localeCompare(b.email))
    return out
  }

  // Merge the collector's report with top-party/domain stats derived from the
  // address map (which already tallies per-address sent/received counts).
  #finalizeForensic() {
    const addrs = [...this.#addressMap.values()]

    const topSenders = addrs.filter((a) => a.sent > 0)
      .sort((a, b) => b.sent - a.sent).slice(0, 15)
      .map((a) => ({ email: a.email, count: a.sent }))
    const topRecipients = addrs.filter((a) => a.received > 0)
      .sort((a, b) => b.received - a.received).slice(0, 15)
      .map((a) => ({ email: a.email, count: a.received }))

    const domainTotals = new Map()
    const domainSent = new Map()
    for (const a of addrs) {
      const at = a.email.lastIndexOf('@')
      if (at < 0) continue
      const domain = a.email.slice(at + 1)
      domainTotals.set(domain, (domainTotals.get(domain) || 0) + a.sent + a.received)
      if (a.sent) domainSent.set(domain, (domainSent.get(domain) || 0) + a.sent)
    }
    const topDomains = [...domainTotals.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([domain, count]) => ({ domain, count }))
    // The mailbox owner most likely sends from the busiest sending domain.
    const primaryDomain = [...domainSent.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''

    // Now the collector can classify complaints (client = external) and
    // match complaints against outbound replies.
    const report = this.#forensic.finalize({ primaryDomain })

    let externalSenders = 0
    for (const a of addrs) {
      if (!a.sent) continue
      const at = a.email.lastIndexOf('@')
      if (at >= 0 && a.email.slice(at + 1) !== primaryDomain) externalSenders++
    }

    report.topSenders = topSenders
    report.topRecipients = topRecipients
    report.topDomains = topDomains
    report.primaryDomain = primaryDomain
    report.externalSenders = externalSenders
    report.uniqueSenders = addrs.filter((a) => a.sent > 0).length
    report.uniqueRecipients = addrs.filter((a) => a.received > 0).length
    report.uniqueDomains = domainTotals.size
    report.folderList = this.folders.map((f) => ({ name: f.name, path: f.path, category: f.category, messageCount: f.messageCount }))
    return report
  }
}

function safeGet(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}
