import { PSTFile } from 'pst-extractor'

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

/**
 * Holds an open PST and the PSTMessage references discovered while walking it,
 * so message bodies can be decoded lazily instead of kept in memory for the
 * whole mailbox.
 */
export class PstSession {
  #messageRefs = []

  constructor(buffer) {
    this.pstFile = new PSTFile(buffer)
  }

  parse(onProgress = () => {}) {
    this.folders = []
    this.messages = []
    this.contacts = []
    this.#addressMap = new Map()
    this.#progress = onProgress
    this.#processed = 0

    this.#walk(this.pstFile.getRootFolder(), '', null)

    return {
      folders: this.folders,
      messages: this.messages,
      contacts: this.contacts,
      addresses: this.#finalizeAddresses(),
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
      this.#collectContact(item)
      return
    }
    this.#collectMessage(item, folderId, folderPath, messageClass)
  }

  #collectMessage(msg, folderId, folderPath, messageClass) {
    const id = this.messages.length
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

    if (isValidEmail(senderEmail)) this.#addAddress(senderEmail, senderName, 'sent')
    for (const r of recipients) {
      if (r.email) this.#addAddress(r.email, r.name, 'received')
    }
  }

  #collectContact(contact) {
    const emails = []
    for (const key of ['email1EmailAddress', 'email2EmailAddress', 'email3EmailAddress']) {
      const addr = safeGet(() => contact[key]) || ''
      if (isValidEmail(addr)) emails.push(addr.trim())
    }
    const entry = {
      name: safeGet(() => contact.displayName) || '',
      firstName: safeGet(() => contact.givenName) || '',
      lastName: safeGet(() => contact.surname) || '',
      emails,
      mobilePhone: safeGet(() => contact.mobileTelephoneNumber) || '',
      businessPhone: safeGet(() => contact.businessTelephoneNumber) || '',
      homePhone: safeGet(() => contact.homeTelephoneNumber) || '',
      company: safeGet(() => contact.companyName) || '',
      jobTitle: safeGet(() => contact.title) || '',
    }
    this.contacts.push(entry)
    for (const addr of emails) this.#addAddress(addr, entry.name, 'contact')
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
