import './styles.css'
import { exportCsv, exportXlsx, exportTxt, exportJson, exportDoc, printHtml, exportXlsxWorkbook, buildCsv, buildEml, downloadBlob, safeFilename } from './exporters.js'
import { makeZip, safeZipName } from './zip.js'
import { startCyberBackground } from './cyberbg.js'
import { renderForensicReport, buildForensicHtmlDoc, TRIAGE_TEXT, findingKey, withPeriod } from './forensic-render.js'
import { renderClientsView, renderCaseFile, filterClients, renderAiDive, renderStaffView } from './clients-render.js'
import { getAiSettings, saveAiSettings, clearAiKey, aiEnabled, setSessionKey, deepseekChat, deepDivePrompt, complaintsReviewPrompt, executiveSummaryPrompt, askPrompt, textOf, keywordsOf } from './ai.js'
import { loadVaultFile, decryptVault, encryptVault, generatePassphrase } from './vault.js'
import { saveAnalysis, listAnalyses, loadAnalysis, deleteAnalysis, signatureOf } from './storage.js'

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
  sources: [],
  adding: false,
  hasSession: false,
  resumed: false,
  ai: { dive: {}, complaints: {}, exec: null },
  vault: null,
  period: null,
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

// Generic request/response to the worker (search, attachments…).
function requestWorker(type, payload) {
  return new Promise((resolve, reject) => {
    const reqId = ++reqCounter
    pendingRequests.set(reqId, { resolve, reject })
    worker.postMessage({ type, reqId, ...payload })
  })
}

