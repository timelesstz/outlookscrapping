// Renders a forensic report object (from forensic.js) into HTML — used both
// for the in-app tab and the standalone downloadable report.
import { renderStaffView } from './clients-render.js'

const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const n = (v) => (typeof v === 'number' ? v.toLocaleString() : '0')
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—')
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString() : '—')
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Build the "good vs bad" assessment from the report. */
function assess(r) {
  const good = []
  const bad = []
  if (r.riskyAttachmentTotal > 0) bad.push(`${n(r.riskyAttachmentTotal)} risky attachment(s) (executable / script / macro / archive types).`)
  else good.push('No risky executable, script or macro attachments detected.')

  if (r.categories.security?.count > 0) bad.push(`${n(r.categories.security.count)} message(s) with security/phishing language (passwords, resets, "verify your account").`)
  else good.push('No obvious phishing or credential-request language.')

  if (r.nameMismatchTotal > 0) bad.push(`${n(r.nameMismatchTotal)} message(s) where the sender display name embeds a different email domain (spoofing signal).`)
  else good.push('No sender display-name / address domain mismatches.')

  if (r.sensitiveTotal > 0) bad.push(`${n(r.sensitiveTotal)} message(s) contain possible sensitive data (card / SSN / IBAN patterns).`)
  else if (r.deepScan) good.push('No credit-card, SSN or IBAN patterns found in bodies.')

  if (r.categories.complaints?.count > 0) bad.push(`${n(r.categories.complaints.count)} message(s) with complaint/dissatisfaction language — review for similar complaints.`)
  if (r.categories.legal?.count > 0) bad.push(`${n(r.categories.legal.count)} message(s) referencing legal action / threats / disputes.`)
  if (r.categories.hr?.count > 0) bad.push(`${n(r.categories.hr.count)} message(s) with HR / conduct language (harassment, grievance, misconduct).`)

  const afterPct = pct(r.activity.afterHours, r.dateRange.dated)
  if (afterPct >= 30) bad.push(`${afterPct}% of dated messages fall outside business hours (before 7am / after 7pm) — unusual activity pattern.`)
  else good.push(`Activity is mostly within business hours (${100 - afterPct}%).`)

  if (r.folders.deleted > 0) bad.push(`${n(r.folders.deleted)} message(s) in Deleted Items — potential removed evidence worth reviewing.`)
  if (r.drafts > 0) bad.push(`${n(r.drafts)} unsent draft(s) — may reveal intent that was never sent.`)

  if (!bad.length) good.push('No red-flag signals were raised by the automated checks.')
  return { good, bad }
}

function statGrid(r) {
  const cells = [
    ['Total messages', n(r.total)],
    ['Received', n(r.received)],
    ['Sent', n(r.sent)],
    ['Drafts', n(r.drafts)],
    ['With attachments', n(r.withAttachments)],
    ['Unread', n(r.unread)],
    ['Unique senders', n(r.uniqueSenders)],
    ['Unique recipients', n(r.uniqueRecipients)],
    ['Unique domains', n(r.uniqueDomains)],
    ['External senders', n(r.externalSenders)],
  ]
  return `<div class="fx-stats">${cells.map(([k, v]) => `<div class="fx-stat"><span class="fx-stat-v">${v}</span><span class="fx-stat-k">${esc(k)}</span></div>`).join('')}</div>`
}

function folderBreakdown(r) {
  const order = [['inbox', 'Inbox'], ['sent', 'Sent'], ['drafts', 'Drafts'], ['deleted', 'Deleted'], ['junk', 'Junk/Spam'], ['archive', 'Archive'], ['other', 'Other']]
  const max = Math.max(1, ...order.map(([k]) => r.folders[k] || 0))
  return `<table class="fx-table"><tbody>${order.map(([k, label]) => {
    const c = r.folders[k] || 0
    return `<tr><td>${esc(label)}</td><td class="num">${n(c)}</td><td class="fx-bar-cell"><span class="fx-bar" style="width:${pct(c, max)}%"></span></td></tr>`
  }).join('')}</tbody></table>`
}

function activity(r) {
  const years = Object.keys(r.activity.byYear).sort()
  const yearMax = Math.max(1, ...years.map((y) => r.activity.byYear[y]))
  const busiestHour = r.activity.byHour.indexOf(Math.max(...r.activity.byHour))
  const busiestDay = r.activity.byWeekday.indexOf(Math.max(...r.activity.byWeekday))
  return `
    <p class="fx-line"><strong>Date range:</strong> ${fmtDay(r.dateRange.min)} → ${fmtDay(r.dateRange.max)} <span class="fx-muted">(${n(r.dateRange.dated)} dated messages)</span></p>
    <p class="fx-line"><strong>Busiest hour:</strong> ${busiestHour}:00 · <strong>Busiest day:</strong> ${WEEKDAYS[busiestDay] || '—'} · <strong>After-hours:</strong> ${pct(r.activity.afterHours, r.dateRange.dated)}% · <strong>Weekend:</strong> ${pct(r.activity.weekend, r.dateRange.dated)}%</p>
    <table class="fx-table"><tbody>${years.map((y) => `<tr><td>${esc(y)}</td><td class="num">${n(r.activity.byYear[y])}</td><td class="fx-bar-cell"><span class="fx-bar" style="width:${pct(r.activity.byYear[y], yearMax)}%"></span></td></tr>`).join('')}</tbody></table>`
}

