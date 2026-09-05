// Renders the Clients tab: an attention-ranked client list, a domain
// (organisation) roll-up, and a per-client case file. Pure HTML strings —
// main.js owns state and click handling.

const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const n = (v) => (typeof v === 'number' ? v.toLocaleString() : '0')
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString() : '—')
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—')
const hrs = (h) => (h == null ? '—' : h < 48 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} d`)

const LABEL_TEXT = { critical: 'Critical', 'at-risk': 'At risk', watch: 'Watch', healthy: 'Healthy' }
export const labelBadge = (l) => `<span class="fx-lbl fx-lbl-${esc(l)}">${esc(LABEL_TEXT[l] || l)}</span>`
const sev = (s, v) => (v ? `<span class="fx-sev fx-sev-${s}" title="${s} severity complaints">${n(v)}</span> ` : '')
const refSpan = (x) => {
  const title = x.messageId ? ` title="Message-ID: ${esc(x.messageId)}"` : ''
  return x.id != null
    ? `<span class="fx-ref fx-ref-link" data-open-msg="${x.id}"${title}>${esc(x.ref || '—')}</span>`
    : `<span class="fx-ref"${title}>${esc(x.ref || '—')}</span>`
}

function complaintCell(c) {
  const total = c.complaints.high + c.complaints.medium + c.complaints.low
  if (!total) return '<span class="fx-muted">—</span>'
  const tags = Object.entries(c.complaintTags || {}).sort((a, b) => b[1] - a[1]).map(([t, k]) => `${t} ${k}`).join(', ')
  return `<span title="${esc(tags)}">${sev('high', c.complaints.high)}${sev('medium', c.complaints.medium)}${sev('low', c.complaints.low)}</span>`
}

export function filterClients(list, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return list
  return list.filter((c) => `${c.email} ${c.name} ${c.domain}`.toLowerCase().includes(q))
}

export function renderClientsView(clients, { query = '' } = {}) {
  if (!clients || !clients.total) {
    return `<p class="notice">No external clients were identified. Clients are senders/recipients outside the mailbox owner's domain — make sure the file contains client correspondence and that the <strong>Forensic report</strong> option was ticked.</p>`
  }
  const list = filterClients(clients.list, query)
  const stats = [
    ['Clients', n(clients.total)],
    ['Need attention', n(clients.atRisk)],
    ['Unanswered messages', n(clients.unansweredTotal)],
    ['Median response', hrs(clients.medianResponseHours)],
  ]
  const summary = `<div class="fx-stats cl-stats">${stats.map(([k, v]) => `<div class="fx-stat"><span class="fx-stat-v">${v}</span><span class="fx-stat-k">${esc(k)}</span></div>`).join('')}</div>
    ${clients.threadsCapped ? '<p class="notice">Very large mailbox: conversation tracking was capped, so some "unanswered" counts fall back to a simpler heuristic.</p>' : ''}
    <p class="fx-muted cl-hint">Ranked by <strong>attention score</strong> — unanswered mail, complaint severity, escalation, and financial/fraud signals. Click a client for their case file.</p>`

  const rows = list.slice(0, 500).map((c) => `
    <tr class="cl-row" data-client="${esc(c.email)}" title="Open case file">
      <td>${labelBadge(c.label)}<div class="cl-score" title="attention score ${c.score}/100"><span style="width:${c.score}%"></span></div></td>
      <td><div class="cl-name">${esc(c.name || c.email)}</div>${c.name ? `<div class="fx-muted cl-email">${esc(c.email)}</div>` : ''}</td>
      <td class="fx-ellip">${esc(c.domain)}</td>
      <td class="num">${n(c.inbound)} / ${n(c.outbound)}</td>
      <td class="num">${complaintCell(c)}</td>
      <td class="num">${n(c.financial)}${c.bec ? ` <span class="fx-sev fx-sev-high" title="payment / bank-detail change request">BEC ${n(c.bec)}</span>` : ''}${c.legal ? ` <span class="fx-sev fx-sev-medium" title="legal / threat language">LEGAL ${n(c.legal)}</span>` : ''}</td>
      <td class="num ${c.unanswered ? 'fx-bad-text' : ''}">${n(c.unanswered)}</td>
      <td class="num">${hrs(c.medianResponseHours)}</td>
      <td class="fx-nowrap">${fmtDay(c.lastIn)}${c.waiting ? ' <span class="fx-bad-text" title="client’s last message has no reply">⏳</span>' : ''}</td>
    </tr>`).join('')

  const domainRows = clients.domains.slice(0, 200).map((d) => `
    <tr class="cl-row" data-domain="${esc(d.domain)}" title="Filter to this organisation">
      <td>${labelBadge(d.label)}</td>
      <td>${esc(d.domain)}</td>
      <td class="num">${n(d.contacts)}</td>
      <td class="num">${n(d.inbound)} / ${n(d.outbound)}</td>
      <td class="num">${n(d.complaints)}${d.escalated ? ` <span class="fx-sev fx-sev-high" title="escalated">${n(d.escalated)}</span>` : ''}</td>
      <td class="num">${n(d.financial)}${d.bec ? ` <span class="fx-sev fx-sev-high">BEC ${n(d.bec)}</span>` : ''}</td>
      <td class="num ${d.unanswered ? 'fx-bad-text' : ''}">${n(d.unanswered)}</td>
      <td class="fx-nowrap">${fmtDay(d.lastIn)}</td>
    </tr>`).join('')

  return `
    ${summary}
    <section class="fx-section"><h3>Clients by attention needed <span class="fx-muted">(${n(list.length)}${query ? ' matching' : ''})</span></h3>
      <div class="table-wrap cl-wrap"><table class="fx-table cl-table">
        <thead><tr><th>Attention</th><th>Client</th><th>Company</th><th>In / Out</th><th>Complaints</th><th>Financial</th><th>Unanswered</th><th>Response</th><th>Last contact</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="9" class="fx-muted">No clients match.</td></tr>'}</tbody>
      </table></div>
      ${list.length > 500 ? `<p class="fx-muted">Showing 500 of ${n(list.length)} — use the search box, or export all to Excel.</p>` : ''}
    </section>
    <section class="fx-section"><h3>By organisation</h3>
      <div class="table-wrap cl-wrap"><table class="fx-table cl-table">
        <thead><tr><th>Attention</th><th>Domain</th><th>Contacts</th><th>In / Out</th><th>Complaints</th><th>Financial</th><th>Unanswered</th><th>Last contact</th></tr></thead>
        <tbody>${domainRows}</tbody>
      </table></div>
    </section>`
}