worker.onmessage = (e) => {
  const data = e.data
  switch (data.type) {
    case 'progress':
      if (state.adding) {
        $('#add-status').innerHTML = `<span class="spinner-inline"></span> Scanning ${escapeHtml(state.addingName || 'mailbox')}… ${data.items.toLocaleString()} items`
      } else {
        $('#parse-message').textContent =
          `Extracting… ${data.items.toLocaleString()} items from ${data.folders} folders (${data.currentFolder})`
      }
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
    case 'search':
    case 'attachments':
    case 'attachment': {
      const pending = pendingRequests.get(data.reqId)
      if (pending) {
        pendingRequests.delete(data.reqId)
        pending.resolve(data)
      }
      break
    }
    case 'error': {
      const pending = pendingRequests.get(data.reqId)
      if (pending) {
        pendingRequests.delete(data.reqId)
        pending.reject(new Error(data.message))
      } else if (state.adding) {
        state.adding = false
        $('#add-status').hidden = true
        $('#add-file-btn').disabled = false
        alert(`Could not scan that mailbox: ${data.message}`)
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
try { $('#scope-domains').value = localStorage.getItem('tox-our-domains') || '' } catch { /* storage */ }
renderResumePanel()

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
  const ourDomains = $('#scope-domains').value.split(/[,;\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
  try { localStorage.setItem('tox-our-domains', ourDomains.join(', ')) } catch { /* storage */ }
  const scope = {
    ourDomains,
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
  state.fileHandles = { [file.name]: file }
  state.sources = [file.name]
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
  state.hasSession = true
  worker.postMessage({ type: 'parse', file, scope, sourceName: file.name })
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

// --- Save / resume (IndexedDB, local) --------------------------------------
async function persistAnalysis() {
  if (!state.hasSession || !state.sources.length) return
  const sig = signatureOf(state.sources)
  const record = {
    signature: sig, savedAt: Date.now(), sources: state.sources.slice(), scope: state.scope,
    fileName: state.fileName,
    counts: { messages: state.totalMessages, addresses: state.addresses.length, clients: state.forensic?.clients?.total || 0 },
    data: {
      folders: state.folders, messages: state.messages, contacts: state.contacts,
      addresses: state.addresses, forensic: state.forensic,
      totalMessages: state.totalMessages, messagesTruncated: state.messagesTruncated,
    },
  }
  await saveAnalysis(record)
}

async function renderResumePanel() {
  const host = $('#resume-panel')
  if (!host) return
  const items = await listAnalyses()
  if (!items.length) { host.hidden = true; host.innerHTML = ''; return }
  host.hidden = false
  host.innerHTML = `<h3 class="resume-title">Resume a saved analysis</h3>
    <p class="fx-muted">Stored on this device only. Opens instantly; re-attach the file to read message bodies, download attachments or run AI.</p>
    <div class="resume-list">${items.map((a) => `
      <div class="resume-item">
        <div><strong>${escapeHtml(a.sources && a.sources.length > 1 ? `${a.sources.length} mailboxes` : (a.fileName || a.signature))}</strong>
          <div class="fx-muted">${escapeHtml((a.sources || []).join(', '))}</div>
          <div class="fx-muted">${a.counts ? `${(a.counts.messages || 0).toLocaleString()} messages · ${(a.counts.clients || 0).toLocaleString()} clients` : ''} · saved ${new Date(a.savedAt).toLocaleString()}</div>
        </div>
        <div class="resume-actions">
          <button class="btn" data-resume="${escapeHtml(a.signature)}">Resume</button>
          <button class="btn btn-secondary" data-resume-del="${escapeHtml(a.signature)}" title="Delete this saved analysis">✕</button>
        </div>
      </div>`).join('')}</div>`
}

$('#resume-panel').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-resume-del]')
  if (del) { await deleteAnalysis(del.dataset.resumeDel); renderResumePanel(); return }
  const btn = e.target.closest('[data-resume]')
  if (!btn) return
  const rec = await loadAnalysis(btn.dataset.resume)
  if (!rec) { alert('Could not load that saved analysis.'); renderResumePanel(); return }
  resumeAnalysis(rec)
})

function resumeAnalysis(rec) {
  state.scope = rec.scope || { addresses: true, messages: true, contacts: true }
  state.fileName = rec.fileName || (rec.sources && rec.sources[0]) || 'analysis'
  state.hasSession = false
  state.resumed = true
  onParsed({ ...rec.data, sources: rec.sources })
  showReattachBanner()
}

function showReattachBanner() {
  let b = $('#reattach-banner')
  if (!b) {
    b = document.createElement('div')
    b.id = 'reattach-banner'
    b.className = 'notice'
    $('#results-screen').prepend(b)
  }
  b.hidden = false
  b.innerHTML = `Resumed from saved analysis — all tables, the report and exports are ready. To read a message body, download an attachment or run AI, re-attach the file: <button id="reattach-btn" class="btn btn-secondary">Re-attach mailbox</button>`
  $('#reattach-btn').addEventListener('click', () => { state.reattaching = true; fileInput.click() })
}

// A live worker session is required for bodies/attachments/AI. Guard nicely.
function requireSession(what) {
  if (state.hasSession) return true
  alert(`${what} needs the mailbox file. Click "Re-attach mailbox" (or "Load another file") and pick ${state.sources.length > 1 ? 'the same files' : 'the same file'} to continue.`)
  return false
}

// Add another mailbox into the combined view (same scope as the first load).
const addFileInput = $('#add-file-input')
$('#add-file-btn').addEventListener('click', () => addFileInput.click())
addFileInput.addEventListener('change', () => { if (addFileInput.files[0]) addMailbox(addFileInput.files[0]); addFileInput.value = '' })

async function addMailbox(file) {
  if (!/\.(pst|ost)$/i.test(file.name)) { alert('Please choose a .pst or .ost file.'); return }
  if (state.sources.includes(file.name)) { if (!confirm(`"${file.name}" looks already added. Add it again anyway?`)) return }
  try { await file.slice(0, 4).arrayBuffer() } catch (err) { showFileReadError(file.name, err); $('#upload-screen').hidden = false; $('#results-screen').hidden = true; return }
  state.adding = true
  state.hasSession = true
  state.addingName = file.name
  state.fileHandles = state.fileHandles || {}
  state.fileHandles[file.name] = file
  $('#add-status').hidden = false
  $('#add-status').innerHTML = `<span class="spinner-inline"></span> Opening ${escapeHtml(file.name)} (${formatBytes(file.size)})…`
  $('#add-file-btn').disabled = true
  worker.postMessage({ type: 'addfile', file, sourceName: file.name })
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function onParsed(data) {
  state.folders = data.folders
  state.messages = data.messages
  state.contacts = data.contacts
  state.addresses = data.addresses
  state.forensic = data.forensic || null
  state.sources = data.sources || (state.fileName ? [state.fileName] : [])
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
  const label = state.sources.length > 1
    ? `<strong>${state.sources.length} mailboxes</strong> <span class="fx-muted">(${state.sources.map((s) => escapeHtml(s)).join(', ')})</span>`
    : `<strong>${escapeHtml(state.fileName)}</strong>`
  $('#file-summary').innerHTML = `${label} — ${summaryParts.join(', ')} in ${state.folders.length} folders`
  $('#add-status').hidden = true
  state.adding = false
  $('#count-addresses').textContent = state.addresses.length.toLocaleString()
  $('#count-messages').textContent = state.totalMessages.toLocaleString()
  $('#count-contacts').textContent = state.contacts.length.toLocaleString()
  applyScopeToTabs(scope)
  state.selectedClient = null
  state.clientQuery = ''
  $('#clients-search').value = ''
  state.triage = loadTriage()
  state.ai = loadAi()
  if (scope.forensic && state.forensic) { renderForensic(); renderClients() }
  vaultReady.then(maybePromptAdminLogin)

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
  $('#add-file-btn').disabled = false
  persistAnalysis()
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
  if (!state.hasSession) { requireSession('Reading a message'); return }
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
  loadViewerAttachments(id, meta)
}

function closeViewer() {
  $('#viewer-overlay').hidden = true
  $('#viewer-body-html').srcdoc = ''
  $('#viewer-attachments').hidden = true
  $('#viewer-attachments').innerHTML = ''
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
  container.innerHTML = `<div id="forensic-search-results" hidden></div>` + renderForensicReport(state.forensic, { triage: state.triage, interactive: true, ai: state.ai.complaints, exec: state.ai.exec, period: state.period })
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
// Triage (auditor status + notes, persisted per file in this browser)
// ---------------------------------------------------------------------------
function triageStorageKey() { return `tox-triage:${state.fileName}` }
function loadTriage() {
  try { return JSON.parse(localStorage.getItem(triageStorageKey()) || '{}') || {} } catch { return {} }
}
function saveTriage() {
  try { localStorage.setItem(triageStorageKey(), JSON.stringify(state.triage || {})) } catch { /* storage unavailable */ }
}
function triageOf(key) { return (state.triage && state.triage[key]) || {} }

$('#forensic-report').addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-triage]')
  if (!sel) return
  const k = sel.dataset.triage
  state.triage = state.triage || {}
  state.triage[k] = { ...triageOf(k), status: sel.value }
  sel.className = `fx-triage-sel fx-triage-${sel.value}`
  saveTriage()
})
$('#forensic-report').addEventListener('input', (e) => {
  const inp = e.target.closest('input[data-triage-note]')
  if (!inp) return
  const k = inp.dataset.triageNote
  state.triage = state.triage || {}
  state.triage[k] = { ...triageOf(k), note: inp.value }
  saveTriage()
})

// ---------------------------------------------------------------------------
// Deep (body) keyword search — runs in the worker over retained messages
// ---------------------------------------------------------------------------
$('#forensic-deep-search').addEventListener('click', async () => {
  if (!requireSession('Body search')) return
  const q = $('#forensic-search').value.trim()
  const el = $('#forensic-search-results')
  if (!el) return
  if (!q) { $('#forensic-search').focus(); return }
  if (!state.messages.length) {
    el.hidden = false
    el.innerHTML = `<div class="fx-searchbox"><strong>Body search</strong> needs the message list — re-run with <em>Messages</em> also ticked.</div>`
    return
  }
  const btn = $('#forensic-deep-search')
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = 'Searching…'
  el.hidden = false
  el.innerHTML = `<div class="fx-searchbox">Searching ${state.messages.length.toLocaleString()} message bodies for “${escapeHtml(q)}”…</div>`
  try {
    const res = await requestWorker('search', { query: q, limit: 300 })
    const rows = res.hits.map((h) => {
      const m = state.messages[h.id] || {}
      return `<tr><td><span class="fx-ref fx-ref-link" data-open-msg="${h.id}">${escapeHtml(m.ref || '—')}</span></td><td class="fx-nowrap">${m.date ? new Date(m.date).toLocaleDateString() : '—'}</td><td class="fx-ellip">${escapeHtml(m.senderEmail || m.senderName || '')}</td><td>${escapeHtml(m.subject || '(no subject)')}<div class="fx-snip">${escapeHtml(h.snippet)}</div></td><td class="fx-ellip fx-muted">${escapeHtml(m.folderPath || '')}</td></tr>`
    }).join('')
    el.innerHTML = `<div class="fx-searchbox"><strong>Body search:</strong> “${escapeHtml(q)}” — ${res.hits.length.toLocaleString()} message(s) mention it <span class="fx-muted">(scanned ${res.scanned.toLocaleString()} bodies)</span>
      ${res.hits.length ? `<table class="fx-table fx-samples"><thead><tr><th>Ref</th><th>Date</th><th>From</th><th>Subject / context</th><th>Folder</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
      ${res.truncated ? '<p class="fx-muted">Showing the first 300 matches — refine the keyword to narrow it down.</p>' : ''}</div>`
  } catch (err) {
    el.innerHTML = `<div class="fx-searchbox">Search failed: ${escapeHtml(err.message)}</div>`
  } finally {
    btn.disabled = false
    btn.textContent = original
  }
})

// ---------------------------------------------------------------------------
// Attachments in the message viewer
// ---------------------------------------------------------------------------
async function loadViewerAttachments(id, meta) {
  const el = $('#viewer-attachments')
  el.hidden = true
  el.innerHTML = ''
  if (!meta.hasAttachments) return
  try {
    const res = await requestWorker('attachments', { id })
    if (!state.viewerMessage || state.viewerMessage.meta.id !== id) return
    if (!res.attachments.length) return
    el.hidden = false
    el.innerHTML = `<span class="export-label">Attachments (${res.attachments.length}):</span> ` + res.attachments.map((a) => a.embedded
      ? `<span class="att-chip fx-muted" title="Embedded message — open it from the message list">📧 ${escapeHtml(a.name || 'embedded message')}</span>`
      : `<button class="btn btn-secondary att-btn" data-att-index="${a.index}" data-att-id="${id}" title="Download">📎 ${escapeHtml(a.name || `attachment-${a.index + 1}`)} <span class="fx-muted">${a.size ? formatBytes(a.size) : ''}</span></button>`
    ).join(' ')
  } catch { /* attachments unreadable — leave hidden */ }
}

$('#viewer-attachments').addEventListener('click', async (e) => {
  const btn = e.target.closest('.att-btn')
  if (!btn) return
  const original = btn.innerHTML
  btn.disabled = true
  btn.textContent = 'Downloading…'
  try {
    const res = await requestWorker('attachment', { id: Number(btn.dataset.attId), index: Number(btn.dataset.attIndex) })
    downloadBlob(res.name || 'attachment', res.mime || 'application/octet-stream', new Blob([res.data], { type: res.mime || 'application/octet-stream' }))
  } catch (err) {
    alert(`Could not download attachment: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.innerHTML = original
  }
})

// ---------------------------------------------------------------------------
// AI deep dive (DeepSeek, bring-your-own-key, opt-in)
// ---------------------------------------------------------------------------
function aiStorageKey() { return `tox-ai:${state.fileName}` }
function loadAi() {
  try {
    const s = JSON.parse(localStorage.getItem(aiStorageKey()) || '{}') || {}
    return { dive: s.dive || {}, complaints: s.complaints || {}, exec: s.exec || null }
  } catch { return { dive: {}, complaints: {}, exec: null } }
}
function saveAi() { try { localStorage.setItem(aiStorageKey(), JSON.stringify(state.ai)) } catch { /* quota */ } }

// Admin vault: the API key ships inside the site as an encrypted vault.json
// and is unlocked with the admin passphrase — once per device.
const vaultReady = loadVaultFile().then((v) => { state.vault = v; updateAiButtons() })

// PIN login: after the one-time passphrase unlock, the key is kept on this
// device encrypted with a 4–6 digit PIN (never in plaintext). Each visit the
// admin logs in with the PIN; wrong attempts are limited.
const PIN_STORE = 'tox-ai-pin'
const PIN_ITER = 150000
const PIN_MAX_ATTEMPTS = 5
function loadPinVault() { try { return JSON.parse(localStorage.getItem(PIN_STORE) || 'null') } catch { return null } }
function savePinVault(v) { try { localStorage.setItem(PIN_STORE, JSON.stringify(v)) } catch { /* storage */ } }
function clearPinVault() { try { localStorage.removeItem(PIN_STORE) } catch { /* storage */ } }
const validPin = (p) => /^\d{4,6}$/.test(p)
let pendingKey = '' // unlocked by passphrase, waiting for a PIN to be set
let promptedLogin = false

function adminView() {
  if (aiEnabled()) return pendingKey ? 'pinset' : 'loggedin'
  if (loadPinVault()) return 'pinlogin'
  if (state.vault) return 'passphrase'
  return 'none'
}

async function openAiSettings(view) {
  await vaultReady
  const s = getAiSettings()
  const on = aiEnabled()
  const v = typeof view === 'string' ? view : adminView()
  $('#ai-admin').hidden = v === 'none'
  for (const id of ['pinlogin', 'passphrase', 'pinset', 'loggedin']) $(`#ai-${id}`).hidden = v !== id
  for (const id of ['ai-pin-status', 'ai-unlock-status', 'ai-pinset-status']) $(`#${id}`).textContent = '' // clear stale messages
  $('#ai-key').value = s.storedKey || '' // never expose the in-memory (PIN-protected) key
  $('#ai-model').value = s.model
  $('#ai-base').value = s.baseUrl
  $('#ai-max').value = s.maxMessages
  $('#ai-status').textContent = on ? 'AI features are on.'
    : v === 'pinlogin' ? 'Logged out — enter your PIN to turn AI on.'
    : v === 'passphrase' ? 'Locked — enter your admin passphrase.'
    : 'No key set — AI features are off.'
  $('#ai-advanced').open = v === 'none' && !on
  $('#ai-overlay').hidden = false
  const focus = { pinlogin: '#ai-pin', passphrase: '#ai-pass', pinset: '#ai-pin-new' }[v]
  if (focus) $(focus).focus()
}

// Prompt for the PIN automatically once a file is loaded (once per visit).
function maybePromptAdminLogin() {
  if (promptedLogin || aiEnabled() || !loadPinVault()) return
  promptedLogin = true
  openAiSettings('pinlogin')
}
function readAiForm() {
  return { key: $('#ai-key').value.trim(), baseUrl: $('#ai-base').value.trim() || undefined, model: $('#ai-model').value, maxMessages: $('#ai-max').value }
}
function updateAiButtons() {
  const on = aiEnabled()
  const btn = $('#ai-settings-btn')
  btn.textContent = on ? '🤖 AI on' : loadPinVault() ? '🔑 Admin login' : state.vault ? '🔒 Admin unlock' : '🤖 AI'
  btn.classList.toggle('ai-on', on)
}
async function unlockVault() {
  const pass = $('#ai-pass').value
  const st = $('#ai-unlock-status')
  if (!pass) { st.textContent = 'Enter your passphrase.'; return }
  st.textContent = 'Unlocking…'
  try {
    const key = await decryptVault(pass, state.vault)
    $('#ai-pass').value = ''
    st.textContent = ''
    pendingKey = key
    setSessionKey(key)
    clearAiKey() // the plaintext key is never kept in storage
    clearPinVault() // a fresh PIN is set next
    updateAiButtons()
    await openAiSettings('pinset')
    $('#ai-status').textContent = '✓ Unlocked — now set your PIN.'
  } catch (err) {
    st.textContent = `✗ ${err.message}`
  }
}
async function savePin() {
  const p1 = $('#ai-pin-new').value
  const p2 = $('#ai-pin-new2').value
  const st = $('#ai-pinset-status')
  const key = pendingKey || getAiSettings().key
  if (!validPin(p1)) { st.textContent = 'PIN must be 4–6 digits.'; return }
  if (p1 !== p2) { st.textContent = 'PINs do not match.'; return }
  if (!key) { st.textContent = 'Nothing to protect — unlock with the passphrase first.'; return }
  st.textContent = 'Saving…'
  const blob = await encryptVault(p1, key, PIN_ITER)
  savePinVault({ ...blob, attempts: 0 })
  clearAiKey()
  setSessionKey(key)
  pendingKey = ''
  $('#ai-pin-new').value = ''
  $('#ai-pin-new2').value = ''
  updateAiButtons()
  await openAiSettings('loggedin')
  $('#ai-status').textContent = '✓ PIN saved — you are logged in as admin.'
}
async function pinLogin() {
  const pin = $('#ai-pin').value
  const st = $('#ai-pin-status')
  const pv = loadPinVault()
  if (!pv) { openAiSettings('passphrase'); return }
  if (!validPin(pin)) { st.textContent = 'Enter your 4–6 digit PIN.'; return }
  st.textContent = 'Checking…'
  try {
    const key = await decryptVault(pin, pv)
    savePinVault({ ...pv, attempts: 0 })
    setSessionKey(key)
    $('#ai-pin').value = ''
    updateAiButtons()
    await openAiSettings('loggedin')
    $('#ai-status').textContent = '✓ Logged in as admin — AI features are on.'
  } catch {
    const attempts = (pv.attempts || 0) + 1
    $('#ai-pin').value = ''
    if (attempts >= PIN_MAX_ATTEMPTS) {
      clearPinVault()
      updateAiButtons()
      await openAiSettings('passphrase')
      $('#ai-status').textContent = '✗ Too many wrong PINs — the PIN was removed from this device. Enter your admin passphrase.'
    } else {
      savePinVault({ ...pv, attempts })
      const left = PIN_MAX_ATTEMPTS - attempts
      st.textContent = `✗ Wrong PIN (${left} attempt${left === 1 ? '' : 's'} left).`
      $('#ai-pin').focus()
    }
  }
}
$('#ai-settings-btn').addEventListener('click', openAiSettings)
$('#ai-close').addEventListener('click', () => { $('#ai-overlay').hidden = true })
$('#ai-overlay').addEventListener('click', (e) => { if (e.target.id === 'ai-overlay') $('#ai-overlay').hidden = true })
$('#ai-unlock').addEventListener('click', unlockVault)
$('#ai-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockVault() })
$('#ai-pin-login').addEventListener('click', pinLogin)
$('#ai-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') pinLogin() })
$('#ai-pin-forgot').addEventListener('click', () => openAiSettings('passphrase'))
$('#ai-pin-save').addEventListener('click', savePin)
$('#ai-pin-new2').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePin() })
$('#ai-pin-skip').addEventListener('click', async () => {
  const key = pendingKey || getAiSettings().key
  if (key) saveAiSettings({ key })
  pendingKey = ''
  updateAiButtons()
  await openAiSettings('loggedin')
  $('#ai-status').textContent = 'Unlocked — remembered on this device without a PIN.'
})
$('#ai-lock').addEventListener('click', async () => {
  setSessionKey('')
  clearAiKey()
  pendingKey = ''
  updateAiButtons()
  await openAiSettings()
  $('#ai-status').textContent = '🔒 Logged out — enter your PIN to log in again.'
})
$('#ai-pin-reset').addEventListener('click', async () => {
  clearPinVault()
  setSessionKey('')
  clearAiKey()
  pendingKey = ''
  updateAiButtons()
  await openAiSettings('passphrase')
  $('#ai-status').textContent = 'PIN removed — your passphrase is needed next time.'
})
$('#ai-save').addEventListener('click', () => {
  const f = readAiForm()
  if (!f.key) delete f.key // don't wipe/overwrite a PIN-protected key with an empty field
  saveAiSettings(f)
  $('#ai-status').textContent = aiEnabled() ? 'Saved — AI features are on.' : 'Saved — no key, AI features are off.'
  updateAiButtons()
})
$('#ai-clear').addEventListener('click', () => {
  clearAiKey()
  setSessionKey('')
  $('#ai-key').value = ''
  $('#ai-status').textContent = 'Key removed — AI features are off.'
  updateAiButtons()
})
$('#ai-test').addEventListener('click', async () => {
  const typed = $('#ai-key').value.trim()
  if (typed && typed !== getAiSettings().storedKey) saveAiSettings(readAiForm())
  else saveAiSettings({ baseUrl: $('#ai-base').value.trim() || undefined, model: $('#ai-model').value, maxMessages: $('#ai-max').value })
  updateAiButtons()
  $('#ai-status').textContent = 'Testing…'
  try {
    const r = await deepseekChat('Reply with the JSON object {"ok": true}.', { maxTokens: 30 })
    $('#ai-status').textContent = r.data && r.data.ok ? '✓ Connected to DeepSeek.' : `Connected, but unexpected reply: ${r.text.slice(0, 80)}`
  } catch (err) {
    $('#ai-status').textContent = `✗ ${err.message}`
  }
})
$('#vault-suggest').addEventListener('click', () => {
  const p = generatePassphrase()
  $('#vault-pass').value = p
  $('#vault-pass2').value = p
  $('#vault-pass').type = 'text'
  $('#vault-pass2').type = 'text'
})
$('#vault-make').addEventListener('click', async () => {
  const key = $('#ai-key').value.trim() || getAiSettings().key
  const p1 = $('#vault-pass').value
  const p2 = $('#vault-pass2').value
  if (!key) return alert('Enter the API key first (Advanced → API key), or unlock the current vault.')
  if (p1.length < 12) return alert('Use a passphrase of at least 12 characters — or click "Suggest strong passphrase".')
  if (p1 !== p2) return alert('The passphrases do not match.')
  const vault = await encryptVault(p1, key)
  downloadBlob('vault.json', 'application/json', JSON.stringify(vault, null, 2))
  alert('vault.json downloaded. Upload it to the site’s public/ folder (replacing the old one) and redeploy. Keep the passphrase safe — it cannot be recovered.')
})
updateAiButtons()