function partyTable(title, rows, unit) {
  if (!rows || !rows.length) return ''
  return `<div class="fx-col"><h4>${esc(title)}</h4><table class="fx-table"><tbody>${rows.map((x) => `<tr><td class="fx-ellip">${esc(x.email || x.domain)}</td><td class="num">${n(x.count)} ${esc(unit)}</td></tr>`).join('')}</tbody></table></div>`
}

function categorySamples(cat) {
  if (!cat.count) return `<p class="fx-muted">No matches.</p>`
  const rows = cat.samples.map((s) => `
    <tr>
      ${refCell(s)}
      <td class="fx-nowrap">${esc(fmtDay(s.date))}</td>
      <td class="fx-ellip">${esc(s.from)}</td>
      <td>${esc(s.subject || '(no subject)')}<div class="fx-snip">…matched “${esc(s.term)}”: ${esc(s.snippet)}</div></td>
      <td class="fx-ellip fx-muted">${esc(s.folder)}</td>
    </tr>`).join('')
  const more = cat.count > cat.samples.length ? `<p class="fx-muted">Showing ${n(cat.samples.length)} of ${n(cat.count)} matches.</p>` : ''
  return `<table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Date</th><th>From</th><th>Subject / match</th><th>Folder</th></tr></thead><tbody>${rows}</tbody></table>${more}`
}

function investigation(r) {
  return Object.entries(r.categories).map(([, cat]) => {
    const cls = cat.count > 0 ? 'fx-cat-hit' : 'fx-cat-none'
    return `<details class="fx-cat ${cls}"${cat.count > 0 ? ' open' : ''}>
      <summary>${esc(cat.label)} <span class="fx-badge">${n(cat.count)}</span></summary>
      ${categorySamples(cat)}
    </details>`
  }).join('')
}

function flags(r) {
  const blocks = []
  if (r.riskyAttachmentTotal > 0) {
    blocks.push(`<details class="fx-cat fx-cat-hit" open><summary>⚠ Risky attachments <span class="fx-badge">${n(r.riskyAttachmentTotal)}</span></summary>
      <table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>File</th><th>Type</th><th>From</th><th>Folder</th></tr></thead><tbody>${r.riskyAttachments.map((a) => `<tr>${refCell(a)}<td class="fx-ellip">${esc(a.name)}</td><td>.${esc(a.ext)}</td><td class="fx-ellip">${esc(a.from)}</td><td class="fx-ellip fx-muted">${esc(a.folder)}</td></tr>`).join('')}</tbody></table></details>`)
  }
  if (r.nameMismatchTotal > 0) {
    blocks.push(`<details class="fx-cat fx-cat-hit"><summary>⚠ Sender name / address mismatch <span class="fx-badge">${n(r.nameMismatchTotal)}</span></summary>
      <table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Display name</th><th>Actual address</th><th>Subject</th></tr></thead><tbody>${r.nameMismatch.map((m) => `<tr>${refCell(m)}<td class="fx-ellip">${esc(m.senderName)}</td><td class="fx-ellip">${esc(m.senderEmail)}</td><td class="fx-ellip">${esc(m.subject)}</td></tr>`).join('')}</tbody></table></details>`)
  }
  if (r.sensitiveTotal > 0) {
    blocks.push(`<details class="fx-cat fx-cat-hit"><summary>⚠ Possible sensitive data <span class="fx-badge">${n(r.sensitiveTotal)}</span></summary>
      <table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Type</th><th>From</th><th>Subject</th><th>Folder</th></tr></thead><tbody>${r.sensitive.map((s) => `<tr>${refCell(s)}<td>${esc(s.type)}</td><td class="fx-ellip">${esc(s.from)}</td><td class="fx-ellip">${esc(s.subject)}</td><td class="fx-ellip fx-muted">${esc(s.folder)}</td></tr>`).join('')}</tbody></table></details>`)
  }
  const exts = Object.entries(r.attachmentTypes).sort((a, b) => b[1] - a[1])
  if (exts.length) {
    blocks.push(`<details class="fx-cat"><summary>Attachment types <span class="fx-badge">${n(exts.length)}</span></summary>
      <table class="fx-table"><tbody>${exts.map(([ext, c]) => `<tr><td>.${esc(ext)}</td><td class="num">${n(c)}</td></tr>`).join('')}</tbody></table></details>`)
  }
  return blocks.join('') || '<p class="fx-muted">No flags raised.</p>'
}

const sevBadge = (s) => `<span class="fx-sev fx-sev-${esc(s)}">${esc(String(s).toUpperCase())}</span>`

