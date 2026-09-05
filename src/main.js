import './styles.css'
import { exportCsv, exportXlsx, exportTxt, exportJson, exportDoc, printHtml, exportXlsxWorkbook, buildEml, downloadBlob, safeFilename } from './exporters.js'
import { startCyberBackground } from './cyberbg.js'
import { renderForensicReport, buildForensicHtmlDoc } from './forensic-render.js'
import { renderClientsView, renderCaseFile, filterClients } from './clients-render.js'

const $ = (sel) => document.querySelector(sel)

const cyberCanvas = document.getElementById('cyber-bg')
if (cyberCanvas) startCyberBackground(cyberCanvas)

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  fileName: '',
  folders: [],
  messages: [],
  contacts: [],
  addresses: [],
  selectedFolderId: null, // null = all folders
  addressLimit: 500,
  messageLimit: 500,
  viewerMessage: null,
  clientQuery: '',
  selectedClient: null,
}

// Worker request/response plumbing for lazy body fetches
let reqCounter = 0
const pendingRequests = new Map()

function requestDetails(ids) {
  return new Promise((resolve, reject) => {
    const reqId = ++reqCounter
    pendingRequests.set(reqId, { resolve, reject })
    worker.postMessage({ type: 'details', reqId, ids })
  })
}

worker.onmessage = (e) => {
  const data = e.data
  switch (data.type) {
    case 'progress':
      $('#parse-message').textContent =
        `Extracting… ${data.items.toLocaleString()} items from ${data.folders} folders (${data.currentFolder})`
      break
    case 'parsed':
      onParsed(data)
      break
    case 'details': {
      const pending = pendingRequests.get(data.reqId)
      if (pending) {
        pendingRequests.delete(data.reqId)
        pending.resolve(data.details)
      }
      break
    }
    case 'error': {
      const pending = pendingRequests.get(data.reqId)
      if (pending) {
        pendingRequests.delete(data.reqId)
        pending.reject(new Error(data.message))
      } else {
        // A parse-time failure. If it was a locked-file read, show the same
        // actionable guidance as the up-front probe; otherwise surface the message.
        showFileReadError(state.fileName, { name: data.errorName, message: data.message })
      }
      break
    }
  }
}

worker.onerror = (e) => {
  showUploadError(`Could not read this file: ${e.message || 'unexpected worker error'}`)
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
const dropZone = $('#drop-zone')
const fileInput = $('#file-input')

dropZone.addEventListener('click', () => fileInput.click())
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click()
})
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0])
})
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropZone.classList.add('dragover')
})
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'))
dropZone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropZone.classList.remove('dragover')
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0])
})

async function loadFile(file) {
  $('#upload-error').hidden = true
  if (!/\.(pst|ost)$/i.test(file.name)) {
    showUploadError('Please choose a .pst or .ost file.')
    return
  }
  // No upload size cap — any PST/OST is accepted. Large files simply take
  // longer; show the size so the user knows a big scan is in progress.
  const scope = {
    addresses: $('#scope-addresses').checked,
    messages: $('#scope-messages').checked,
    contacts: $('#scope-contacts').checked,
    forensic: $('#scope-forensic').checked,
    deepScan: $('#scope-deepscan').checked,
  }
  if (!scope.addresses && !scope.messages && !scope.contacts && !scope.forensic) {
    showUploadError('Select at least one thing to extract (addresses, messages, contacts, or forensic report).')
    return
  }
  state.scope = scope
  state.fileName = file.name
  state.fileSize = file.size
  dropZone.hidden = true
  $('#scope-select').hidden = true
  $('#parse-status').hidden = false
  $('#parse-message').textContent = `Opening ${file.name} (${formatBytes(file.size)})…`

  // Probe a few bytes first. This cheaply detects a locked file (Outlook still
  // has it open, or a OneDrive "online-only" placeholder) without reading the
  // whole thing into memory. Retry once for transient locks. The full file is
  // never loaded here — the worker streams it in slices, so size is unlimited.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await file.slice(0, 4).arrayBuffer()
      break
    } catch (err) {
      if (attempt === 1 && err && err.name === 'NotReadableError') {
        await new Promise((resolve) => setTimeout(resolve, 400))
        continue
      }
      showFileReadError(file.name, err)
      return
    }
  }
  worker.postMessage({ type: 'parse', file, scope })
}