// Auto-logout the admin session after 30 minutes without activity (PIN mode).
const AUTO_LOGOUT_MS = 30 * 60 * 1000
let idleTimer = null
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (loadPinVault() && aiEnabled()) {
      setSessionKey('')
      clearAiKey()
      updateAiButtons()
    }
  }, AUTO_LOGOUT_MS)
}
for (const ev of ['mousemove', 'keydown', 'click', 'touchstart']) document.addEventListener(ev, resetIdleTimer, { passive: true })
resetIdleTimer()

function requireAi() {
  if (aiEnabled()) return true
  openAiSettings()
  return false
}

// Fetch bodies for message ids (batched); returns Map id -> plain text.
async function bodiesFor(ids) {
  const out = new Map()
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    const details = await requestDetails(batch)
    details.forEach((d, j) => out.set(batch[j], textOf(d)))
  }
  return out
}

function aiSheets(c) {
  const ai = state.ai?.dive?.[c.email]
  if (!ai || !ai.data) return []
  const d = ai.data
  const rows = [
    ['Summary', d.summary], ['Risk', `${d.risk || ''} — ${d.riskReason || ''}`], ['Sentiment', d.sentiment],
    ['Attention', d.attention?.assessment], ['Response quality', d.attention?.responseQuality],
    ['Unanswered refs', (d.attention?.unansweredRefs || []).join('; ')],
    ['Problems', (d.problems || []).map((p) => `[${p.ref}] ${p.severity} ${p.type}: ${p.issue}`).join('\n')],
    ['Financial', (d.financial || []).map((f) => `[${f.ref}] ${f.status}${f.amount ? ` ${f.amount}` : ''}: ${f.detail}`).join('\n')],
    ['Next actions', (d.nextActions || []).join('\n')],
    ['Model', ai.model], ['Generated', ai.when ? new Date(ai.when).toISOString() : ''],
  ].map(([k, v]) => ({ k, v: v == null ? '' : String(v) }))
  return [{ name: 'AI deep dive', rows, columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }] }]
}