// Auditor triage: a status + note per detection, persisted by main.js.
export const TRIAGE_TEXT = { open: 'Open', reviewed: 'Reviewed', dismissed: 'Dismissed (false positive)', escalate: 'Escalate' }
const TRIAGE_STATES = Object.keys(TRIAGE_TEXT)
function triageControl(key, opts) {
  const t = (opts.triage && opts.triage[key]) || {}
  const status = TRIAGE_TEXT[t.status] ? t.status : 'open'
  if (!opts.interactive) {
    if (status === 'open' && !t.note) return '<span class="fx-muted">—</span>'
    return `<span class="fx-triage fx-triage-${esc(status)}">${esc(TRIAGE_TEXT[status])}</span>${t.note ? `<div class="fx-snip">${esc(t.note)}</div>` : ''}`
  }
  return `<div class="fx-triage-ctl"><select class="fx-triage-sel fx-triage-${esc(status)}" data-triage="${esc(key)}">${
    TRIAGE_STATES.map((s) => `<option value="${s}"${s === status ? ' selected' : ''}>${esc(TRIAGE_TEXT[s])}</option>`).join('')
  }</select><input class="fx-triage-note" data-triage-note="${esc(key)}" placeholder="note…" value="${esc(t.note || '')}" /></div>`
}
export const findingKey = (f) => `finding:${f.category}:${f.title}`

// AI (DeepSeek) verdict on a flagged complaint, when the user has run a review.
function aiVerdictCell(ref, opts) {
  const v = opts.ai && opts.ai[ref]
  if (!v) return '<span class="fx-muted">—</span>'
  if (v.isComplaint === false) return `<span class="fx-triage fx-triage-dismissed" title="AI: not a complaint">Not a complaint</span>${v.problem ? `<div class="fx-snip">${esc(v.problem)}</div>` : ''}`
  return `<span class="fx-triage fx-triage-escalate" title="AI: confirmed complaint">${esc(String(v.severity || '').toUpperCase())} ${esc(v.type || '')}</span><div class="fx-snip">${esc(v.problem || '')}</div>${v.sentiment ? `<div class="fx-muted">${esc(v.sentiment)}</div>` : ''}`
}

// A reference cell: exhibit id, Message-ID as tooltip, clickable to open the
// source message when it was retained.
const refCell = (x) => {
  const rf = esc(x && x.ref ? x.ref : '—')
  const title = x && x.messageId ? ` title="Message-ID: ${esc(x.messageId)}"` : ''
  if (x && x.id != null) return `<td><span class="fx-ref fx-ref-link" data-open-msg="${x.id}"${title}>${rf}</span></td>`
  return `<td><span class="fx-ref"${title}>${rf}</span></td>`
}

function auditSection(r, opts = {}) {
  const a = r.audit
  if (!a) return ''
  const c = a.counts
  const summary = `<p class="fx-line"><strong>${n(a.findings.length)}</strong> finding(s): ${sevBadge('high')} ${n(c.high)} &nbsp; ${sevBadge('medium')} ${n(c.medium)} &nbsp; ${sevBadge('low')} ${n(c.low)}</p>`
  if (!a.findings.length) return `<section class="fx-section"><h3>Audit findings</h3><p class="fx-muted">No audit findings were raised.</p></section>`
  const cards = a.findings.map((f) => `
    <div class="fx-finding fx-sevborder-${esc(f.severity)}">
      <div class="fx-finding-head">${sevBadge(f.severity)} <strong>${esc(f.title)}</strong> <span class="fx-muted">· ${esc(f.category)}</span></div>
      <p class="fx-finding-detail">${esc(f.detail)}</p>
      ${triageControl(findingKey(f), opts)}
      ${f.samples && f.samples.length ? `<table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Date</th><th>From</th><th>Subject</th><th>Folder</th></tr></thead><tbody>${
        f.samples.map((s) => `<tr>${refCell(s)}<td class="fx-nowrap">${esc(fmtDay(s.date))}</td><td class="fx-ellip">${esc(s.from)}</td><td>${esc(s.subject || '')}</td><td class="fx-ellip fx-muted">${esc(s.folder)}</td></tr>`).join('')
      }</tbody></table>` : ''}
    </div>`).join('')
  return `<section class="fx-section"><h3>Audit findings</h3>${summary}${cards}</section>`
}

