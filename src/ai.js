// Opt-in AI "deep dive" layer using the user's own DeepSeek API key, called
// directly from the browser (no server). Only the specific emails involved in
// a request are sent — a client's thread, the flagged complaints, or the
// emails matching a question — never the whole mailbox.

const KEY_STORE = 'tox-ai-key'
const SETTINGS_STORE = 'tox-ai-settings'
const DEFAULTS = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxMessages: 30 }

function readKey() { try { return localStorage.getItem(KEY_STORE) || '' } catch { return '' } }

export function getAiSettings() {
  let s = {}
  try { s = JSON.parse(localStorage.getItem(SETTINGS_STORE) || '{}') || {} } catch { /* none */ }
  return { ...DEFAULTS, ...s, key: readKey() }
}

export function saveAiSettings({ key, baseUrl, model, maxMessages }) {
  try {
    if (key != null) localStorage.setItem(KEY_STORE, key)
    localStorage.setItem(SETTINGS_STORE, JSON.stringify({
      baseUrl: (baseUrl || DEFAULTS.baseUrl).trim(),
      model: model || DEFAULTS.model,
      maxMessages: Math.min(80, Math.max(5, Number(maxMessages) || DEFAULTS.maxMessages)),
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

export function deepDivePrompt(client, messages, complaints) {
  const flagged = complaints.map((c) => `[${c.ref}] ${when(c.date)} ${c.severity.toUpperCase()} ${c.tags.join('/')} — ${c.subject} — ${c.snippet}`).join('\n') || '(none flagged)'
  return `CLIENT: ${client.name || ''} <${client.email}> (${client.domain})
STATS: ${client.inbound} messages from client, ${client.outbound} replies to client, ${client.unanswered} unanswered in thread, median response ${client.medianResponseHours ?? 'unknown'} hours, complaints H/M/L ${client.complaints.high}/${client.complaints.medium}/${client.complaints.low}, financial messages ${client.financial}, payment-change requests ${client.bec}.

KEYWORD-FLAGGED COMPLAINTS (may include false positives):
${flagged}

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