// 1) Per-client deep dive — sends only this client's emails.
$('#tab-clients').addEventListener('click', async (e) => {
  if (!e.target.closest('#case-ai')) return
  const c = selectedClientObj()
  if (!c || !requireSession('AI deep dive') || !requireAi()) return
  const out = $('#case-ai-out')
  const btn = $('#case-ai')
  btn.disabled = true
  out.innerHTML = '<div class="ai-box"><span class="spinner-inline"></span> Reading this client’s emails and asking DeepSeek… (only this client’s thread is sent)</div>'
  try {
    const s = getAiSettings()
    const all = clientTimeline(c.email)
    if (!all.length) throw new Error('No messages for this client are in the message list — re-run with "Messages" ticked.')
    // Prefer the notable (flagged) messages, then the most recent, within the cap.
    const notable = new Set((c.refs || []).map((r) => r.ref))
    const picked = [...all.filter((m) => notable.has(m.ref)), ...all.filter((m) => !notable.has(m.ref)).slice(-s.maxMessages)]
    const seen = new Set()
    const tl = picked.filter((m) => !seen.has(m.id) && seen.add(m.id)).slice(0, s.maxMessages)
    tl.sort((a, b) => (a.date ? +new Date(a.date) : 0) - (b.date ? +new Date(b.date) : 0))
    const bodies = await bodiesFor(tl.map((m) => m.id))
    const msgs = tl.map((m) => ({ ...m, text: bodies.get(m.id) || '' }))
    const r = await deepseekChat(deepDivePrompt(c, msgs, clientComplaints(c.email), clientFinancial(c.email)), { maxTokens: 3000 })
    state.ai.dive[c.email] = { data: r.data, text: r.text, usage: r.usage, model: s.model, when: Date.now(), messagesSent: msgs.length }
    saveAi()
    out.innerHTML = renderAiDive(state.ai.dive[c.email])
  } catch (err) {
    out.innerHTML = `<div class="ai-box ai-error"><strong>AI deep dive failed:</strong> ${escapeHtml(err.message)}</div>`
  } finally {
    btn.disabled = false
  }
})