function complaintsSection(r, opts = {}) {
  const cp = r.complaints
  if (!cp) return ''
  if (!cp.total) return `<section class="fx-section"><h3>Client complaints</h3><p class="fx-muted">No complaint-type messages detected${r.deepScan ? '' : ' in subjects (enable Deep content scan to also search bodies)'}.</p></section>`
  const tagChips = Object.entries(cp.byTag).sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `<span class="fx-chip">${esc(t)} ${n(c)}</span>`).join(' ')
  const rows = cp.records.slice(0, 300).map((c) => {
    const status = !c.external
      ? '<span class="fx-muted">internal</span>'
      : (c.responded ? '<span class="fx-ok">answered</span>' : '<span class="fx-bad-text">no reply</span>')
    return `<tr>
      ${refCell(c)}
      <td>${sevBadge(c.severity)}</td>
      <td class="fx-nowrap">${esc(fmtDay(c.date))}</td>
      <td class="fx-ellip">${esc(c.client || c.clientName || '(unknown)')}</td>
      <td>${esc(c.subject || '(no subject)')}<div class="fx-snip">${esc(c.snippet)}</div><div class="fx-tags">${c.tags.map((t) => `<span class="fx-chip">${esc(t)}</span>`).join(' ')}</div></td>
      <td>${status}</td>
      <td>${triageControl(c.ref, opts)}</td>
      <td>${aiVerdictCell(c.ref, opts)}</td>
    </tr>`
  }).join('')
  const more = cp.records.length > 300 ? `<p class="fx-muted">Showing 300 of ${n(cp.records.length)} complaints (all are in the export).</p>` : ''
  const summary = `<p class="fx-line"><strong>${n(cp.total)}</strong> complaint message(s) · <strong>${n(cp.uniqueClients)}</strong> client(s) · <strong class="fx-bad-text">${n(cp.unanswered)}</strong> unanswered from external clients · severity ${sevBadge('high')} ${n(cp.bySeverity.high)} ${sevBadge('medium')} ${n(cp.bySeverity.medium)} ${sevBadge('low')} ${n(cp.bySeverity.low)}</p><p class="fx-line">${tagChips}</p>`
  return `<section class="fx-section"><h3>Client complaints</h3>${summary}
    <table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Severity</th><th>Date</th><th>Client</th><th>Subject / detail</th><th>Reply</th><th>Triage</th><th>AI review</th></tr></thead><tbody>${rows}</tbody></table>${more}</section>`
}

function themesSection(r) {
  const th = r.themes
  if (!th) return ''
  if (!th.total) return `<section class="fx-section"><h3>Systemic problems</h3><p class="fx-muted">No client complaints detected, so no recurring problems to report.</p></section>`
  const refs = (list) => list.slice(0, 4).map((x) => (x.id != null ? `<span class="fx-ref fx-ref-link" data-open-msg="${x.id}" title="${esc(x.client || '')}">${esc(x.ref)}</span>` : `<span class="fx-ref">${esc(x.ref)}</span>`)).join(' ')
  const maxC = Math.max(1, ...th.byType.map((t) => t.clients))
  const types = th.byType.map((t) => `<tr><td><strong>${esc(t.tag)}</strong></td><td class="num">${n(t.messages)}</td><td class="num">${n(t.clients)}</td><td class="num ${t.escalated ? 'fx-bad-text' : ''}">${n(t.escalated)}</td><td class="num">${n(t.high)}</td><td class="fx-bar-cell"><span class="fx-bar" style="width:${pct(t.clients, maxC)}%"></span></td><td>${refs(t.refs)}</td></tr>`).join('')
  const topics = th.topics.map((t) => `<tr><td><strong>${esc(t.term)}</strong></td><td class="num">${n(t.clients)}</td><td class="num">${n(t.messages)}</td><td>${refs(t.refs)}</td></tr>`).join('')
  const rec = th.recurring.map((t) => `<tr><td class="fx-ellip">${esc(t.topic)}</td><td class="num">${n(t.messages)}</td><td class="num">${n(t.clients)}</td><td>${refs(t.refs)}</td></tr>`).join('')
  return `<section class="fx-section"><h3>Systemic problems</h3>
    <p class="fx-line"><strong>${n(th.total)}</strong> client complaint(s) from <strong>${n(th.clientsWithComplaints)}</strong> client(s). What keeps coming up — ranked by how many different clients raise it.</p>
    <h4>By type</h4><table class="fx-table fx-samples"><thead><tr><th>Type</th><th>Complaints</th><th>Clients affected</th><th>Escalated</th><th>High</th><th>Reach</th><th>Examples</th></tr></thead><tbody>${types}</tbody></table>
    ${topics ? `<h4>Recurring themes</h4><table class="fx-table fx-samples"><thead><tr><th>Theme</th><th>Clients</th><th>Messages</th><th>Examples</th></tr></thead><tbody>${topics}</tbody></table>` : ''}
    ${rec ? `<h4>Subjects complained about repeatedly</h4><table class="fx-table fx-samples"><thead><tr><th>Subject</th><th>Complaints</th><th>Clients</th><th>Examples</th></tr></thead><tbody>${rec}</tbody></table>` : ''}
  </section>`
}

