// ---------------------------------------------------------------------------
// Forensic analysis
//
// Heuristic, rule-based investigation of a whole mailbox. Everything here runs
// locally with no AI/network — it classifies folders, buckets messages by
// investigative keyword categories, flags risky signals, and aggregates
// activity into a single report object the UI renders. Category matching runs
// over subjects always, and over bodies when a deep content scan is enabled.
// ---------------------------------------------------------------------------

// Investigative keyword categories. Terms are matched case-insensitively as
// whole words/phrases against subject (+ body on a deep scan).
export const CATEGORIES = [
  {
    key: 'complaints',
    label: 'Complaints & dissatisfaction',
    terms: [
      'complaint', 'complain', 'unhappy', 'dissatisfied', 'dissatisfaction', 'not happy',
      'disappointed', 'disappointing', 'poor service', 'bad service', 'unacceptable',
      'escalate', 'escalation', 'terrible', 'worst', 'angry', 'frustrated', 'frustrating',
      'unresolved', 'still waiting', 'no response', 'misled', 'misleading', 'let down',
      'not good enough', 'demand', 'refund', 'compensation',
    ],
  },
  {
    key: 'legal',
    label: 'Legal & threats',
    terms: [
      'lawyer', 'attorney', 'solicitor', 'lawsuit', 'sue', 'legal action', 'court',
      'subpoena', 'litigation', 'breach of contract', 'defamation', 'liable', 'liability',
      'damages', 'cease and desist', 'terminate', 'termination', 'dispute', 'arbitration',
      'small claims', 'settlement', 'notice of', 'without prejudice',
    ],
  },
  {
    key: 'financial',
    label: 'Financial & fraud',
    terms: [
      'invoice', 'payment', 'overdue', 'outstanding balance', 'past due', 'wire transfer',
      'bank details', 'account number', 'sort code', 'routing number', 'chargeback',
      'fraud', 'fraudulent', 'unauthorized', 'unauthorised', 'refund', 'remittance',
      'purchase order', 'quotation', 'deposit', 'bitcoin', 'crypto', 'gift card',
    ],
  },
  {
    key: 'security',
    label: 'Security & phishing',
    terms: [
      'password', 'passcode', 'credential', 'credentials', 'log in', 'login', 'sign in',
      'verify your account', 'reset your password', 'one-time', 'otp', '2fa',
      'account suspended', 'unusual activity', 'confirm your identity', 'click here',
      'update your details', 'security alert', 'locked', 'phishing', 'malware', 'ransomware',
    ],
  },
  {
    key: 'hr',
    label: 'HR & conduct',
    terms: [
      'harassment', 'harass', 'discrimination', 'discriminate', 'bully', 'bullying',
      'hostile', 'inappropriate', 'misconduct', 'grievance', 'whistleblow', 'whistleblower',
      'retaliation', 'unsafe', 'complaint against', 'code of conduct', 'disciplinary',
      'confidential', 'redundancy', 'dismissal',
    ],
  },
]

// Precompile one case-insensitive alternation per category.
const CATEGORY_MATCHERS = CATEGORIES.map((c) => ({
  key: c.key,
  label: c.label,
  re: new RegExp('\\b(?:' + c.terms.map(escapeRe).join('|') + ')\\b', 'i'),
}))

// Sensitive data patterns (deep scan only). We record that a pattern was seen,
// never the matched value itself.
const SENSITIVE = [
  { type: 'Credit card number', re: /\b(?:\d[ -]?){13,16}\b/, luhn: true },
  { type: 'US SSN', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/ },
]

// Attachment extensions that warrant a second look in an investigation.
export const RISKY_EXT = new Set([
  'exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'js', 'jse', 'vbs', 'vbe', 'ps1', 'psm1',
  'jar', 'msi', 'msix', 'dll', 'lnk', 'iso', 'img', 'hta', 'wsf', 'reg', 'ace',
  'docm', 'xlsm', 'pptm', 'dotm', 'xlam', 'html', 'htm',
])

// Sample/detail caps so a huge mailbox can't blow up the report object.
const MAX_SAMPLES = 200
const MAX_ATTACH_DETAIL = 1000
const MAX_MISMATCH = 500
const MAX_SENSITIVE = 500

const FOLDER_RULES = [
  [/(^|[^a-z])sent([^a-z]|$)|sent items|sent mail|outbox/i, 'sent'],
  [/draft/i, 'drafts'],
  [/deleted items|trash|bin|recycle/i, 'deleted'],
  [/junk|spam|bulk/i, 'junk'],
  [/archive/i, 'archive'],
  [/inbox/i, 'inbox'],
]

/** Bucket a folder by name; children inherit a parent's deleted/junk bucket. */
export function classifyFolder(name, parentCategory) {
  const n = String(name || '')
  for (const [re, cat] of FOLDER_RULES) if (re.test(n)) return cat
  if (parentCategory === 'deleted' || parentCategory === 'junk') return parentCategory
  return 'other'
}

export function attachmentExt(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/)
  return m ? m[1] : ''
}