function showFileReadError(fileName, err) {
  const locked = !err || err.name === 'NotReadableError' || err.name === 'SecurityError'
  if (!locked) {
    showUploadError(`Could not read this file: ${escapeHtml(err.message || String(err))}`, true)
    return
  }
  showUploadError(
    `<strong>Windows can't read “${escapeHtml(fileName)}” because the file is locked.</strong>` +
      `<p>This usually means another program is still holding the file open. Try one of these:</p>` +
      `<ol class="fix-list">` +
      `<li><strong>Close Outlook completely</strong> — also quit it from the system tray (the little arrow near the clock), then drop the file again. Outlook locks any PST/OST it has open.</li>` +
      `<li><strong>Upload a copy instead.</strong> Copy the file to your Desktop and load the copy — a copy isn't locked, and this also forces OneDrive "online-only" files to download fully.</li>` +
      `</ol>` +
      `<span class="err-detail">Technical detail: ${escapeHtml(err ? err.name : 'read failed')}</span>`,
    true
  )
}

function showUploadError(message, isHtml = false) {
  $('#parse-status').hidden = true
  dropZone.hidden = false
  $('#scope-select').hidden = false
  const el = $('#upload-error')
  if (isHtml) el.innerHTML = message
  else el.textContent = message
  el.hidden = false
}

$('#reset-btn').addEventListener('click', () => window.location.reload())

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function onParsed(data) {
  state.folders = data.folders
  state.messages = data.messages
  state.contacts = data.contacts
  state.addresses = data.addresses
  state.forensic = data.forensic || null
  state.totalMessages = data.totalMessages ?? data.messages.length
  state.messagesTruncated = !!data.messagesTruncated
  state.selectedFolderId = null
  state.addressLimit = 500
  state.messageLimit = 500

  const scope = state.scope || { addresses: true, messages: true, contacts: true }
  $('#upload-screen').hidden = true
  $('#results-screen').hidden = false

  const summaryParts = []
  if (scope.addresses) summaryParts.push(`${state.addresses.length.toLocaleString()} unique addresses`)
  if (scope.messages) summaryParts.push(`${state.totalMessages.toLocaleString()} messages`)
  if (scope.contacts) summaryParts.push(`${state.contacts.length.toLocaleString()} contacts`)
  $('#file-summary').innerHTML =
    `<strong>${escapeHtml(state.fileName)}</strong> — ` +
    `${summaryParts.join(', ')} in ${state.folders.length} folders`
  $('#count-addresses').textContent = state.addresses.length.toLocaleString()
  $('#count-messages').textContent = state.totalMessages.toLocaleString()
  $('#count-contacts').textContent = state.contacts.length.toLocaleString()
  applyScopeToTabs(scope)
  state.selectedClient = null
  state.clientQuery = ''
  $('#clients-search').value = ''
  if (scope.forensic && state.forensic) { renderForensic(); renderClients() }

  const banner = $('#messages-truncated')
  if (banner) {
    if (state.messagesTruncated) {
      banner.innerHTML =
        `All <strong>${state.totalMessages.toLocaleString()}</strong> messages were scanned for email addresses. ` +
        `To stay within browser memory, only the first <strong>${state.messages.length.toLocaleString()}</strong> are shown here for browsing and message export. ` +
        `The <strong>Email Addresses</strong> tab is complete.`
      banner.hidden = false
    } else {
      banner.hidden = true
    }
  }

  renderAddresses()
  renderFolderTree()
  renderMessages()
  renderContacts()
}

// Tabs
function activateTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.hidden = p.id !== `tab-${name}`
  })
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab))
})

// Show only the tabs that were extracted, and open the first available one.
function applyScopeToTabs(scope) {
  let first = null
  document.querySelectorAll('.tab').forEach((btn) => {
    // The Clients tab is produced by the forensic scan.
    const key = btn.dataset.tab === 'clients' ? 'forensic' : btn.dataset.tab
    const on = scope[key] !== false
    btn.hidden = !on
    if (on && !first) first = btn.dataset.tab
  })
  if (first) activateTab(first)
}