// 2) AI review of the keyword-flagged complaints — confirms or dismisses each.
$('#forensic-ai-review').addEventListener('click', async () => {
  if (!requireSession('AI review') || !requireAi()) return
  const records = (state.forensic?.complaints?.records || []).filter((c) => c.id != null)
  if (!records.length) return alert('No flagged complaints with readable bodies. Load with "Messages" ticked so bodies can be read.')
  const MAX = 200
  const todo = records.slice(0, MAX)
  const btn = $('#forensic-ai-review')
  const original = btn.textContent
  btn.disabled = true
  try {
    const bodies = await bodiesFor(todo.map((c) => c.id))
    const BATCH = 25
    for (let i = 0; i < todo.length; i += BATCH) {
      btn.textContent = `Reviewing ${Math.min(i + BATCH, todo.length)} / ${todo.length}…`
      const batch = todo.slice(i, i + BATCH).map((c) => ({ ...c, text: bodies.get(c.id) || '' }))
      const r = await deepseekChat(complaintsReviewPrompt(batch), { maxTokens: 3000 })
      for (const v of (r.data && r.data.results) || []) if (v && v.ref) state.ai.complaints[v.ref] = v
      saveAi()
    }
    renderForensic()
    const notC = todo.filter((c) => state.ai.complaints[c.ref]?.isComplaint === false).length
    alert(`AI reviewed ${todo.length} flagged complaint(s): ${todo.length - notC} confirmed, ${notC} judged not to be complaints.${todo.length < records.length ? ` (First ${MAX} only.)` : ''}\n\nUse "Apply AI dismissals" to mark the non-complaints as Dismissed in triage.`)
  } catch (err) {
    alert(`AI review failed: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.textContent = original
  }
})
$('#forensic-ai-apply').addEventListener('click', () => {
  let k = 0
  for (const [ref, v] of Object.entries(state.ai?.complaints || {})) {
    if (v.isComplaint === false && (triageOf(ref).status || 'open') === 'open') {
      state.triage = state.triage || {}
      state.triage[ref] = { status: 'dismissed', note: `AI: not a complaint${v.problem ? ` — ${v.problem}` : ''}` }
      k++
    }
  }
  saveTriage()
  renderForensic()
  alert(k ? `${k} complaint(s) marked Dismissed (false positive) from the AI review.` : 'Nothing to apply — run "🤖 Review complaints" first, or all AI dismissals are already applied.')
})

// Period filter (complaints, financial register, trends).
function periodComplaints() {
  return (withPeriod(state.forensic, state.period)?.complaints?.records) || []
}
function applyPeriod() {
  const from = $('#period-from').value ? new Date($('#period-from').value + 'T00:00:00').getTime() : null
  const to = $('#period-to').value ? new Date($('#period-to').value + 'T23:59:59').getTime() : null
  state.period = from || to ? { from, to } : null
  const cp = state.period ? periodComplaints().length : 0
  $('#period-note').textContent = state.period ? `${cp.toLocaleString()} complaint(s) in period` : ''
  renderForensic()
}
$('#period-apply').addEventListener('click', applyPeriod)
$('#period-clear').addEventListener('click', () => { $('#period-from').value = ''; $('#period-to').value = ''; applyPeriod() })

// 2b) AI executive summary across all clients.
$('#forensic-ai-exec').addEventListener('click', async () => {
  if (!state.forensic || !requireSession('Executive summary') || !requireAi()) return
  const btn = $('#forensic-ai-exec')
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = 'Briefing…'
  try {
    const s = getAiSettings()
    const r = await deepseekChat(executiveSummaryPrompt(state.forensic, state.forensic.complaints.records, { fileName: state.fileName }), { maxTokens: 3500 })
    state.ai.exec = { data: r.data, text: r.text, usage: r.usage, model: s.model, when: Date.now() }
    saveAi()
    renderForensic()
    $('#forensic-report').scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (err) {
    state.ai.exec = { error: err.message, when: Date.now() }
    renderForensic()
  } finally {
    btn.disabled = false
    btn.textContent = original
  }
})

// 3) Ask the mailbox — retrieves matching emails by keyword, then asks.
async function askMailbox() {
  const q = $('#ask-input').value.trim()
  const out = $('#ask-out')
  if (!q || !requireSession('Ask the mailbox') || !requireAi()) return
  if (!state.messages.length) {
    out.hidden = false
    out.innerHTML = '<div class="ai-box">Asking needs the message list — re-run with <em>Messages</em> ticked.</div>'
    return
  }
  const btn = $('#ask-btn')
  btn.disabled = true
  out.hidden = false
  out.innerHTML = '<div class="ai-box"><span class="spinner-inline"></span> Finding relevant emails and asking DeepSeek…</div>'
  try {
    const score = new Map()
    for (const kw of keywordsOf(q)) {
      const res = await requestWorker('search', { query: kw, limit: 40 })
      for (const h of res.hits) score.set(h.id, (score.get(h.id) || 0) + 1)
    }
    let ids = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([id]) => id)
    if (!ids.length) ids = (state.forensic?.complaints?.records || []).filter((c) => c.id != null).slice(0, 10).map((c) => c.id)
    if (!ids.length) { out.innerHTML = '<div class="ai-box">No emails matched the words in your question — try different keywords.</div>'; return }
    const bodies = await bodiesFor(ids)
    const msgs = ids.map((id) => {
      const m = state.messages[id]
      return { ref: m.ref, dir: /(^|\/)sent/i.test(m.folderPath || '') ? 'out' : 'in', date: m.date, subject: m.subject, from: m.senderEmail || m.senderName, text: bodies.get(id) || '' }
    })
    const r = await deepseekChat(askPrompt(q, msgs), { maxTokens: 2000 })
    const a = r.data || {}
    const html = escapeHtml(a.answer || r.text || '').replace(/\n/g, '<br />').replace(/\[(M\d{6})\]/g, (_, ref) => `[<span class="fx-ref fx-ref-link" data-open-ref="${ref}">${ref}</span>]`)
    out.innerHTML = `<div class="ai-box"><div class="ai-head"><h4>🤖 Answer</h4><span class="fx-muted">confidence: ${escapeHtml(a.confidence || '—')} · ${ids.length} email(s) sent</span></div><p>${html}</p></div>`
  } catch (err) {
    out.innerHTML = `<div class="ai-box ai-error"><strong>Ask failed:</strong> ${escapeHtml(err.message)}</div>`
  } finally {
    btn.disabled = false
  }
}
$('#ask-btn').addEventListener('click', askMailbox)
$('#ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') askMailbox() })

// Open a message from an exhibit ref cited in AI output.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-open-ref]')
  if (!el) return
  const m = state.messages.find((x) => x.ref === el.dataset.openRef)
  if (m) openViewer(m.id)
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

function clientFinancial(email) {
  return (state.forensic?.financial?.records || []).filter((r) => r.client === email)
}

function renderClients() {
  const view = $('#clients-view')
  if (!view || !state.forensic) return
  view.innerHTML = renderClientsView(state.forensic.clients, { query: state.clientQuery }) + renderStaffView(state.forensic.staff)
  renderClientCase()
}

function renderClientCase() {
  const box = $('#client-case')
  if (!box) return
  const c = selectedClientObj()
  if (!c) { box.hidden = true; box.innerHTML = ''; return }
  box.innerHTML = renderCaseFile(c, clientTimeline(c.email), clientComplaints(c.email), { ai: state.ai.dive[c.email] || null, financial: clientFinancial(c.email) })
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
  { key: 'ref', label: 'Triage status', format: (c) => TRIAGE_TEXT[triageOf(c.ref).status] || 'Open' },
  { key: 'ref', label: 'Triage note', format: (c) => triageOf(c.ref).note || '' },
  { key: 'ref', label: 'AI verdict', format: (c) => { const v = state.ai?.complaints?.[c.ref]; return v ? (v.isComplaint === false ? 'Not a complaint' : `Complaint (${v.severity || ''} ${v.type || ''})`.replace(/\s+\)/, ')')) : '' } },
  { key: 'ref', label: 'AI problem', format: (c) => state.ai?.complaints?.[c.ref]?.problem || '' },
]

const AUDIT_COLUMNS = [
  { key: 'severity', label: 'Severity', format: (f) => f.severity.toUpperCase() },
  { key: 'category', label: 'Category' },
  { key: 'title', label: 'Finding' },
  { key: 'detail', label: 'Detail / recommendation' },
  { key: 'samples', label: 'Evidence items', format: (f) => (f.samples ? f.samples.length : 0) },
  { key: 'samples', label: 'Evidence refs', format: (f) => (f.samples || []).map((s) => s.ref).filter(Boolean).join('; ') },
  { key: 'title', label: 'Triage status', format: (f) => TRIAGE_TEXT[triageOf(findingKey(f)).status] || 'Open' },
  { key: 'title', label: 'Triage note', format: (f) => triageOf(findingKey(f)).note || '' },
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

const FIN_COLUMNS = [
  { key: 'ref', label: 'Ref' },
  { key: 'date', label: 'Date', format: (r) => (r.date ? new Date(r.date).toISOString() : '') },
  { key: 'dir', label: 'Direction', format: (r) => (r.dir === 'in' ? 'From client' : r.dir === 'out' ? 'To client' : '') },
  { key: 'from', label: 'From' },
  { key: 'client', label: 'Client' },
  { key: 'subject', label: 'Subject' },
  { key: 'amounts', label: 'Amounts', format: (r) => r.amounts.map((a) => `${a.currency} ${a.value}`).join('; ') },
  { key: 'invoices', label: 'Invoice / reference', format: (r) => r.invoices.join('; ') },
  { key: 'dueDates', label: 'Due dates', format: (r) => r.dueDates.join('; ') },
  { key: 'status', label: 'Status' },
  { key: 'snippet', label: 'Context' },
  { key: 'folder', label: 'Folder' },
  { key: 'messageId', label: 'Message-ID' },
]

const STAFF_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'internal', label: 'Our staff', format: (s) => (s.internal ? 'Yes' : 'No') },
  { key: 'sent', label: 'Replies sent' },
  { key: 'clients', label: 'Clients handled' },
  { key: 'answered', label: 'Answered' },
  { key: 'unanswered', label: 'Unanswered (owned)' },
  { key: 'medianResponseHours', label: 'Median response (hours)' },
]

const TREND_COLUMNS = [
  { key: 'month', label: 'Month' },
  { key: 'inbound', label: 'From clients' },
  { key: 'outbound', label: 'To clients' },
  { key: 'complaints', label: 'Complaints' },
  { key: 'medianResponseHours', label: 'Median response (hours)' },
]
function trendRows(t) {
  return ((t && t.months) || []).map((m) => ({ month: m, inbound: t.inbound[m] || 0, outbound: t.outbound[m] || 0, complaints: t.complaints[m] || 0, medianResponseHours: t.medianResponseHours[m] }))
}

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
    { name: 'Financial Register', rows: f.financial?.records || [], columns: FIN_COLUMNS },
    { name: 'Staff', rows: f.staff?.list || [], columns: STAFF_COLUMNS },
    { name: 'Trends', rows: trendRows(f.trends), columns: TREND_COLUMNS },
  ]
}

const MAX_PACK_FILES = 150
const MAX_PACK_BYTES = 200 * 1024 * 1024

// Evidence pack: the client's case file + registers + every attachment, zipped.
async function evidencePack(btn) {
  const c = selectedClientObj()
  if (!c) return alert('Click a client row first to open their case file.')
  if (!requireSession('Evidence pack')) return
  const original = btn ? btn.textContent : ''
  if (btn) { btn.disabled = true; btn.textContent = 'Packing…' }
  try {
    const timeline = clientTimeline(c.email)
    const complaints = clientComplaints(c.email)
    const financial = clientFinancial(c.email)
    const base = safeZipName(c.name || c.email, 'client')
    const entries = []
    entries.push({
      name: `${base}/case-file.html`,
      data: buildForensicHtmlDoc(null, state.fileName, {
        title: `Client case file — ${c.name || c.email}`,
        body: renderCaseFile(c, timeline, complaints, { print: true, ai: state.ai.dive[c.email] || null, financial }),
      }),
    })
    if (complaints.length) entries.push({ name: `${base}/complaints.csv`, data: buildCsv(complaints, COMPLAINT_COLUMNS) })
    if (financial.length) entries.push({ name: `${base}/financial.csv`, data: buildCsv(financial, FIN_COLUMNS) })
    if (timeline.length) entries.push({ name: `${base}/timeline.csv`, data: buildCsv(timeline, TIMELINE_COLUMNS) })

    // Attachments from this client's messages.
    const withAtt = timeline.filter((m) => m.hasAttachments && m.id != null)
    const manifest = [['Ref', 'Date', 'Direction', 'Subject', 'Attachment', 'Size', 'Saved as'].join(',')]
    let files = 0
    let bytes = 0
    let truncated = false
    for (const m of withAtt) {
      if (files >= MAX_PACK_FILES || bytes >= MAX_PACK_BYTES) { truncated = true; break }
      if (btn) btn.textContent = `Packing ${files} file(s)…`
      let list
      try { list = (await requestWorker('attachments', { id: m.id })).attachments } catch { continue }
      for (const a of list) {
        if (a.embedded) continue
        if (files >= MAX_PACK_FILES || bytes >= MAX_PACK_BYTES) { truncated = true; break }
        let res
        try { res = await requestWorker('attachment', { id: m.id, index: a.index }) } catch { continue }
        const data = new Uint8Array(res.data)
        const saved = `${base}/attachments/${m.ref || 'msg'}_${safeZipName(res.name || a.name || `attachment-${a.index + 1}`)}`
        entries.push({ name: saved, data })
        files++
        bytes += data.length
        manifest.push([m.ref || '', m.date ? new Date(m.date).toISOString() : '', m.dir === 'in' ? 'From client' : 'To client', csvq(m.subject), csvq(res.name || a.name || ''), data.length, csvq(saved)].join(','))
      }
    }
    entries.push({ name: `${base}/attachments-manifest.csv`, data: '﻿' + manifest.join('\r\n') })
    entries.push({ name: `${base}/README.txt`, data: `Evidence pack for ${c.name || c.email} <${c.email}>\nSource: ${state.sources.join(', ')}\nGenerated: ${new Date().toLocaleString()}\n\n${files} attachment file(s), ${timeline.length} message(s) in timeline, ${complaints.length} complaint(s).${truncated ? `\n\nNOTE: attachment set was capped at ${MAX_PACK_FILES} files / ${Math.round(MAX_PACK_BYTES / 1048576)} MB.` : ''}\n\nGenerated by Timeless Outlook Extractor — craftedbytimeless.com` })

    const blob = makeZip(entries)
    downloadBlob(`${exportBase()}-evidence-${base}.zip`, 'application/zip', blob)
    if (truncated) alert(`Evidence pack ready. Attachments were capped at ${MAX_PACK_FILES} files / ${Math.round(MAX_PACK_BYTES / 1048576)} MB — narrow with a period filter or contact us to raise the limit.`)
  } catch (err) {
    alert(`Could not build the evidence pack: ${err.message}`)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original }
  }
}
function csvq(v) { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }

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
    downloadBlob(`${exportBase()}-forensic-report.html`, 'text/html;charset=utf-8', buildForensicHtmlDoc(state.forensic, state.fileName, { triage: state.triage, ai: state.ai.complaints, exec: state.ai.exec, period: state.period }))
  },
  'forensic-json': () => {
    if (!state.forensic) return
    exportJson(`${exportBase()}-forensic-report.json`, { file: state.fileName, generated: new Date().toISOString(), report: state.forensic })
  },
  'forensic-pdf': () => {
    if (!state.forensic) return
    printHtml(buildForensicHtmlDoc(state.forensic, state.fileName, { triage: state.triage, ai: state.ai.complaints, exec: state.ai.exec, period: state.period }))
  },
  'forensic-word': () => {
    if (!state.forensic) return
    exportDoc(`${exportBase()}-forensic-report.doc`, buildForensicHtmlDoc(state.forensic, state.fileName, { triage: state.triage, ai: state.ai.complaints, exec: state.ai.exec, period: state.period }))
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
      { name: 'Financial', rows: clientFinancial(c.email), columns: FIN_COLUMNS },
      ...aiSheets(c),
    ])
  },
  'case-word': () => {
    const c = selectedClientObj()
    if (!c) return alert('Click a client row first to open their case file.')
    exportDoc(`${exportBase()}-client-${safeFilename(c.email)}.doc`, buildForensicHtmlDoc(null, state.fileName, {
      title: `Client case file — ${c.name || c.email}`,
      body: renderCaseFile(c, clientTimeline(c.email), clientComplaints(c.email), { print: true, ai: state.ai.dive[c.email] || null, financial: clientFinancial(c.email) }),
    }))
  },
  'case-pdf': () => {
    const c = selectedClientObj()
    if (!c) return alert('Click a client row first to open their case file.')
    printHtml(buildForensicHtmlDoc(null, state.fileName, {
      title: `Client case file — ${c.name || c.email}`,
      body: renderCaseFile(c, clientTimeline(c.email), clientComplaints(c.email), { print: true, ai: state.ai.dive[c.email] || null, financial: clientFinancial(c.email) }),
    }))
  },
  'case-zip': (btn) => evidencePack(btn),
  'complaints-csv': () => {
    const rows = periodComplaints()
    if (!rows.length) return alert('No complaints detected to export.')
    exportCsv(`${exportBase()}-complaints.csv`, rows, COMPLAINT_COLUMNS)
  },
  'complaints-xlsx': () => {
    const rows = periodComplaints()
    if (!rows.length) return alert('No complaints detected to export.')
    exportXlsx(`${exportBase()}-complaints.xlsx`, rows, COMPLAINT_COLUMNS, 'Complaints')
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