export class ForensicCollector {
  constructor({ deepScan = false } = {}) {
    this.deepScan = deepScan
    this.total = 0
    this.sent = 0
    this.received = 0
    this.drafts = 0
    this.withAttachments = 0
    this.unread = 0
    this.folders = { inbox: 0, sent: 0, drafts: 0, deleted: 0, junk: 0, archive: 0, other: 0 }
    this.byYear = {}
    this.byHour = new Array(24).fill(0)
    this.byWeekday = new Array(7).fill(0)
    this.afterHours = 0
    this.weekend = 0
    this.dated = 0
    this.minDate = null
    this.maxDate = null
    this.categories = {}
    for (const c of CATEGORY_MATCHERS) this.categories[c.key] = { label: c.label, count: 0, samples: [] }
    this.attachmentTypes = {}
    this.riskyAttachments = []
    this.riskyAttachmentTotal = 0
    this.nameMismatch = []
    this.nameMismatchTotal = 0
    this.sensitive = []
    this.sensitiveTotal = 0
    this.attachDetailBudget = MAX_ATTACH_DETAIL
  }

  addMessage(m) {
    this.total++

    // Folder buckets + sent/received/draft split.
    const cat = m.folderCategory || 'other'
    if (this.folders[cat] === undefined) this.folders.other++
    else this.folders[cat]++
    if (cat === 'drafts') this.drafts++
    else if (cat === 'sent') this.sent++
    else this.received++

    if (m.hasAttachments) this.withAttachments++
    if (m.isRead === false) this.unread++

    // Activity histograms.
    if (m.date instanceof Date && !isNaN(m.date)) {
      this.dated++
      const y = m.date.getFullYear()
      this.byYear[y] = (this.byYear[y] || 0) + 1
      const h = m.date.getHours()
      const d = m.date.getDay()
      this.byHour[h]++
      this.byWeekday[d]++
      if (h < 7 || h >= 19) this.afterHours++
      if (d === 0 || d === 6) this.weekend++
      if (!this.minDate || m.date < this.minDate) this.minDate = m.date
      if (!this.maxDate || m.date > this.maxDate) this.maxDate = m.date
    }

    // Attachments — extension tally + risky flag.
    if (m.attachmentNames && m.attachmentNames.length) {
      for (const name of m.attachmentNames) {
        const ext = attachmentExt(name)
        if (!ext) continue
        this.attachmentTypes[ext] = (this.attachmentTypes[ext] || 0) + 1
        if (RISKY_EXT.has(ext)) {
          this.riskyAttachmentTotal++
          if (this.riskyAttachments.length < MAX_ATTACH_DETAIL) {
            this.riskyAttachments.push({ name, ext, from: m.senderEmail || m.senderName, folder: m.folderPath, date: m.date, subject: m.subject })
          }
        }
      }
    }

    // Sender display-name vs address mismatch (spoofing signal): the display
    // name embeds an email whose domain differs from the actual sender domain.
    const nameAddr = firstEmailIn(m.senderName)
    if (nameAddr && m.senderEmail && domainOf(nameAddr) !== domainOf(m.senderEmail)) {
      this.nameMismatchTotal++
      if (this.nameMismatch.length < MAX_MISMATCH) {
        this.nameMismatch.push({ senderName: m.senderName, senderEmail: m.senderEmail, subject: m.subject, folder: m.folderPath })
      }
    }

    // Keyword categories: subject always, body on a deep scan.
    const subject = m.subject || ''
    const body = this.deepScan ? (m.bodyText || '') : ''
    const haystack = body ? subject + '\n' + body : subject
    for (const c of CATEGORY_MATCHERS) {
      const match = c.re.exec(haystack)
      if (!match) continue
      const bucket = this.categories[c.key]
      bucket.count++
      if (bucket.samples.length < MAX_SAMPLES) {
        bucket.samples.push({
          id: m.id ?? null,
          subject, from: m.senderEmail || m.senderName, date: m.date,
          folder: m.folderPath, term: match[0], snippet: snippet(haystack, match.index),
        })
      }
    }

    // Sensitive data (deep scan only).
    if (body) {
      for (const s of SENSITIVE) {
        const mm = s.re.exec(body)
        if (!mm) continue
        if (s.luhn && !luhn(mm[0])) continue
        this.sensitiveTotal++
        if (this.sensitive.length < MAX_SENSITIVE) {
          this.sensitive.push({ type: s.type, from: m.senderEmail || m.senderName, subject, folder: m.folderPath, date: m.date })
        }
        break
      }
    }
  }

  finalize() {
    return {
      deepScan: this.deepScan,
      total: this.total,
      sent: this.sent,
      received: this.received,
      drafts: this.drafts,
      withAttachments: this.withAttachments,
      unread: this.unread,
      folders: this.folders,
      dateRange: { min: this.minDate, max: this.maxDate, dated: this.dated },
      activity: {
        byYear: this.byYear,
        byHour: this.byHour,
        byWeekday: this.byWeekday,
        afterHours: this.afterHours,
        weekend: this.weekend,
      },
      categories: this.categories,
      attachmentTypes: this.attachmentTypes,
      riskyAttachments: this.riskyAttachments,
      riskyAttachmentTotal: this.riskyAttachmentTotal,
      nameMismatch: this.nameMismatch,
      nameMismatchTotal: this.nameMismatchTotal,
      sensitive: this.sensitive,
      sensitiveTotal: this.sensitiveTotal,
    }
  }
}

// --- helpers ---------------------------------------------------------------
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function snippet(text, index, span = 90) {
  const start = Math.max(0, index - span / 2)
  const raw = text.slice(start, start + span).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + raw + (start + span < text.length ? '…' : '')
}

function domainOf(email) {
  const at = String(email || '').lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).toLowerCase() : ''
}

function firstEmailIn(text) {
  const m = String(text || '').match(/[^\s@<>,;:"'()[\]\\]+@[^\s@<>,;:"'()[\]\\]+\.[A-Za-z]{2,}/)
  return m ? m[0] : ''
}

function luhn(value) {
  const digits = String(value).replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}