/** AI executive summary (stored {data, text, model, when, usage}). */
export function execSection(ex, { print = false } = {}) {
  if (!ex) return ''
  if (ex.error) return `<section class="fx-section"><div class="ai-box ai-error"><strong>AI executive summary failed:</strong> ${esc(ex.error)}</div></section>`
  const d = ex.data
  const meta = `${esc(ex.model || '')}${ex.when ? ` · ${esc(new Date(ex.when).toLocaleString())}` : ''}${ex.usage ? ` · ${n(ex.usage.total_tokens)} tokens` : ''}${d && d.confidence ? ` · confidence ${esc(d.confidence)}` : ''}`
  if (!d) return `<section class="fx-section"><div class="ai-box"><div class="ai-head"><h4>🤖 Executive summary</h4><span class="fx-muted">${meta}</span></div><pre class="ai-raw">${esc(ex.text || '')}</pre></div></section>`
  const refs = (s) => (print ? esc(s) : esc(s).replace(/\[(M\d{6})\]/g, (_, r) => `[<span class="fx-ref fx-ref-link" data-open-ref="${r}">${r}</span>]`))
  const refList = (arr) => (arr && arr.length ? ` <span class="fx-muted">${arr.map((r) => refs(`[${r}]`)).join(' ')}</span>` : '')
  const sevB = (s) => `<span class="fx-sev fx-sev-${s === 'high' || s === 'medium' ? s : 'low'}">${esc(String(s || '').toUpperCase())}</span>`
  const li = (arr, fn) => (arr && arr.length ? `<ul>${arr.map(fn).join('')}</ul>` : '<p class="fx-muted">None identified.</p>')
  return `<section class="fx-section"><div class="ai-box">
    <div class="ai-head"><h4>🤖 Executive summary</h4><span class="fx-muted">${meta}</span></div>
    <p class="ai-summary">${refs(d.overview || '')}</p>
    <h5>Systemic issues</h5>${li(d.systemicIssues, (s) => `<li>${sevB(s.severity)} <strong>${refs(s.issue || '')}</strong> — ${n(s.clientsAffected)} client(s).${refList(s.evidence)}<div class="fx-snip">→ ${refs(s.recommendation || '')}</div></li>`)}
    <div class="ai-grid">
      <div><h5>Financial exposure</h5><p>${refs(d.financialExposure?.summary || '')}</p>${d.financialExposure?.amountsAtRisk ? `<p><strong>At risk:</strong> ${esc(d.financialExposure.amountsAtRisk)}</p>` : ''}${refList(d.financialExposure?.evidence)}</div>
      <div><h5>Attention gaps</h5><p>${refs(d.attentionGaps?.summary || '')}</p>${li(d.attentionGaps?.worstCases, (w) => `<li>${refs(w)}</li>`)}${refList(d.attentionGaps?.evidence)}</div>
    </div>
    <h5>Clients to act on now</h5>${li(d.topClientsToActOn, (c) => `<li><strong>${esc(c.client || '')}</strong> — ${refs(c.why || '')}<div class="fx-snip">→ ${refs(c.action || '')}</div></li>`)}
    <h5>Recommendations</h5>${li(d.recommendations, (x) => `<li>${refs(x)}</li>`)}
  </div></section>`
}

/** Restrict complaints, financial register and trends to a period {from,to} (ms). */
export function withPeriod(r, p) {
  if (!r || !p || (!p.from && !p.to)) return r
  const inP = (d) => d != null && (!p.from || d >= p.from) && (!p.to || d <= p.to)
  const months = (r.trends?.months || []).filter((m) => {
    const [y, mo] = m.split('-').map(Number)
    const start = new Date(y, mo - 1, 1).getTime()
    const end = new Date(y, mo, 0, 23, 59, 59).getTime()
    return (!p.from || end >= p.from) && (!p.to || start <= p.to)
  })
  return {
    ...r,
    period: p,
    complaints: r.complaints ? { ...r.complaints, records: r.complaints.records.filter((c) => inP(c.date)) } : r.complaints,
    financial: r.financial ? { ...r.financial, records: r.financial.records.filter((x) => inP(x.date)) } : r.financial,
    trends: r.trends ? { ...r.trends, months } : r.trends,
  }
}
const periodLabel = (p) => `${p.from ? new Date(p.from).toLocaleDateString() : 'start'} → ${p.to ? new Date(p.to).toLocaleDateString() : 'end'}`

const money = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })
const FIN_CLS = { overdue: 'fx-sev-high', disputed: 'fx-sev-medium', unpaid: 'fx-sev-medium', paid: 'fx-sev-low', unknown: 'fx-sev-low' }
const finStatus = (s) => `<span class="fx-sev ${FIN_CLS[s] || 'fx-sev-low'}">${esc(String(s || 'unknown').toUpperCase())}</span>`

