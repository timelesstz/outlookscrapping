// Opt-in AI "deep dive" layer using the user's own DeepSeek API key, called
// directly from the browser (no server). Only the specific emails involved in
// a request are sent — a client's thread, the flagged complaints, or the
// emails matching a question — never the whole mailbox.

const KEY_STORE = 'tox-ai-key'
const SETTINGS_STORE = 'tox-ai-settings'
const DEFAULTS = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxMessages: 30 }

let sessionKey = ''
/** Hold an unlocked key in memory only (not remembered on this device). */
export function setSessionKey(k) { sessionKey = k || '' }
function readKey() {
  if (sessionKey) return sessionKey
  try { return localStorage.getItem(KEY_STORE) || '' } catch { return '' }
}

export function getAiSettings() {
  let s = {}
  try { s = JSON.parse(localStorage.getItem(SETTINGS_STORE) || '{}') || {} } catch { /* none */ }
  let storedKey = ''
  try { storedKey = localStorage.getItem(KEY_STORE) || '' } catch { /* none */ }
  return { ...DEFAULTS, ...s, key: readKey(), storedKey }
}

export function saveAiSettings({ key, baseUrl, model, maxMessages } = {}) {
  try {
    const cur = getAiSettings()
    if (key != null) localStorage.setItem(KEY_STORE, key)
    localStorage.setItem(SETTINGS_STORE, JSON.stringify({
      baseUrl: (baseUrl || cur.baseUrl || DEFAULTS.baseUrl).trim(),
      model: model || cur.model || DEFAULTS.model,
      maxMessages: Math.min(80, Math.max(5, Number(maxMessages) || cur.maxMessages || DEFAULTS.maxMessages)),
    }))
  } catch { /* storage unavailable */ }
}

export function clearAiKey() { try { localStorage.removeItem(KEY_STORE) } catch { /* ignore */ } }
export function aiEnabled() { return !!readKey() }

const SYSTEM = 'You are a meticulous email-investigation assistant helping an auditor review a company\'s correspondence with its clients. Be factual and specific. Cite the message reference in square brackets (e.g. [M000123]) for every claim that comes from an email. Never invent facts, amounts or dates; if something is unclear, say so. Quote money amounts exactly as written in the emails.'

