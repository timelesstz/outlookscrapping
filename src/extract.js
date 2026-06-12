import { Buffer } from 'buffer'
import { PSTFile } from 'pst-extractor'

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
    }
    this.folders = []
    this.messages = []
    this.contacts = []
    this.totalMessages = 0 // every message scanned, even when not retained
    this.messagesTruncated = false
    this.#addressMap = new Map()
    this.#progress = onProgress
    this.#processed = 0

    this.#walk(this.pstFile.getRootFolder(), '', null)

    return {
      folders: this.folders,
      messages: this.messages,
      contacts: this.contacts,
      addresses: this.#finalizeAddresses(),
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

  #addressMap
  #progress
  #processed
  #scope = { addresses: true, messages: true, contacts: true }

  #walk(folder, parentPath, parentId) {
    const id = this.folders.length
    const name = safeGet(() => folder.displayName) || (parentId === null ? 'Root' : '(unnamed)')
    const path = parentPath ? `${parentPath}/${name}` : name
    this.folders.push({ id, parentId, name, path, messageCount: 0 })

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
          this.#collect(child, id, path)
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
      for (const sub of subFolders) this.#walk(sub, path, id)
    }
  }

  #collect(item, folderId, folderPath) {
    const messageClass = safeGet(() => item.messageClass) || ''
    if (messageClass.startsWith('IPM.Contact')) {
      // Process contacts when either Contacts or Addresses is in scope.
      if (this.#scope.contacts || this.#scope.addresses) this.#collectContact(item)
      return
    }
    // Process messages when either Messages or Addresses is in scope.
    if (this.#scope.messages || this.#scope.addresses) {
      this.#collectMessage(item, folderId, folderPath, messageClass)
    }
  }

  #collectMessage(msg, folderId, folderPath, messageClass) {
    const senderName = safeGet(() => msg.senderName) || ''
    let senderEmail = safeGet(() => msg.senderEmailAddress) || ''
    if (!isValidEmail(senderEmail)) senderEmail = isValidEmail(senderName) ? senderName : senderEmail

    const recipients = []
    const count = safeGet(() => msg.numberOfRecipients) || 0
    for (let i = 0; i < count; i++) {
      let r = null
      try { r = msg.getRecipient(i) } catch { continue }
      if (!r) continue
      const smtp = safeGet(() => r.smtpAddress) || ''
      const fallback = safeGet(() => r.emailAddress) || ''
      const email = isValidEmail(smtp) ? smtp : (isValidEmail(fallback) ? fallback : '')
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
      if (isValidEmail(senderEmail)) this.#addAddress(senderEmail, senderName, 'sent')
      for (const r of recipients) {
        if (r.email) this.#addAddress(r.email, r.name, 'received')
      }
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
      folderId,
      folderPath,
      date: safeGet(() => msg.clientSubmitTime) || safeGet(() => msg.messageDeliveryTime) || null,
      senderName,
      senderEmail: isValidEmail(senderEmail) ? senderEmail : '',
      subject: safeGet(() => msg.subject) || '',
      to: safeGet(() => msg.displayTo) || '',
      cc: safeGet(() => msg.displayCC) || '',
      bcc: safeGet(() => msg.displayBCC) || '',
      recipients,
      messageClass,
      hasAttachments: !!safeGet(() => msg.hasAttachments),
      isRead: !!safeGet(() => msg.isRead),
    })
    this.#messageRefs[id] = msg
    this.folders[folderId].messageCount++
  }

  #collectContact(contact) {
    const emails = []
    for (const key of ['email1EmailAddress', 'email2EmailAddress', 'email3EmailAddress']) {
      const addr = safeGet(() => contact[key]) || ''
      if (isValidEmail(addr)) emails.push(addr.trim())
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
    const key = email.trim().toLowerCase()
    let entry = this.#addressMap.get(key)
    if (!entry) {
      entry = { email: email.trim(), names: new Map(), sent: 0, received: 0, contact: false }
      this.#addressMap.set(key, entry)
    }
    if (role === 'sent') entry.sent++
    else if (role === 'received') entry.received++
    else entry.contact = true
    const cleanName = (name || '').trim()
    if (cleanName && !isValidEmail(cleanName)) {
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
}

function safeGet(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}