function financialSection(r) {
  const fx = r.financial
  if (!fx || !fx.total) return `<section class="fx-section"><h3>Financial register</h3><p class="fx-muted">No amounts or invoice references detected${r.deepScan ? '' : ' in subjects — enable Deep content scan to read bodies'}.</p></section>`
  const totals = Object.entries(fx.totals).sort((a, b) => b[1] - a[1]).map(([cur, v]) => `<span class="fx-chip">${esc(cur)} ${esc(money(v))}</span>`).join(' ')
  const byClient = fx.clients.slice(0, 20).map((c) => `<tr><td class="fx-ellip">${esc(c.name || c.client)}${c.name ? `<div class="fx-muted">${esc(c.client)}</div>` : ''}</td><td class="num">${n(c.records)}</td><td class="fx-nowrap">${Object.entries(c.amounts).map(([cur, v]) => `${esc(cur)} ${esc(money(v))}`).join('<br />') || '—'}</td><td class="num ${c.overdue ? 'fx-bad-text' : ''}">${n(c.overdue)}</td><td class="num ${c.disputed ? 'fx-bad-text' : ''}">${n(c.disputed)}</td><td class="num">${n(c.unpaid)}</td><td class="fx-ellip">${esc(c.invoices.slice(0, 6).join(', '))}</td></tr>`).join('')
  const rows = fx.records.slice(0, 150).map((x) => `<tr>${refCell(x)}<td class="fx-nowrap">${esc(fmtDay(x.date))}</td><td>${x.dir === 'in' ? '<span class="cl-in">IN</span>' : x.dir === 'out' ? '<span class="cl-out">OUT</span>' : ''}</td><td class="fx-ellip">${esc(x.client || x.from)}</td><td>${esc(x.subject || '(no subject)')}<div class="fx-snip">${esc(x.snippet)}</div></td><td class="fx-nowrap">${x.amounts.map((a) => `${esc(a.currency)} ${esc(money(a.value))}`).join('<br />') || '—'}</td><td class="fx-nowrap">${esc(x.invoices.join(', ')) || '—'}</td><td class="fx-nowrap">${esc(x.dueDates.join(', ')) || '—'}</td><td>${finStatus(x.status)}</td></tr>`).join('')
  return `<section class="fx-section"><h3>Financial register</h3>
    <p class="fx-line"><strong>${n(fx.total)}</strong> message(s) with money content · ${sevBadge('high')} overdue ${n(fx.overdue)} · ${sevBadge('medium')} disputed ${n(fx.disputed)} · unpaid ${n(fx.unpaid)}</p>
    <p class="fx-line">Amounts mentioned <span class="fx-muted">(sum of the largest amount per message)</span>: ${totals || '<span class="fx-muted">none</span>'}</p>
    ${byClient ? `<h4>By client</h4><table class="fx-table fx-samples"><thead><tr><th>Client</th><th>Msgs</th><th>Amounts</th><th>Overdue</th><th>Disputed</th><th>Unpaid</th><th>Invoices</th></tr></thead><tbody>${byClient}</tbody></table>` : ''}
    <h4>Register</h4><table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Date</th><th>Dir</th><th>Client</th><th>Subject</th><th>Amounts</th><th>Invoice</th><th>Due</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    ${fx.records.length > 150 ? `<p class="fx-muted">Showing 150 of ${n(fx.records.length)} — the full register is in the Excel workbook.</p>` : ''}
  </section>`
}

function trendsSection(r) {
  const t = r.trends
  if (!t || !t.months || !t.months.length) return ''
  const max = Math.max(1, ...t.months.map((m) => (t.inbound[m] || 0) + (t.outbound[m] || 0)))
  const rows = t.months.map((m) => `<tr><td class="fx-nowrap">${esc(m)}</td><td class="num">${n(t.inbound[m] || 0)}</td><td class="num">${n(t.outbound[m] || 0)}</td><td class="num ${t.complaints[m] ? 'fx-bad-text' : ''}">${n(t.complaints[m] || 0)}</td><td class="num">${hrs(t.medianResponseHours[m])}</td><td class="fx-bar-cell"><span class="fx-bar" style="width:${pct((t.inbound[m] || 0) + (t.outbound[m] || 0), max)}%"></span></td></tr>`).join('')
  return `<section class="fx-section"><h3>Trends by month</h3><table class="fx-table"><thead><tr><th>Month</th><th>From clients</th><th>To clients</th><th>Complaints</th><th>Median response</th><th>Volume</th></tr></thead><tbody>${rows}</tbody></table></section>`
}