const TYPE_TEXT = { complaint: 'Complaint', financial: 'Financial', legal: 'Legal', bec: 'Payment/bank change' }

/** Render a stored AI deep-dive result ({data, text, usage, model, when} or {error}). */
export function renderAiDive(ai, { print = false } = {}) {
  if (!ai) return ''
  if (ai.error) return `<div class="ai-box ai-error"><strong>AI deep dive failed:</strong> ${esc(ai.error)}</div>`
  const d = ai.data
  const meta = `${esc(ai.model || '')}${ai.when ? ` · ${esc(new Date(ai.when).toLocaleString())}` : ''}${ai.messagesSent ? ` · ${n(ai.messagesSent)} emails sent` : ''}${ai.usage ? ` · ${n(ai.usage.total_tokens)} tokens` : ''}`
  if (!d) return `<div class="ai-box"><div class="ai-head"><h4>🤖 AI deep dive</h4><span class="fx-muted">${meta}</span></div><pre class="ai-raw">${esc(ai.text || '')}</pre></div>`
  const refs = (s) => (print ? esc(s) : esc(s).replace(/\[(M\d{6})\]/g, (_, r) => `[<span class="fx-ref fx-ref-link" data-open-ref="${r}">${r}</span>]`))
  const li = (arr, fn) => (arr && arr.length ? `<ul>${arr.map(fn).join('')}</ul>` : '<p class="fx-muted">None identified.</p>')
  const sevB = (s) => { const k = s === 'high' || s === 'medium' || s === 'low' ? s : 'low'; return `<span class="fx-sev fx-sev-${k}">${esc(String(s || '').toUpperCase())}</span>` }
  const att = d.attention || {}
  return `<div class="ai-box">
    <div class="ai-head"><h4>🤖 AI deep dive</h4><span class="fx-muted">${meta}</span></div>
    <p class="ai-summary">${refs(d.summary || '')}</p>
    <div class="ai-grid">
      <div><h5>Problems</h5>${li(d.problems, (p) => `<li>${sevB(p.severity)} <strong>${esc(p.type || '')}</strong> — ${refs(p.issue || '')} ${p.ref ? refs(`[${p.ref}]`) : ''}</li>`)}</div>
      <div><h5>Financial</h5>${li(d.financial, (f) => `<li><strong>${esc(f.status || '')}</strong>${f.amount ? ` · <strong>${esc(f.amount)}</strong>` : ''} — ${refs(f.detail || '')} ${f.ref ? refs(`[${f.ref}]`) : ''}</li>`)}</div>
    </div>
    <div class="ai-grid">
      <div><h5>Attention</h5><p>${refs(att.assessment || '')}</p><p class="fx-muted">Response quality: <strong>${esc(att.responseQuality || '—')}</strong>${att.unansweredRefs && att.unansweredRefs.length ? ` · unanswered: ${att.unansweredRefs.map((r) => refs(`[${r}]`)).join(' ')}` : ''}</p></div>
      <div><h5>Risk</h5><p>${sevB(d.risk)} · sentiment: <strong>${esc(d.sentiment || '—')}</strong></p><p>${refs(d.riskReason || '')}</p></div>
    </div>
    <h5>Recommended next actions</h5>${li(d.nextActions, (a) => `<li>${refs(a)}</li>`)}
  </div>`
}

