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

// --- Client-complaint detection -------------------------------------------
// Sub-type tags let the register group complaints by what they're about.
const COMPLAINT_TAGS = [
  { tag: 'billing', re: /\b(invoice|overcharg|double charg|billed|bill|charge|refund|payment|overpaid|wrong amount)\w*/i },
  { tag: 'delay', re: /\b(delay|late|overdue|still waiting|no response|not received|chasing|follow ?up|awaiting)\w*/i },
  { tag: 'quality', re: /\b(faulty|broken|defect|damaged|not working|doesn'?t work|poor quality|substandard|wrong item)\w*/i },
  { tag: 'service', re: /\b(rude|unhelpful|staff|agent|representative|attitude|ignored|hung up|customer service)\w*/i },
  { tag: 'cancellation', re: /\b(cancel|terminate|close my account|refund|money back|switch provider)\w*/i },
]
// Words that make a complaint more serious / escalated.
const ESCALATION_RE = /\b(unacceptable|escalat\w*|final (?:notice|warning)|last time|sue|lawyer|attorney|legal action|ombudsman|regulator|trading standards|small claims|cancel\w*|terminate\w*|never again|worst|disgrace\w*|furious|outrage\w*|demand\w*)\b/i
// Any signal that a message is a complaint at all (superset of the category).
const COMPLAINT_SIGNAL_RE = /\b(complain\w*|unhappy|dissatisf\w*|not happy|disappoint\w*|poor service|bad service|unacceptable|escalat\w*|terrible|worst|angry|furious|frustrat\w*|unresolved|still waiting|no response|misled|mislead\w*|let down|refund|compensation|faulty|broken|defect\w*|not working|overcharg\w*|rude|unhelpful|demand\w*|disgrace\w*)\b/i

// Business-email-compromise / payment-change requests — a core audit red flag.
const BEC_RE = /\b((?:change|update|amend|new|different|revised|updated)[^.\n]{0,40}(?:bank|account|payment|remittance|beneficiary|banking) (?:details|account|number|information|info)|(?:remit|pay|wire|transfer)[^.\n]{0,30}(?:to (?:the )?(?:new|updated|different)|new account)|bank(?:ing)? details have changed|our (?:bank|account) has changed)\b/i
// Explicit approval / sign-off language (governance signal).
const APPROVAL_RE = /\b(approv\w*|authoris\w*|authoriz\w*|sign(?:ed)? off|sign-off|go ahead|greenlight|green light|proceed with|confirm(?:ed)? the (?:order|payment|purchase))\b/i

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
    this.byMonth = {} // 'YYYY-MM' -> count, for retention/gap analysis
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
    // Complaints + audit accumulators.
    this.complaints = [] // raw complaint records (capped), resolved in finalize()
    this.complaintsTotal = 0
    this.sentTo = new Map() // recipient email -> latest outbound time (ms); for reply matching
    this.bec = [] // payment/bank-change requests
    this.becTotal = 0
    this.approvals = 0
    this.refSeq = 0 // running exhibit reference for every scanned message
  }

  // Score how serious a complaint looks from its text.
  #complaintSeverity(text) {
    const hits = (text.match(new RegExp(COMPLAINT_SIGNAL_RE.source, 'gi')) || []).length
    const escalated = ESCALATION_RE.test(text)
    let score = hits + (escalated ? 3 : 0)
    if (score >= 4 || (escalated && hits >= 1)) return 'high'
    if (score >= 2) return 'medium'
    return 'low'
  }

  #complaintTags(text) {
    const tags = []
    for (const t of COMPLAINT_TAGS) if (t.re.test(text)) tags.push(t.tag)
    return tags.length ? tags : ['general']
  }

  addMessage(m) {
    this.total++
    // Stable, human-citable reference for this message + its global Message-ID.
    // Every detection below records `ref`/`messageId` so any finding traces
    // back to the exact source email.
    const ref = 'M' + String(++this.refSeq).padStart(6, '0')
    const messageId = m.messageId || ''

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
      const mk = `${y}-${String(m.date.getMonth() + 1).padStart(2, '0')}`
      this.byMonth[mk] = (this.byMonth[mk] || 0) + 1
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
            this.riskyAttachments.push({ ref, messageId, name, ext, from: m.senderEmail || m.senderName, folder: m.folderPath, date: m.date, subject: m.subject })
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
        this.nameMismatch.push({ ref, messageId, senderName: m.senderName, senderEmail: m.senderEmail, subject: m.subject, folder: m.folderPath, date: m.date })
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
          id: m.id ?? null, ref, messageId,
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
          this.sensitive.push({ ref, messageId, type: s.type, from: m.senderEmail || m.senderName, subject, folder: m.folderPath, date: m.date })
        }
        break
      }
    }

    // Track outbound mail so complaints can be marked answered/unanswered.
    if (cat === 'sent' && m.recipientEmails) {
      const t = m.date instanceof Date ? m.date.getTime() : 0
      for (const rcpt of m.recipientEmails) {
        const prev = this.sentTo.get(rcpt) || 0
        if (t > prev) this.sentTo.set(rcpt, t)
      }
    }

    // Complaint detection (incoming mail only; sent/drafts are the org's own).
    if (cat !== 'sent' && cat !== 'drafts' && COMPLAINT_SIGNAL_RE.test(haystack)) {
      this.complaintsTotal++
      if (this.complaints.length < MAX_SAMPLES * 5) {
        this.complaints.push({
          ref, messageId, id: m.id ?? null,
          client: m.senderEmail || '',
          clientName: m.senderName || '',
          date: m.date instanceof Date ? m.date.getTime() : null,
          subject,
          folder: m.folderPath,
          severity: this.#complaintSeverity(haystack),
          tags: this.#complaintTags(haystack),
          escalated: ESCALATION_RE.test(haystack),
          snippet: snippet(haystack, Math.max(0, haystack.search(COMPLAINT_SIGNAL_RE))),
        })
      }
    }

    // Payment/bank-change request — a business-email-compromise audit flag.
    if (BEC_RE.test(haystack)) {
      this.becTotal++
      if (this.bec.length < MAX_MISMATCH) {
        this.bec.push({ ref, messageId, from: m.senderEmail || m.senderName, subject, folder: m.folderPath, date: m.date, sent: cat === 'sent' })
      }
    }
    if (APPROVAL_RE.test(haystack)) this.approvals++

    return ref
  }

  finalize(opts = {}) {
    const complaints = this.#buildComplaints(opts.primaryDomain || '')
    const audit = this.#buildAudit(complaints, opts.primaryDomain || '')
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
        byMonth: this.byMonth,
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
      complaints,
      audit,
      approvals: this.approvals,
      bec: this.bec,
      becTotal: this.becTotal,
    }
  }

  // Resolve raw complaint records into a register: mark external clients and
  // whether the mailbox owner replied, then summarise.
  #buildComplaints(primaryDomain) {
    const SEV_ORDER = { high: 0, medium: 1, low: 2 }
    const records = this.complaints.map((c) => {
      const dom = domainOf(c.client)
      const external = !!c.client && (!primaryDomain || dom !== primaryDomain)
      const reply = c.client ? this.sentTo.get(c.client) : undefined
      const responded = reply !== undefined && (c.date == null || reply >= c.date)
      return { ...c, external, responded }
    })
    records.sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || ((b.date || 0) - (a.date || 0)))

    const byTag = {}
    const bySeverity = { high: 0, medium: 0, low: 0 }
    const clients = new Set()
    let unanswered = 0
    for (const r of records) {
      bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1
      for (const t of r.tags) byTag[t] = (byTag[t] || 0) + 1
      if (r.client) clients.add(r.client)
      if (r.external && !r.responded) unanswered++
    }
    return {
      total: this.complaintsTotal,
      shown: records.length,
      records,
      byTag,
      bySeverity,
      uniqueClients: clients.size,
      unanswered,
    }
  }

  // Assemble an auditor's findings register, most-severe first.
  #buildAudit(complaints, primaryDomain) {
    const findings = []
    const add = (severity, category, title, detail, samples) =>
      findings.push({ severity, category, title, detail, samples: samples || [] })

    if (complaints.unanswered > 0) {
      const escalated = complaints.records.filter((r) => r.external && !r.responded && r.escalated)
      add(escalated.length ? 'high' : 'medium', 'Complaints handling',
        `${complaints.unanswered} client complaint(s) with no reply on record`,
        'Incoming complaints from external clients with no matching outbound response — potential SLA breach or unresolved dispute.',
        complaints.records.filter((r) => r.external && !r.responded).slice(0, 10)
          .map((r) => ({ ref: r.ref, messageId: r.messageId, from: r.client || r.clientName, subject: r.subject, date: r.date, folder: r.folder })))
    }
    if (this.becTotal > 0) {
      const ext = this.bec.filter((b) => !b.sent)
      add('high', 'Fraud / BEC',
        `${this.becTotal} payment or bank-detail change request(s)`,
        'Messages asking to change bank/payment details are a common business-email-compromise vector — verify each out-of-band before acting.',
        (ext.length ? ext : this.bec).slice(0, 10).map((b) => ({ ref: b.ref, messageId: b.messageId, from: b.from, subject: b.subject, date: b.date, folder: b.folder })))
    }
    if (this.nameMismatchTotal > 0) {
      add('high', 'Spoofing',
        `${this.nameMismatchTotal} sender name/address mismatch(es)`,
        'Display name embeds a different email domain than the actual sender — a spoofing / impersonation signal.',
        this.nameMismatch.slice(0, 10).map((m) => ({ ref: m.ref, messageId: m.messageId, from: m.senderEmail, subject: m.subject, date: m.date, folder: m.folder })))
    }
    if (this.sensitiveTotal > 0) {
      add('high', 'Data protection',
        `${this.sensitiveTotal} message(s) with possible sensitive data`,
        'Card / SSN / IBAN patterns detected in bodies — review handling against data-protection obligations.',
        this.sensitive.slice(0, 10))
    }
    if (this.riskyAttachmentTotal > 0) {
      add('medium', 'Security',
        `${this.riskyAttachmentTotal} risky attachment(s)`,
        'Executable, script, macro or archive attachments warrant a malware/handling review.',
        this.riskyAttachments.slice(0, 10).map((a) => ({ ref: a.ref, messageId: a.messageId, from: a.from, subject: a.name, date: a.date, folder: a.folder })))
    }
    if (this.categories.financial?.count > 0) {
      add('medium', 'Financial',
        `${this.categories.financial.count} financial message(s)`,
        'Invoices, payments and transfers referenced — sample for approval evidence and reconciliation.',
        (this.categories.financial.samples || []).slice(0, 10).map((s) => ({ ref: s.ref, messageId: s.messageId, from: s.from, subject: s.subject, date: s.date, folder: s.folder })))
    }
    if (this.folders.deleted > 0) {
      add('medium', 'Retention',
        `${this.folders.deleted} message(s) in Deleted Items`,
        'Deleted content is still present in the data file — review for records that should have been retained, or that were removed.',
        [])
    }
    // Monthly activity gaps (possible missing records / retention gap).
    const gaps = monthGaps(this.byMonth)
    if (gaps.length) {
      add('low', 'Completeness',
        `${gaps.length} month(s) with no email activity`,
        `Gaps in the timeline may indicate missing/archived data: ${gaps.slice(0, 6).join(', ')}${gaps.length > 6 ? '…' : ''}.`,
        [])
    }
    if (this.drafts > 0) {
      add('low', 'Intent',
        `${this.drafts} unsent draft(s)`,
        'Drafts were composed but never sent — may reveal intent or withheld communication.',
        [])
    }
    const afterPct = this.dated ? Math.round((this.afterHours / this.dated) * 100) : 0
    if (afterPct >= 30) {
      add('low', 'Anomaly',
        `${afterPct}% of activity is outside business hours`,
        'A high share of out-of-hours email can indicate irregular working patterns worth noting.',
        [])
    }

    const SEV_ORDER = { high: 0, medium: 1, low: 2 }
    findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
    const counts = { high: 0, medium: 0, low: 0 }
    for (const f of findings) counts[f.severity]++
    return { findings, counts }
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

// Return the 'YYYY-MM' labels between the first and last active month that
// have zero messages — a completeness/retention signal for auditors.
function monthGaps(byMonth) {
  const keys = Object.keys(byMonth).sort()
  if (keys.length < 2) return []
  const [sy, sm] = keys[0].split('-').map(Number)
  const [ey, em] = keys[keys.length - 1].split('-').map(Number)
  const gaps = []
  let y = sy
  let mo = sm
  while (y < ey || (y === ey && mo <= em)) {
    const label = `${y}-${String(mo).padStart(2, '0')}`
    if (!byMonth[label]) gaps.push(label)
    mo++
    if (mo > 12) { mo = 1; y++ }
    if (gaps.length > 240) break // safety
  }
  return gaps
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