const LBL = { critical: 'Critical', 'at-risk': 'At risk', watch: 'Watch', healthy: 'Healthy' }
const lblBadge = (l) => `<span class="fx-lbl fx-lbl-${esc(l)}">${esc(LBL[l] || l)}</span>`
const hrs = (h) => (h == null ? '—' : h < 48 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} d`)

function clientsSection(r) {
  const cl = r.clients
  if (!cl) return ''
  if (!cl.total) return `<section class="fx-section"><h3>Clients</h3><p class="fx-muted">No external clients identified.</p></section>`
  const top = cl.list.slice(0, 25)
  const rows = top.map((c) => `<tr>
      <td>${lblBadge(c.label)} <span class="fx-muted">${c.score}</span></td>
      <td>${esc(c.name || c.email)}${c.name ? `<div class="fx-muted">${esc(c.email)}</div>` : ''}</td>
      <td class="fx-ellip">${esc(c.domain)}</td>
      <td class="num">${n(c.inbound)} / ${n(c.outbound)}</td>
      <td class="num">${c.complaints.high + c.complaints.medium + c.complaints.low ? `${c.complaints.high}/${c.complaints.medium}/${c.complaints.low}` : '—'}</td>
      <td class="num">${n(c.financial)}${c.bec ? ` <span class="fx-sev fx-sev-high">BEC ${n(c.bec)}</span>` : ''}</td>
      <td class="num">${n(c.unanswered)}</td>
      <td class="num">${hrs(c.medianResponseHours)}</td>
      <td class="fx-nowrap">${fmtDay(c.lastIn)}</td>
    </tr>`).join('')
  return `<section class="fx-section"><h3>Clients needing attention</h3>
    <p class="fx-line"><strong>${n(cl.total)}</strong> external client(s) · <strong class="fx-bad-text">${n(cl.atRisk)}</strong> need attention · <strong>${n(cl.unansweredTotal)}</strong> unanswered message(s) · median response <strong>${hrs(cl.medianResponseHours)}</strong></p>
    <table class="fx-table fx-samples"><thead><tr><th>Attention</th><th>Client</th><th>Company</th><th>In / Out</th><th>Complaints H/M/L</th><th>Financial</th><th>Unanswered</th><th>Response</th><th>Last contact</th></tr></thead><tbody>${rows}</tbody></table>
    ${cl.total > top.length ? `<p class="fx-muted">Top ${top.length} of ${n(cl.total)} — the full list is in the Clients tab and the Excel workbook.</p>` : ''}
  </section>`
}

/** Report body HTML (no outer page chrome) — for the in-app tab and the export. */
export function renderForensicReport(r0, opts = {}) {
  const r = withPeriod(r0, opts.period)
  const { good, bad } = assess(r)
  return `
    <div class="fx-report">
      ${r.period ? `<p class="notice"><strong>Period filter:</strong> ${esc(periodLabel(r.period))} — complaints, financial register and trends below are limited to this period; clients, audit findings and totals cover the whole mailbox.</p>` : ''}
      <div class="fx-verdict">
        <div class="fx-verdict-col fx-good">
          <h3>✓ Looks normal</h3>
          <ul>${good.map((g) => `<li>${esc(g)}</li>`).join('') || '<li>—</li>'}</ul>
        </div>
        <div class="fx-verdict-col fx-bad">
          <h3>⚠ Needs review</h3>
          <ul>${bad.map((b) => `<li>${esc(b)}</li>`).join('') || '<li>Nothing flagged.</li>'}</ul>
        </div>
      </div>

      ${execSection(opts.exec, { print: !opts.interactive })}

      ${auditSection(r, opts)}

      ${themesSection(r)}

      ${clientsSection(r)}

      ${renderStaffView(r.staff)}

      ${financialSection(r)}

      ${trendsSection(r)}

      ${complaintsSection(r, opts)}

      <section class="fx-section"><h3>Overview</h3>${statGrid(r)}</section>

      <section class="fx-section fx-2col">
        <div class="fx-col"><h4>Folder breakdown</h4>${folderBreakdown(r)}</div>
        <div class="fx-col"><h4>Activity</h4>${activity(r)}</div>
      </section>

      <section class="fx-section fx-3col">
        ${partyTable('Top senders', r.topSenders, 'sent')}
        ${partyTable('Top recipients', r.topRecipients, 'recv')}
        ${partyTable('Top domains', r.topDomains, 'msgs')}
      </section>

      <section class="fx-section"><h3>Investigation ${r.deepScan ? '<span class="fx-muted">(subjects + bodies)</span>' : '<span class="fx-muted">(subjects only — enable Deep content scan for bodies)</span>'}</h3>${investigation(r)}</section>

      <section class="fx-section"><h3>Red flags</h3>${flags(r)}</section>
    </div>`
}

/** Full standalone HTML document for download (light, print-friendly). */
export function buildForensicHtmlDoc(r, fileName, opts = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(opts.title || 'Forensic Report')} — ${esc(fileName)}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #1a1a22; background: #fff; max-width: 1000px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  h3 { border-bottom: 2px solid #c2102e; padding-bottom: 0.3rem; margin-top: 2rem; color: #c2102e; }
  h4 { margin: 0 0 0.4rem; }
  .fx-sub { color: #666; margin: 0 0 1.5rem; font-size: 0.9rem; }
  .fx-verdict { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem; }
  .fx-verdict-col { border: 1px solid #ddd; border-radius: 8px; padding: 0.75rem 1rem; }
  .fx-good { background: #f0fbf5; border-color: #b7e4c7; }
  .fx-bad { background: #fff5f5; border-color: #f3b7c0; }
  .fx-verdict-col h3 { border: none; margin: 0 0 0.4rem; padding: 0; font-size: 1rem; }
  .fx-good h3 { color: #1a7f4b; } .fx-bad h3 { color: #c2102e; }
  .fx-verdict-col ul { margin: 0; padding-left: 1.2rem; } .fx-verdict-col li { margin: 0.25rem 0; }
  .fx-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 0.5rem; }
  .fx-stat { border: 1px solid #e3e3e8; border-radius: 8px; padding: 0.6rem; text-align: center; }
  .fx-stat-v { display: block; font-size: 1.4rem; font-weight: 700; color: #c2102e; }
  .fx-stat-k { font-size: 0.78rem; color: #666; }
  .fx-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  .fx-3col { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.5rem; }
  table.fx-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .fx-table td, .fx-table th { padding: 0.3rem 0.5rem; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
  .fx-table th { color: #666; }
  .num { text-align: right; white-space: nowrap; }
  .fx-bar-cell { width: 40%; } .fx-bar { display: inline-block; height: 9px; background: #c2102e; border-radius: 4px; }
  .fx-ellip { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fx-muted { color: #888; } .fx-nowrap { white-space: nowrap; }
  .fx-snip { color: #555; font-size: 0.8rem; margin-top: 0.15rem; }
  .fx-cat { border: 1px solid #e3e3e8; border-radius: 8px; margin: 0.5rem 0; padding: 0.4rem 0.75rem; }
  .fx-cat-hit { border-color: #f3b7c0; background: #fff8f8; }
  .fx-cat summary { cursor: pointer; font-weight: 600; }
  .fx-badge { display: inline-block; background: #c2102e; color: #fff; border-radius: 999px; padding: 0 0.5rem; font-size: 0.78rem; margin-left: 0.35rem; }
  .fx-cat-none .fx-badge { background: #9aa; }
  .fx-sev { display: inline-block; border-radius: 4px; padding: 0 0.4rem; font-size: 0.7rem; font-weight: 700; color: #fff; }
  .fx-sev-high { background: #c2102e; } .fx-sev-medium { background: #d97706; } .fx-sev-low { background: #6b7280; }
  .fx-finding { border: 1px solid #e3e3e8; border-left: 4px solid #ccc; border-radius: 6px; padding: 0.6rem 0.85rem; margin: 0.5rem 0; }
  .fx-sevborder-high { border-left-color: #c2102e; } .fx-sevborder-medium { border-left-color: #d97706; } .fx-sevborder-low { border-left-color: #6b7280; }
  .fx-finding-head { margin-bottom: 0.2rem; } .fx-finding-detail { margin: 0.15rem 0 0.4rem; color: #444; font-size: 0.88rem; }
  .fx-chip { display: inline-block; background: #eee; border-radius: 999px; padding: 0 0.5rem; font-size: 0.72rem; color: #444; }
  .fx-tags { margin-top: 0.2rem; } .fx-ok { color: #1a7f4b; font-weight: 600; } .fx-bad-text { color: #c2102e; font-weight: 600; }
  .fx-ref { font-family: 'Consolas', monospace; font-size: 0.76rem; color: #555; white-space: nowrap; }
  .fx-triage { display: inline-block; border-radius: 4px; padding: 0 0.4rem; font-size: 0.72rem; font-weight: 700; border: 1px solid #ddd; }
  .ai-box { border: 1px solid #e3e3e8; border-left: 4px solid #6d28d9; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.75rem 0; background: #faf8ff; }
  .ai-box h4, .ai-box h5 { margin: 0.4rem 0 0.3rem; color: #4c1d95; } .ai-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; } .ai-summary { font-size: 0.95rem; }
  .fx-triage-reviewed { color: #1a7f4b; } .fx-triage-dismissed { color: #888; } .fx-triage-escalate { color: #c2102e; }
  .fx-lbl { display: inline-block; border-radius: 4px; padding: 0.05rem 0.45rem; font-size: 0.7rem; font-weight: 700; }
  .fx-lbl-healthy { background: #e6f7ee; color: #1a7f4b; } .fx-lbl-watch { background: #fff3d6; color: #9a5b00; }
  .fx-lbl-at-risk { background: #ffe3d6; color: #b3410a; } .fx-lbl-critical { background: #c2102e; color: #fff; }
  .case-file h3 { border: none; margin-top: 0.5rem; } .case-file h4 { color: #c2102e; margin-top: 1.2rem; }
  .case-problems { padding-left: 1.2rem; } .case-problems li { margin: 0.25rem 0; }
  .cl-in { color: #9a5b00; font-weight: 700; } .cl-out { color: #1a7f4b; font-weight: 700; }
  @media print { .fx-cat, .fx-finding { break-inside: avoid; } details { display: block; } details:not([open]) > *:not(summary) { display: revert; } }
</style></head><body>
  <h1>${esc(opts.title || '🔍 Forensic Report')}</h1>
  <p class="fx-sub"><strong>${esc(fileName)}</strong> · generated ${esc(new Date().toLocaleString())} · Timeless Outlook Extractor</p>
  ${opts.body != null ? opts.body : renderForensicReport(r, { triage: opts.triage, ai: opts.ai, exec: opts.exec, period: opts.period })}
  <p class="fx-sub" style="margin-top:2rem">Automated heuristic analysis — findings are indicators for a human reviewer, not conclusions. A Timeless International Product · craftedbytimeless.com</p>
</body></html>`
}