/** Call DeepSeek's OpenAI-compatible chat endpoint. Returns { data, text, usage }. */
export async function deepseekChat(userContent, { json = true, temperature = 0.2, maxTokens = 2500 } = {}) {
  const s = getAiSettings()
  if (!s.key) throw new Error('No DeepSeek API key set — open 🤖 AI settings first.')
  const isReasoner = /reasoner/i.test(s.model)
  const body = {
    model: s.model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userContent }],
    max_tokens: maxTokens,
  }
  if (!isReasoner) {
    body.temperature = temperature
    if (json) body.response_format = { type: 'json_object' }
  }
  let res
  try {
    res = await fetch(`${s.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.key}` },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`Could not reach the DeepSeek API from the browser (${err.message}). If your browser blocked the call (CORS), enter a proxy URL as the API base URL in 🤖 AI settings.`)
  }
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json()).error?.message || '' } catch { /* no body */ }
    if (res.status === 401) throw new Error('DeepSeek rejected the API key (401). Check it in 🤖 AI settings.')
    if (res.status === 402) throw new Error('DeepSeek reports insufficient balance (402). Top up your DeepSeek account.')
    if (res.status === 429) throw new Error('DeepSeek rate limit reached (429). Wait a moment and try again.')
    throw new Error(`DeepSeek API error ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content || ''
  const usage = data.usage || null
  if (!json) return { text: content, usage }
  return { data: parseJson(content), text: content, usage }
}

function parseJson(text) {
  const t = String(text || '').trim()
  try { return JSON.parse(t) } catch { /* try fences */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) { try { return JSON.parse(fence[1]) } catch { /* fallthrough */ } }
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)) } catch { /* give up */ } }
  return null
}

// --- compact, referenced context builders -----------------------------------
export function textOf(detail) {
  let text = (detail && detail.body) || ''
  if (!text && detail && detail.bodyHTML) {
    text = detail.bodyHTML.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  }
  return text.replace(/\s+/g, ' ').trim()
}
export function clip(text, max) { return text.length > max ? text.slice(0, max) + ' …[truncated]' : text }
const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : 'undated')

/** messages: [{ref, dir, date, subject, from, text}] */
export function formatMessages(messages, { perMessage = 1500, total = 40000 } = {}) {
  const out = []
  let used = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const dir = m.dir === 'in' ? 'IN (from client)' : m.dir === 'out' ? 'OUT (our reply)' : ''
    const block = `[${m.ref || '—'}] ${when(m.date)} ${dir} From: ${m.from || ''}\nSubject: ${m.subject || '(no subject)'}\n${clip(m.text || '', perMessage)}\n---`
    if (used + block.length > total) { out.push(`…[${messages.length - i} more messages omitted for size]`); break }
    out.push(block)
    used += block.length
  }
  return out.join('\n')
}

export function deepDivePrompt(client, messages, complaints, financial = []) {
  const fin = financial.slice(0, 40).map((r) => `[${r.ref}] ${when(r.date)} ${r.dir === 'in' ? 'from client' : 'to client'} — ${r.status} — ${r.amounts.map((a) => `${a.currency} ${a.value}`).join(', ') || 'no amount'}${r.invoices.length ? ` — invoice ${r.invoices.join(', ')}` : ''}${r.dueDates.length ? ` — due ${r.dueDates.join(', ')}` : ''} — ${r.subject}`).join('\n') || '(none extracted)'
  const flagged = complaints.map((c) => `[${c.ref}] ${when(c.date)} ${c.severity.toUpperCase()} ${c.tags.join('/')} — ${c.subject} — ${c.snippet}`).join('\n') || '(none flagged)'
  return `CLIENT: ${client.name || ''} <${client.email}> (${client.domain})
STATS: ${client.inbound} messages from client, ${client.outbound} replies to client, ${client.unanswered} unanswered in thread, median response ${client.medianResponseHours ?? 'unknown'} hours, complaints H/M/L ${client.complaints.high}/${client.complaints.medium}/${client.complaints.low}, financial messages ${client.financial}, payment-change requests ${client.bec}.

KEYWORD-FLAGGED COMPLAINTS (may include false positives):
${flagged}

FINANCIAL ITEMS EXTRACTED BY KEYWORD (verify against the emails):
${fin}

CORRESPONDENCE (chronological):
${formatMessages(messages)}

TASK: Investigate this client relationship. Respond with a JSON object with exactly these keys:
"summary": string (3-6 sentences: who they are, what the relationship is about, what is going on now),
"problems": array of {"ref": string, "issue": string, "type": "billing|delay|quality|service|cancellation|legal|other", "severity": "low|medium|high"},
"financial": array of {"ref": string, "detail": string, "amount": string|null, "status": "unpaid|disputed|paid|unknown"},
"attention": {"assessment": string, "unansweredRefs": array of refs, "responseQuality": "poor|fair|good"},
"sentiment": "angry|frustrated|neutral|satisfied",
"risk": "low|medium|high", "riskReason": string,
"nextActions": array of strings (concrete, prioritised).
Use only refs that appear above. Respond with JSON only.`
}

export function executiveSummaryPrompt(r, complaints, opts = {}) {
  const n = (v) => (typeof v === 'number' ? v : 0)
  const top = (r.clients?.list || []).slice(0, 12).map((c) => `- ${c.name || c.email} <${c.email}> (${c.domain}): ${c.label}, score ${c.score}, ${n(c.inbound)} in / ${n(c.outbound)} out, unanswered ${n(c.unanswered)}, complaints H/M/L ${c.complaints.high}/${c.complaints.medium}/${c.complaints.low}, escalated ${n(c.escalated)}, financial ${n(c.financial)}, BEC ${n(c.bec)}`).join('\n') || '(none)'
  const byType = (r.themes?.byType || []).map((t) => `- ${t.tag}: ${t.messages} complaint(s) across ${t.clients} client(s), ${t.escalated} escalated`).join('\n') || '(none)'
  const topics = (r.themes?.topics || []).slice(0, 15).map((t) => `- "${t.term}": ${t.clients} client(s), ${t.messages} message(s), e.g. ${t.refs.slice(0, 3).map((x) => `[${x.ref}]`).join(' ')}`).join('\n') || '(none)'
  const fin = r.financial ? `${n(r.financial.total)} money-related messages; overdue ${n(r.financial.overdue)}, disputed ${n(r.financial.disputed)}, unpaid ${n(r.financial.unpaid)}; amounts mentioned: ${Object.entries(r.financial.totals || {}).map(([k, v]) => `${k} ${Math.round(v).toLocaleString()}`).join(', ') || 'none'}` : 'n/a'
  const finClients = (r.financial?.clients || []).slice(0, 8).map((c) => `- ${c.name || c.client}: ${c.records} msgs, overdue ${c.overdue}, disputed ${c.disputed}, unpaid ${c.unpaid}, amounts ${Object.entries(c.amounts).map(([k, v]) => `${k} ${Math.round(v).toLocaleString()}`).join(', ') || 'n/a'}${c.invoices.length ? `, invoices ${c.invoices.slice(0, 4).join(', ')}` : ''}`).join('\n') || '(none)'
  const staff = (r.staff?.list || []).slice(0, 8).map((s) => `- ${s.name || s.email}: ${s.sent} replies, ${s.clients} clients, answered ${s.answered}, unanswered(owned) ${s.unanswered}, median response ${s.medianResponseHours ?? 'n/a'} h`).join('\n') || '(none)'
  const audit = (r.audit?.findings || []).map((f) => `- [${f.severity}] ${f.title}`).join('\n') || '(none)'
  const cmp = complaints.slice(0, 40).map((c) => `[${c.ref}] ${c.date ? new Date(c.date).toISOString().slice(0, 10) : 'undated'} ${c.severity.toUpperCase()} ${c.tags.join('/')} from ${c.client || c.clientName || '?'}${c.responded ? '' : ' (NO REPLY)'} — ${c.subject} — ${c.snippet}`).join('\n') || '(none)'
  return `MAILBOX: ${opts.fileName || ''} · ${n(r.total)} messages (${n(r.received)} received, ${n(r.sent)} sent), ${r.dateRange?.min ? new Date(r.dateRange.min).toISOString().slice(0, 10) : '?'} → ${r.dateRange?.max ? new Date(r.dateRange.max).toISOString().slice(0, 10) : '?'}. Our domains: ${(r.ourDomains || []).join(', ') || r.primaryDomain || 'unknown'}.
CLIENTS: ${n(r.clients?.total)} external clients, ${n(r.clients?.atRisk)} need attention, ${n(r.clients?.unansweredTotal)} unanswered client messages, median response ${r.clients?.medianResponseHours ?? 'n/a'} h.

TOP CLIENTS NEEDING ATTENTION:
${top}

COMPLAINTS BY TYPE (keyword-detected, ${n(r.themes?.total)} from ${n(r.themes?.clientsWithComplaints)} clients):
${byType}

RECURRING THEMES ACROSS CLIENTS:
${topics}

FINANCIAL: ${fin}
${finClients}

STAFF RESPONSIVENESS:
${staff}

AUDIT FINDINGS:
${audit}

SAMPLE COMPLAINTS (refs cite the source email):
${cmp}

TASK: You are briefing the managing director. Identify what is really going on across all clients. Respond with a JSON object:
"overview": string (4-8 sentences, plain language, the state of client relationships and the money),
"systemicIssues": array of {"issue": string, "clientsAffected": number, "severity": "low|medium|high", "evidence": array of refs, "recommendation": string} — recurring problems, most damaging first,
"financialExposure": {"summary": string, "amountsAtRisk": string, "evidence": array of refs},
"attentionGaps": {"summary": string, "worstCases": array of strings (client + why), "evidence": array of refs},
"topClientsToActOn": array of {"client": string, "why": string, "action": string},
"recommendations": array of strings (prioritised, concrete),
"confidence": "low|medium|high".
Use only refs that appear above. Respond with JSON only.`
}

export function complaintsReviewPrompt(items) {
  const list = items.map((c) => `[${c.ref}] ${when(c.date)} From: ${c.client || c.clientName || ''}\nSubject: ${c.subject || '(no subject)'}\nKeyword match: ${c.snippet}\nBody: ${clip(c.text || '', 900)}\n---`).join('\n')
  return `Below are emails that a keyword scanner flagged as possible client complaints. Review each one.

${list}

TASK: Respond with a JSON object {"results": [...]} with one entry per email: {"ref": string, "isComplaint": boolean, "problem": string (one line: what the client is unhappy about; empty if not a complaint), "type": "billing|delay|quality|service|cancellation|legal|other|none", "severity": "low|medium|high|none", "sentiment": "angry|frustrated|neutral|satisfied"}. A message is a complaint only if the sender expresses dissatisfaction or a grievance towards us. Respond with JSON only.`
}

export function askPrompt(question, messages) {
  return `QUESTION: ${question}

RELEVANT EMAILS (retrieved by keyword; may be incomplete):
${formatMessages(messages, { perMessage: 1200 })}

TASK: Answer the question using only these emails. Cite refs like [M000123] after each claim. If the emails do not contain the answer, say so plainly. Respond with a JSON object {"answer": string (short paragraphs or bullet lines), "citations": array of refs, "confidence": "low|medium|high"}.`
}

const STOP = new Set('the a an and or of to in on for with about from by at is are was were be been this that these those which who whom whose what when where why how did do does any all some client clients email emails message messages please tell me show find list give our their them they have has had not never'.split(' '))
export function keywordsOf(question, max = 5) {
  const words = String(question || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || []
  const out = []
  for (const w of words) if (!STOP.has(w) && !out.includes(w)) out.push(w)
  return out.slice(0, max)
}