// ---------------------------------------------------------------------------
// Addresses tab
// ---------------------------------------------------------------------------
function filteredAddresses() {
  const q = $('#address-search').value.trim().toLowerCase()
  if (!q) return state.addresses
  return state.addresses.filter((a) =>
    a.email.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
}

function renderAddresses() {
  const rows = filteredAddresses()
  const tbody = $('#address-table tbody')
  tbody.innerHTML = rows.slice(0, state.addressLimit).map((a) => `
    <tr>
      <td>${escapeHtml(a.email)}</td>
      <td class="ellipsis">${escapeHtml(a.name)}</td>
      <td class="num">${a.sent.toLocaleString()}</td>
      <td class="num">${a.received.toLocaleString()}</td>
      <td class="num">${a.total.toLocaleString()}</td>
      <td>${a.contact ? '<span class="badge-yes">✓</span>' : ''}</td>
    </tr>`).join('')
  renderMoreRow('#address-more', rows.length, state.addressLimit, () => {
    state.addressLimit += 500
    renderAddresses()
  })
}

$('#address-search').addEventListener('input', () => {
  state.addressLimit = 500
  renderAddresses()
})

// ---------------------------------------------------------------------------
// Messages tab
// ---------------------------------------------------------------------------
function renderFolderTree() {
  const container = $('#folder-tree')
  container.innerHTML = ''
  container.appendChild(folderButton(null, 'All folders', state.messages.length, 0))

  const byParent = new Map()
  for (const f of state.folders) {
    if (!byParent.has(f.parentId)) byParent.set(f.parentId, [])
    byParent.get(f.parentId).push(f)
  }
  const addLevel = (parentId, depth) => {
    for (const f of byParent.get(parentId) || []) {
      // Hide empty structural folders but keep anything with mail or children
      if (f.messageCount > 0 || byParent.has(f.id)) {
        container.appendChild(folderButton(f.id, f.name, f.messageCount, depth))
      }
      addLevel(f.id, depth + 1)
    }
  }
  // Root folder itself is depth 0; start from its children
  const roots = state.folders.filter((f) => f.parentId === null)
  for (const root of roots) addLevel(root.id, 0)
}

function folderButton(id, name, count, depth) {
  const btn = document.createElement('button')
  btn.className = 'folder-item' + (state.selectedFolderId === id ? ' selected' : '')
  btn.style.paddingLeft = `${0.5 + depth * 0.85}rem`
  btn.innerHTML = `<span class="fname">${escapeHtml(name)}</span><span class="fcount">${count.toLocaleString()}</span>`
  btn.addEventListener('click', () => {
    state.selectedFolderId = id
    state.messageLimit = 500
    renderFolderTree()
    renderMessages()
  })
  return btn
}

function descendantFolderIds(folderId) {
  const ids = new Set([folderId])
  let added = true
  while (added) {
    added = false
    for (const f of state.folders) {
      if (f.parentId !== null && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id)
        added = true
      }
    }
  }
  return ids
}

function filteredMessages() {
  let rows = state.messages
  if (state.selectedFolderId !== null) {
    const ids = descendantFolderIds(state.selectedFolderId)
    rows = rows.filter((m) => ids.has(m.folderId))
  }
  const q = $('#message-search').value.trim().toLowerCase()
  if (q) {
    rows = rows.filter((m) =>
      m.subject.toLowerCase().includes(q) ||
      m.senderName.toLowerCase().includes(q) ||
      m.senderEmail.toLowerCase().includes(q) ||
      m.to.toLowerCase().includes(q))
  }
  return [...rows].sort((a, b) => (b.date ? +new Date(b.date) : 0) - (a.date ? +new Date(a.date) : 0))
}

function renderMessages() {
  const rows = filteredMessages()
  const tbody = $('#message-table tbody')
  tbody.innerHTML = rows.slice(0, state.messageLimit).map((m) => `
    <tr data-id="${m.id}" class="${m.isRead ? '' : 'unread'}">
      <td>${m.date ? new Date(m.date).toLocaleString() : ''}</td>
      <td class="ellipsis">${escapeHtml(m.senderName || m.senderEmail)}</td>
      <td class="ellipsis">${escapeHtml(m.subject)}${m.hasAttachments ? ' 📎' : ''}</td>
      <td class="ellipsis">${escapeHtml(m.to)}</td>
    </tr>`).join('')
  renderMoreRow('#message-more', rows.length, state.messageLimit, () => {
    state.messageLimit += 500
    renderMessages()
  })
}

$('#message-search').addEventListener('input', () => {
  state.messageLimit = 500
  renderMessages()
})

$('#message-table tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]')
  if (tr) openViewer(Number(tr.dataset.id))
})

// ---------------------------------------------------------------------------
// Message viewer
// ---------------------------------------------------------------------------
async function openViewer(id) {
  const meta = state.messages[id]
  if (!meta) return
  state.viewerMessage = { meta, detail: null }
  $('#viewer-subject').textContent = meta.subject || '(no subject)'
  $('#viewer-from').textContent = `From: ${meta.senderName}${meta.senderEmail ? ` <${meta.senderEmail}>` : ''}`
  $('#viewer-to').textContent = `To: ${meta.to}${meta.cc ? `  ·  Cc: ${meta.cc}` : ''}`
  $('#viewer-date').textContent = meta.date ? `Date: ${new Date(meta.date).toLocaleString()} · Folder: ${meta.folderPath}` : `Folder: ${meta.folderPath}`
  const textEl = $('#viewer-body-text')
  const htmlEl = $('#viewer-body-html')
  textEl.hidden = false
  htmlEl.hidden = true
  textEl.textContent = 'Loading…'
  $('#viewer-overlay').hidden = false

  try {
    const [detail] = await requestDetails([id])
    if (!state.viewerMessage || state.viewerMessage.meta.id !== id) return
    state.viewerMessage.detail = detail
    if (detail.bodyHTML) {
      textEl.hidden = true
      htmlEl.hidden = false
      htmlEl.srcdoc = detail.bodyHTML
    } else {
      textEl.textContent = detail.body || '(empty message body)'
    }
  } catch (err) {
    textEl.textContent = `Could not load message body: ${err.message}`
  }
}

