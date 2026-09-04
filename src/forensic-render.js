// Renders a forensic report object (from forensic.js) into HTML — used both
// for the in-app tab and the standalone downloadable report.

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

// A reference cell: exhibit id, Message-ID as tooltip, clickable to open the
// source message when it was retained.
const refCell = (x) => {
  const rf = esc(x && x.ref ? x.ref : '—')
  const title = x && x.messageId ? ` title="Message-ID: ${esc(x.messageId)}"` : ''
  if (x && x.id != null) return `<td><span class="fx-ref fx-ref-link" data-open-msg="${x.id}"${title}>${rf}</span></td>`
  return `<td><span class="fx-ref"${title}>${rf}</span></td>`
}

function auditSection(r) {
  const a = r.audit
  if (!a) return ''
  const c = a.counts
  const summary = `<p class="fx-line"><strong>${n(a.findings.length)}</strong> finding(s): ${sevBadge('high')} ${n(c.high)} &nbsp; ${sevBadge('medium')} ${n(c.medium)} &nbsp; ${sevBadge('low')} ${n(c.low)}</p>`
  if (!a.findings.length) return `<section class="fx-section"><h3>Audit findings</h3><p class="fx-muted">No audit findings were raised.</p></section>`
  const cards = a.findings.map((f) => `
    <div class="fx-finding fx-sevborder-${esc(f.severity)}">
      <div class="fx-finding-head">${sevBadge(f.severity)} <strong>${esc(f.title)}</strong> <span class="fx-muted">· ${esc(f.category)}</span></div>
      <p class="fx-finding-detail">${esc(f.detail)}</p>
      ${f.samples && f.samples.length ? `<table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Date</th><th>From</th><th>Subject</th><th>Folder</th></tr></thead><tbody>${
        f.samples.map((s) => `<tr>${refCell(s)}<td class="fx-nowrap">${esc(fmtDay(s.date))}</td><td class="fx-ellip">${esc(s.from)}</td><td>${esc(s.subject || '')}</td><td class="fx-ellip fx-muted">${esc(s.folder)}</td></tr>`).join('')
      }</tbody></table>` : ''}
    </div>`).join('')
  return `<section class="fx-section"><h3>Audit findings</h3>${summary}${cards}</section>`
}

function complaintsSection(r) {
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
    </tr>`
  }).join('')
  const more = cp.records.length > 300 ? `<p class="fx-muted">Showing 300 of ${n(cp.records.length)} complaints (all are in the export).</p>` : ''
  const summary = `<p class="fx-line"><strong>${n(cp.total)}</strong> complaint message(s) · <strong>${n(cp.uniqueClients)}</strong> client(s) · <strong class="fx-bad-text">${n(cp.unanswered)}</strong> unanswered from external clients · severity ${sevBadge('high')} ${n(cp.bySeverity.high)} ${sevBadge('medium')} ${n(cp.bySeverity.medium)} ${sevBadge('low')} ${n(cp.bySeverity.low)}</p><p class="fx-line">${tagChips}</p>`
  return `<section class="fx-section"><h3>Client complaints</h3>${summary}
    <table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Severity</th><th>Date</th><th>Client</th><th>Subject / detail</th><th>Reply</th></tr></thead><tbody>${rows}</tbody></table>${more}</section>`
}

/** Report body HTML (no outer page chrome) — for the in-app tab and the export. */
export function renderForensicReport(r) {
  const { good, bad } = assess(r)
  return `
    <div class="fx-report">
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

      ${auditSection(r)}

      ${complaintsSection(r)}

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
export function buildForensicHtmlDoc(r, fileName) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Forensic Report — ${esc(fileName)}</title>
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
  @media print { .fx-cat, .fx-finding { break-inside: avoid; } details { display: block; } details:not([open]) > *:not(summary) { display: revert; } }
</style></head><body>
  <h1>🔍 Forensic Report</h1>
  <p class="fx-sub"><strong>${esc(fileName)}</strong> · generated ${esc(new Date().toLocaleString())} · Timeless Outlook Extractor</p>
  ${renderForensicReport(r)}
  <p class="fx-sub" style="margin-top:2rem">Automated heuristic analysis — findings are indicators for a human reviewer, not conclusions. A Timeless International Product · craftedbytimeless.com</p>
</body></html>`
}