/** Case file for one client. timeline: [{id, ref, dir, date, subject, folder, from, to, hasAttachments}] */
export function renderCaseFile(c, timeline, complaints, { print = false, ai = null } = {}) {
  const total = c.complaints.high + c.complaints.medium + c.complaints.low
  const stats = [
    ['Attention score', `${c.score}/100`], ['Messages in / out', `${n(c.inbound)} / ${n(c.outbound)}`],
    ['Answered / unanswered', `${n(c.answered)} / ${n(c.unanswered)}`], ['Median response', hrs(c.medianResponseHours)],
    ['Complaints (H/M/L)', `${c.complaints.high}/${c.complaints.medium}/${c.complaints.low}`], ['Escalated', n(c.escalated)],
    ['Financial msgs', n(c.financial)], ['Payment-change (BEC)', n(c.bec)],
    ['First contact', fmtDay(c.firstIn)], ['Last from client', fmtDay(c.lastIn)], ['Last reply to client', fmtDay(c.lastOut)],
  ]
  const tags = Object.entries(c.complaintTags || {}).sort((a, b) => b[1] - a[1]).map(([t, k]) => `<span class="fx-chip">${esc(t)} ${n(k)}</span>`).join(' ')

  const problems = []
  if (c.unanswered) problems.push(`${n(c.unanswered)} message(s) from this client were never answered in their thread.`)
  if (c.waiting) problems.push('Their most recent message has had no reply.')
  if (c.complaints.high) problems.push(`${n(c.complaints.high)} high-severity complaint(s)${c.escalated ? `, ${n(c.escalated)} escalated` : ''}.`)
  if (total && !c.complaints.high) problems.push(`${n(total)} complaint(s) (${Object.keys(c.complaintTags || {}).join(', ') || 'general'}).`)
  if (c.bec) problems.push(`${n(c.bec)} request(s) to change payment or bank details — verify out-of-band before paying.`)
  if (c.financial) problems.push(`${n(c.financial)} message(s) about invoices, payments or balances.`)
  if (c.legal) problems.push(`${n(c.legal)} message(s) with legal / dispute language.`)
  if (!problems.length) problems.push('No problems detected — relationship looks healthy.')

  const notable = (c.refs || []).map((r) => `<tr>${print ? `<td class="fx-ref">${esc(r.ref)}</td>` : `<td>${refSpan(r)}</td>`}<td>${esc(TYPE_TEXT[r.type] || r.type)}</td><td class="fx-nowrap">${esc(fmtDay(r.date))}</td><td>${esc(r.subject || '(no subject)')}</td></tr>`).join('')

  const compRows = complaints.map((x) => `<tr>${print ? `<td class="fx-ref">${esc(x.ref)}</td>` : `<td>${refSpan(x)}</td>`}<td><span class="fx-sev fx-sev-${esc(x.severity)}">${esc(x.severity.toUpperCase())}</span></td><td class="fx-nowrap">${esc(fmtDay(x.date))}</td><td>${esc(x.subject || '(no subject)')}<div class="fx-snip">${esc(x.snippet)}</div><div class="fx-tags">${x.tags.map((t) => `<span class="fx-chip">${esc(t)}</span>`).join(' ')}</div></td><td>${x.responded ? '<span class="fx-ok">answered</span>' : '<span class="fx-bad-text">no reply</span>'}</td></tr>`).join('')

  const tlRows = timeline.map((m) => `<tr>${print ? `<td class="fx-ref">${esc(m.ref || '')}</td>` : `<td>${refSpan(m)}</td>`}<td>${m.dir === 'in' ? '<span class="cl-in">⬇ IN</span>' : '<span class="cl-out">⬆ OUT</span>'}</td><td class="fx-nowrap">${esc(fmtDate(m.date))}</td><td>${esc(m.subject || '(no subject)')}${m.hasAttachments ? ' 📎' : ''}</td><td class="fx-ellip fx-muted">${esc(m.folder)}</td></tr>`).join('')

  return `<div class="case-file">
    ${print ? '' : '<button id="case-back" class="btn btn-secondary">← All clients</button> <button id="case-ai" class="btn" title="Send this client’s emails to DeepSeek for a written investigation">🤖 AI deep dive</button>'}
    <div class="case-head">
      <div><h3 class="case-title">${esc(c.name || c.email)} ${labelBadge(c.label)}</h3><p class="fx-muted">${esc(c.email)} · ${esc(c.domain)}</p></div>
    </div>
    <div class="fx-stats">${stats.map(([k, v]) => `<div class="fx-stat"><span class="fx-stat-v cl-stat-v">${esc(v)}</span><span class="fx-stat-k">${esc(k)}</span></div>`).join('')}</div>
    <section class="fx-section"><h4>What’s going on with this client</h4><ul class="case-problems">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>${tags ? `<p class="fx-line">${tags}</p>` : ''}</section>
    <div id="case-ai-out">${ai ? renderAiDive(ai, { print }) : ''}</div>
    ${notable ? `<section class="fx-section"><h4>Notable items <span class="fx-muted">(${n(c.refs.length)})</span></h4><table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Type</th><th>Date</th><th>Subject</th></tr></thead><tbody>${notable}</tbody></table></section>` : ''}
    ${complaints.length ? `<section class="fx-section"><h4>Complaints <span class="fx-muted">(${n(complaints.length)})</span></h4><table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Severity</th><th>Date</th><th>Subject / detail</th><th>Reply</th></tr></thead><tbody>${compRows}</tbody></table></section>` : ''}
    <section class="fx-section"><h4>Timeline <span class="fx-muted">(${n(timeline.length)} message${timeline.length === 1 ? '' : 's'}${timeline.length ? '' : ' — tick “Messages” when loading to include the full timeline'})</span></h4>
      ${timeline.length ? `<table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Dir</th><th>Date</th><th>Subject</th><th>Folder</th></tr></thead><tbody>${tlRows}</tbody></table>` : ''}
    </section>
  </div>`
}