function closeViewer() {
  $('#viewer-overlay').hidden = true
  $('#viewer-body-html').srcdoc = ''
  state.viewerMessage = null
}

$('#viewer-close').addEventListener('click', closeViewer)
$('#viewer-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'viewer-overlay') closeViewer()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#viewer-overlay').hidden) closeViewer()
})

$('#viewer-eml').addEventListener('click', async () => {
  const current = state.viewerMessage
  if (!current) return
  let detail = current.detail
  if (!detail) {
    try {
      ;[detail] = await requestDetails([current.meta.id])
    } catch (err) {
      alert(`Could not export message: ${err.message}`)
      return
    }
  }
  const eml = buildEml(current.meta, detail)
  downloadBlob(`${safeFilename(current.meta.subject, 'message')}.eml`, 'message/rfc822', eml)
})

// ---------------------------------------------------------------------------
// Contacts tab
// ---------------------------------------------------------------------------
function filteredContacts() {
  const q = $('#contact-search').value.trim().toLowerCase()
  if (!q) return state.contacts
  return state.contacts.filter((c) =>
    c.name.toLowerCase().includes(q) ||
    c.emails.join(' ').toLowerCase().includes(q) ||
    c.company.toLowerCase().includes(q))
}

function renderContacts() {
  $('#contact-table tbody').innerHTML = filteredContacts().map((c) => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.emails.join(', '))}</td>
      <td>${escapeHtml(c.mobilePhone)}</td>
      <td>${escapeHtml(c.businessPhone)}</td>
      <td class="ellipsis">${escapeHtml(c.company)}</td>
      <td class="ellipsis">${escapeHtml(c.jobTitle)}</td>
    </tr>`).join('')
}

$('#contact-search').addEventListener('input', renderContacts)

// ---------------------------------------------------------------------------
// Forensic report tab
// ---------------------------------------------------------------------------
function renderForensic() {
  const container = $('#forensic-report')
  if (!container || !state.forensic) return
  container.innerHTML = `<div id="forensic-search-results" hidden></div>` + renderForensicReport(state.forensic)
  renderForensicSearch()
}

function renderForensicSearch() {
  const el = $('#forensic-search-results')
  if (!el) return
  const q = $('#forensic-search').value.trim().toLowerCase()
  if (!q) { el.hidden = true; el.innerHTML = ''; return }
  if (!state.messages.length) {
    el.hidden = false
    el.innerHTML = `<div class="fx-searchbox"><strong>Keyword search</strong> needs the message list — re-run with <em>Messages</em> also ticked. The investigation categories below still cover subjects${state.forensic.deepScan ? ' and bodies' : ''}.</div>`
    return
  }
  const hits = state.messages.filter((m) =>
    `${m.subject} ${m.senderName} ${m.senderEmail} ${m.to} ${m.cc} ${m.folderPath}`.toLowerCase().includes(q)
  )
  const shown = hits.slice(0, 200)
  el.hidden = false
  el.innerHTML = `<div class="fx-searchbox">
    <strong>Keyword search:</strong> “${escapeHtml(q)}” — ${hits.length.toLocaleString()} match(es) in scanned messages
    ${hits.length ? `<table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Date</th><th>From</th><th>Subject</th><th>Folder</th></tr></thead><tbody>${
      shown.map((m) => `<tr><td><span class="fx-ref fx-ref-link" data-open-msg="${m.id}">${escapeHtml(m.ref || '—')}</span></td><td class="fx-nowrap">${m.date ? new Date(m.date).toLocaleDateString() : '—'}</td><td class="fx-ellip">${escapeHtml(m.senderEmail || m.senderName)}</td><td>${escapeHtml(m.subject || '(no subject)')}</td><td class="fx-ellip fx-muted">${escapeHtml(m.folderPath)}</td></tr>`).join('')
    }</tbody></table>${hits.length > shown.length ? `<p class="fx-muted">Showing first ${shown.length} of ${hits.length.toLocaleString()}.</p>` : ''}` : ''}
  </div>`
}

$('#forensic-search').addEventListener('input', () => { if (state.forensic) renderForensicSearch() })

// Click a reference (e.g. M000123) to open the source message when retained.
$('#forensic-report').addEventListener('click', (e) => {
  const el = e.target.closest('[data-open-msg]')
  if (el) openViewer(Number(el.dataset.openMsg))
})

// ---------------------------------------------------------------------------
// Clients tab (client intelligence)
// ---------------------------------------------------------------------------
function clientTimeline(email) {
  return state.messages
    .filter((m) => m.senderEmail === email || (m.recipients || []).some((r) => r.email === email))
    .map((m) => ({
      id: m.id, ref: m.ref, dir: m.senderEmail === email ? 'in' : 'out', date: m.date,
      subject: m.subject, folder: m.folderPath, from: m.senderEmail || m.senderName, to: m.to, hasAttachments: m.hasAttachments,
    }))
    .sort((a, b) => (a.date ? +new Date(a.date) : 0) - (b.date ? +new Date(b.date) : 0))
}

function selectedClientObj() {
  return state.selectedClient ? state.forensic?.clients?.list.find((c) => c.email === state.selectedClient) : null
}

function clientComplaints(email) {
  return (state.forensic?.complaints?.records || []).filter((c) => c.client === email)
}

function renderClients() {
  const view = $('#clients-view')
  if (!view || !state.forensic) return
  view.innerHTML = renderClientsView(state.forensic.clients, { query: state.clientQuery })
  renderClientCase()
}

function renderClientCase() {
  const box = $('#client-case')
  if (!box) return
  const c = selectedClientObj()
  if (!c) { box.hidden = true; box.innerHTML = ''; return }
  box.innerHTML = renderCaseFile(c, clientTimeline(c.email), clientComplaints(c.email))
  box.hidden = false
  box.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

$('#clients-search').addEventListener('input', () => {
  state.clientQuery = $('#clients-search').value
  renderClients()
})

$('#tab-clients').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open-msg]')
  if (open) { openViewer(Number(open.dataset.openMsg)); return }
  if (e.target.closest('#case-back')) { state.selectedClient = null; renderClientCase(); return }
  const row = e.target.closest('.cl-row[data-client]')
  if (row) { state.selectedClient = row.dataset.client; renderClientCase(); return }
  const dom = e.target.closest('.cl-row[data-domain]')
  if (dom) {
    state.clientQuery = dom.dataset.domain
    $('#clients-search').value = state.clientQuery
    renderClients()
  }
})

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
const ADDRESS_COLUMNS = [
  { key: 'email', label: 'Email Address' },
  { key: 'name', label: 'Name' },
  { key: 'sent', label: 'Sent' },
  { key: 'received', label: 'Received' },
  { key: 'total', label: 'Total' },
  { key: 'contact', label: 'In Contacts', format: (r) => (r.contact ? 'Yes' : '') },
]

const MESSAGE_COLUMNS = [
  { key: 'date', label: 'Date', format: (m) => (m.date ? new Date(m.date).toISOString() : '') },
  { key: 'senderName', label: 'From Name' },
  { key: 'senderEmail', label: 'From Email' },
  { key: 'to', label: 'To' },
  { key: 'cc', label: 'Cc' },
  { key: 'subject', label: 'Subject' },
  { key: 'folderPath', label: 'Folder' },
  { key: 'hasAttachments', label: 'Attachments', format: (m) => (m.hasAttachments ? 'Yes' : '') },
  { key: 'isRead', label: 'Read', format: (m) => (m.isRead ? 'Yes' : 'No') },
]

const CONTACT_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'firstName', label: 'First Name' },
  { key: 'lastName', label: 'Last Name' },
  { key: 'emails', label: 'Email 1', format: (c) => c.emails[0] || '' },
  { key: 'emails', label: 'Email 2', format: (c) => c.emails[1] || '' },
  { key: 'emails', label: 'Email 3', format: (c) => c.emails[2] || '' },
  { key: 'mobilePhone', label: 'Mobile Phone' },
  { key: 'businessPhone', label: 'Business Phone' },
  { key: 'homePhone', label: 'Home Phone' },
  { key: 'company', label: 'Company' },
  { key: 'jobTitle', label: 'Job Title' },
]

const COMPLAINT_COLUMNS = [
  { key: 'ref', label: 'Ref' },
  { key: 'severity', label: 'Severity', format: (c) => c.severity.toUpperCase() },
  { key: 'date', label: 'Date', format: (c) => (c.date ? new Date(c.date).toISOString() : '') },
  { key: 'client', label: 'Client Email' },
  { key: 'clientName', label: 'Client Name' },
  { key: 'subject', label: 'Subject' },
  { key: 'tags', label: 'Type', format: (c) => c.tags.join('; ') },
  { key: 'external', label: 'External Client', format: (c) => (c.external ? 'Yes' : 'No') },
  { key: 'responded', label: 'Replied', format: (c) => (!c.external ? 'n/a' : c.responded ? 'Yes' : 'No') },
  { key: 'folder', label: 'Folder' },
  { key: 'snippet', label: 'Match' },
  { key: 'messageId', label: 'Message-ID' },
]

const AUDIT_COLUMNS = [
  { key: 'severity', label: 'Severity', format: (f) => f.severity.toUpperCase() },
  { key: 'category', label: 'Category' },
  { key: 'title', label: 'Finding' },
  { key: 'detail', label: 'Detail / recommendation' },
  { key: 'samples', label: 'Evidence items', format: (f) => (f.samples ? f.samples.length : 0) },
  { key: 'samples', label: 'Evidence refs', format: (f) => (f.samples || []).map((s) => s.ref).filter(Boolean).join('; ') },
]

const CLIENT_COLUMNS = [
  { key: 'label', label: 'Attention', format: (c) => ({ critical: 'Critical', 'at-risk': 'At risk', watch: 'Watch', healthy: 'Healthy' })[c.label] || c.label },
  { key: 'score', label: 'Score' },
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'domain', label: 'Company (domain)' },
  { key: 'inbound', label: 'Messages from client' },
  { key: 'outbound', label: 'Messages to client' },
  { key: 'answered', label: 'Answered' },
  { key: 'unanswered', label: 'Unanswered' },
  { key: 'medianResponseHours', label: 'Median response (hours)' },
  { key: 'complaints', label: 'Complaints High', format: (c) => c.complaints.high },
  { key: 'complaints', label: 'Complaints Medium', format: (c) => c.complaints.medium },
  { key: 'complaints', label: 'Complaints Low', format: (c) => c.complaints.low },
  { key: 'complaintTags', label: 'Complaint types', format: (c) => Object.entries(c.complaintTags || {}).map(([t, k]) => `${t} (${k})`).join('; ') },
  { key: 'escalated', label: 'Escalated' },
  { key: 'financial', label: 'Financial msgs' },
  { key: 'legal', label: 'Legal msgs' },
  { key: 'bec', label: 'Payment-change requests' },
  { key: 'firstIn', label: 'First contact', format: (c) => (c.firstIn ? new Date(c.firstIn).toISOString() : '') },
  { key: 'lastIn', label: 'Last from client', format: (c) => (c.lastIn ? new Date(c.lastIn).toISOString() : '') },
  { key: 'lastOut', label: 'Last reply to client', format: (c) => (c.lastOut ? new Date(c.lastOut).toISOString() : '') },
  { key: 'waiting', label: 'Awaiting reply', format: (c) => (c.waiting ? 'Yes' : 'No') },
  { key: 'refs', label: 'Notable refs', format: (c) => (c.refs || []).map((r) => `${r.ref} (${r.type})`).join('; ') },
]

const TIMELINE_COLUMNS = [
  { key: 'ref', label: 'Ref' },
  { key: 'dir', label: 'Direction', format: (m) => (m.dir === 'in' ? 'From client' : 'To client') },
  { key: 'date', label: 'Date', format: (m) => (m.date ? new Date(m.date).toISOString() : '') },
  { key: 'subject', label: 'Subject' },
  { key: 'from', label: 'From' },
  { key: 'to', label: 'To' },
  { key: 'folder', label: 'Folder' },
  { key: 'hasAttachments', label: 'Attachments', format: (m) => (m.hasAttachments ? 'Yes' : '') },
]

// Flattened category matches (one row per detected message) for the workbook.
const MATCH_COLUMNS = [
  { key: 'ref', label: 'Ref' },
  { key: 'category', label: 'Category' },
  { key: 'date', label: 'Date', format: (r) => (r.date ? new Date(r.date).toISOString() : '') },
  { key: 'from', label: 'From' },
  { key: 'subject', label: 'Subject' },
  { key: 'term', label: 'Matched term' },
  { key: 'snippet', label: 'Context' },
  { key: 'folder', label: 'Folder' },
  { key: 'messageId', label: 'Message-ID' },
]

function exportBase() {
  return safeFilename(state.fileName.replace(/\.(pst|ost)$/i, ''), 'outlook')
}

// Assemble the forensic report as a multi-sheet Excel workbook. Every detection
// row carries its reference (Ref + Message-ID) for traceability.
function buildReportWorkbook() {
  const f = state.forensic
  const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '')
  const summaryRows = [
    ['File', state.fileName], ['Generated', new Date().toISOString()],
    ['Deep content scan', f.deepScan ? 'Yes' : 'No'],
    ['Total messages', f.total], ['Received', f.received], ['Sent', f.sent], ['Drafts', f.drafts],
    ['With attachments', f.withAttachments], ['Unread', f.unread],
    ['Unique senders', f.uniqueSenders], ['Unique recipients', f.uniqueRecipients],
    ['Unique domains', f.uniqueDomains], ['External senders', f.externalSenders],
    ['Date range', `${iso(f.dateRange.min)} — ${iso(f.dateRange.max)}`],
    ['Complaints', f.complaints.total], ['Unanswered client complaints', f.complaints.unanswered],
    ['Audit findings (High/Med/Low)', `${f.audit.counts.high}/${f.audit.counts.medium}/${f.audit.counts.low}`],
    ['Payment/bank-change requests', f.becTotal], ['Risky attachments', f.riskyAttachmentTotal],
    ['Sender spoofing mismatches', f.nameMismatchTotal], ['Sensitive-data hits', f.sensitiveTotal],
  ].map(([k, v]) => ({ k, v }))

  const matches = []
  for (const cat of Object.values(f.categories)) {
    for (const s of cat.samples) matches.push({ ...s, category: cat.label })
  }

  const redflags = []
  for (const a of f.riskyAttachments) redflags.push({ ref: a.ref, flag: 'Risky attachment', from: a.from, detail: `${a.name} (.${a.ext})`, date: a.date, folder: a.folder, messageId: a.messageId })
  for (const m of f.nameMismatch) redflags.push({ ref: m.ref, flag: 'Sender name/address mismatch', from: m.senderEmail, detail: m.senderName, date: m.date, folder: m.folder, messageId: m.messageId })
  for (const s of f.sensitive) redflags.push({ ref: s.ref, flag: `Sensitive data: ${s.type}`, from: s.from, detail: s.subject, date: s.date, folder: s.folder, messageId: s.messageId })
  for (const b of f.bec) redflags.push({ ref: b.ref, flag: 'Payment/bank-change request', from: b.from, detail: b.subject, date: b.date, folder: b.folder, messageId: b.messageId })

  const REDFLAG_COLUMNS = [
    { key: 'ref', label: 'Ref' }, { key: 'flag', label: 'Flag' }, { key: 'from', label: 'From' },
    { key: 'detail', label: 'Detail' }, { key: 'date', label: 'Date', format: (r) => (r.date ? new Date(r.date).toISOString() : '') },
    { key: 'folder', label: 'Folder' }, { key: 'messageId', label: 'Message-ID' },
  ]

  return [
    { name: 'Summary', rows: summaryRows, columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }] },
    { name: 'Audit Findings', rows: f.audit.findings, columns: AUDIT_COLUMNS },
    { name: 'Complaints', rows: f.complaints.records, columns: COMPLAINT_COLUMNS },
    { name: 'Investigation Matches', rows: matches, columns: MATCH_COLUMNS },
    { name: 'Red Flags', rows: redflags, columns: REDFLAG_COLUMNS },
    { name: 'Clients', rows: f.clients?.list || [], columns: CLIENT_COLUMNS },
  ]
}

const exporters = {
  'addresses-csv': () => exportCsv(`${exportBase()}-addresses.csv`, filteredAddresses(), ADDRESS_COLUMNS),
  'addresses-xlsx': () => exportXlsx(`${exportBase()}-addresses.xlsx`, filteredAddresses(), ADDRESS_COLUMNS, 'Email Addresses'),
  'addresses-txt': () => exportTxt(`${exportBase()}-addresses.txt`, filteredAddresses().map((a) => a.email)),
  'messages-csv': () => exportCsv(`${exportBase()}-messages.csv`, filteredMessages(), MESSAGE_COLUMNS),
  'messages-xlsx': () => exportXlsx(`${exportBase()}-messages.xlsx`, filteredMessages(), MESSAGE_COLUMNS, 'Messages'),
  'messages-json': exportMessagesJson,
  'contacts-csv': () => exportCsv(`${exportBase()}-contacts.csv`, filteredContacts(), CONTACT_COLUMNS),
  'contacts-xlsx': () => exportXlsx(`${exportBase()}-contacts.xlsx`, filteredContacts(), CONTACT_COLUMNS, 'Contacts'),
  'forensic-html': () => {
    if (!state.forensic) return
    downloadBlob(`${exportBase()}-forensic-report.html`, 'text/html;charset=utf-8', buildForensicHtmlDoc(state.forensic, state.fileName))
  },
  'forensic-json': () => {
    if (!state.forensic) return
    exportJson(`${exportBase()}-forensic-report.json`, { file: state.fileName, generated: new Date().toISOString(), report: state.forensic })
  },
  'forensic-pdf': () => {
    if (!state.forensic) return
    printHtml(buildForensicHtmlDoc(state.forensic, state.fileName))
  },
  'forensic-word': () => {
    if (!state.forensic) return
    exportDoc(`${exportBase()}-forensic-report.doc`, buildForensicHtmlDoc(state.forensic, state.fileName))
  },
  'forensic-xlsx': () => {
    if (!state.forensic) return
    exportXlsxWorkbook(`${exportBase()}-forensic-report.xlsx`, buildReportWorkbook())
  },
  'clients-csv': () => {
    const rows = filterClients(state.forensic?.clients?.list || [], state.clientQuery)
    if (!rows.length) return alert('No external clients detected to export.')
    exportCsv(`${exportBase()}-clients.csv`, rows, CLIENT_COLUMNS)
  },
  'clients-xlsx': () => {
    const rows = filterClients(state.forensic?.clients?.list || [], state.clientQuery)
    if (!rows.length) return alert('No external clients detected to export.')
    exportXlsx(`${exportBase()}-clients.xlsx`, rows, CLIENT_COLUMNS, 'Clients')
  },
  'case-xlsx': () => {
    const c = selectedClientObj()
    if (!c) return alert('Click a client row first to open their case file.')
    const summary = CLIENT_COLUMNS.map((col) => ({ k: col.label, v: col.format ? col.format(c) : c[col.key] }))
    exportXlsxWorkbook(`${exportBase()}-client-${safeFilename(c.email)}.xlsx`, [
      { name: 'Summary', rows: summary, columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }] },
      { name: 'Timeline', rows: clientTimeline(c.email), columns: TIMELINE_COLUMNS },
      { name: 'Complaints', rows: clientComplaints(c.email), columns: COMPLAINT_COLUMNS },
      { name: 'Notable', rows: c.refs || [], columns: [{ key: 'ref', label: 'Ref' }, { key: 'type', label: 'Type' }, { key: 'date', label: 'Date', format: (r) => (r.date ? new Date(r.date).toISOString() : '') }, { key: 'subject', label: 'Subject' }] },
    ])
  },
  'case-word': () => {
    const c = selectedClientObj()
    if (!c) return alert('Click a client row first to open their case file.')
    exportDoc(`${exportBase()}-client-${safeFilename(c.email)}.doc`, buildForensicHtmlDoc(null, state.fileName, {
      title: `Client case file — ${c.name || c.email}`,
      body: renderCaseFile(c, clientTimeline(c.email), clientComplaints(c.email), { print: true }),
    }))
  },
  'case-pdf': () => {
    const c = selectedClientObj()
    if (!c) return alert('Click a client row first to open their case file.')
    printHtml(buildForensicHtmlDoc(null, state.fileName, {
      title: `Client case file — ${c.name || c.email}`,
      body: renderCaseFile(c, clientTimeline(c.email), clientComplaints(c.email), { print: true }),
    }))
  },
  'complaints-csv': () => {
    if (!state.forensic?.complaints?.records.length) return alert('No complaints detected to export.')
    exportCsv(`${exportBase()}-complaints.csv`, state.forensic.complaints.records, COMPLAINT_COLUMNS)
  },
  'complaints-xlsx': () => {
    if (!state.forensic?.complaints?.records.length) return alert('No complaints detected to export.')
    exportXlsx(`${exportBase()}-complaints.xlsx`, state.forensic.complaints.records, COMPLAINT_COLUMNS, 'Complaints')
  },
  'audit-csv': () => {
    if (!state.forensic?.audit?.findings.length) return alert('No audit findings to export.')
    exportCsv(`${exportBase()}-audit-findings.csv`, state.forensic.audit.findings, AUDIT_COLUMNS)
  },
  'audit-xlsx': () => {
    if (!state.forensic?.audit?.findings.length) return alert('No audit findings to export.')
    exportXlsx(`${exportBase()}-audit-findings.xlsx`, state.forensic.audit.findings, AUDIT_COLUMNS, 'Audit Findings')
  },
}

document.querySelectorAll('[data-export]').forEach((btn) => {
  btn.addEventListener('click', () => exporters[btn.dataset.export]?.(btn))
})

async function exportMessagesJson(btn) {
  const rows = filteredMessages()
  const original = btn.textContent
  btn.disabled = true
  try {
    const out = []
    const BATCH = 200
    for (let i = 0; i < rows.length; i += BATCH) {
      btn.textContent = `Fetching ${Math.min(i + BATCH, rows.length)} / ${rows.length}…`
      const batch = rows.slice(i, i + BATCH)
      const details = await requestDetails(batch.map((m) => m.id))
      batch.forEach((m, j) => {
        out.push({
          date: m.date,
          fromName: m.senderName,
          fromEmail: m.senderEmail,
          to: m.to,
          cc: m.cc,
          bcc: m.bcc,
          recipients: m.recipients,
          subject: m.subject,
          folder: m.folderPath,
          hasAttachments: m.hasAttachments,
          body: details[j].body,
          bodyHTML: details[j].bodyHTML,
          headers: details[j].headers,
        })
      })
    }
    exportJson(`${exportBase()}-messages.json`, out)
  } catch (err) {
    alert(`Export failed: ${err.message}`)
  } finally {
    btn.textContent = original
    btn.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function renderMoreRow(selector, total, limit, onMore) {
  const el = $(selector)
  if (total <= limit) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.textContent = `Showing ${limit.toLocaleString()} of ${total.toLocaleString()} — `
  const btn = document.createElement('button')
  btn.className = 'btn btn-secondary'
  btn.textContent = 'Show more'
  btn.addEventListener('click', onMore)
  el.appendChild(btn)
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
