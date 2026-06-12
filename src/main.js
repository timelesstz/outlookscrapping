import './styles.css'
import { exportCsv, exportXlsx, exportTxt, exportJson, buildEml, downloadBlob, safeFilename } from './exporters.js'

const $ = (sel) => document.querySelector(sel)

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
        showUploadError(`Could not read this file: ${data.message}`)
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
  if (file.size > 500 * 1024 * 1024) {
    $('#parse-message').textContent = 'Large file — this may take a while or run out of memory…'
  }
  state.fileName = file.name
  dropZone.hidden = true
  $('#parse-status').hidden = false
  $('#parse-message').textContent = `Reading ${file.name}…`
  try {
    const buffer = await file.arrayBuffer()
    worker.postMessage({ type: 'parse', buffer }, [buffer])
  } catch (err) {
    showUploadError(`Could not read this file: ${err.message}`)
  }
}

function showUploadError(message) {
  $('#parse-status').hidden = true
  dropZone.hidden = false
  const el = $('#upload-error')
  el.textContent = message
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
  state.selectedFolderId = null
  state.addressLimit = 500
  state.messageLimit = 500

  $('#upload-screen').hidden = true
  $('#results-screen').hidden = false
  $('#file-summary').innerHTML =
    `<strong>${escapeHtml(state.fileName)}</strong> — ` +
    `${state.addresses.length.toLocaleString()} unique addresses, ` +
    `${state.messages.length.toLocaleString()} messages, ` +
    `${state.contacts.length.toLocaleString()} contacts in ${state.folders.length} folders`
  $('#count-addresses').textContent = state.addresses.length.toLocaleString()
  $('#count-messages').textContent = state.messages.length.toLocaleString()
  $('#count-contacts').textContent = state.contacts.length.toLocaleString()

  renderAddresses()
  renderFolderTree()
  renderMessages()
  renderContacts()
}

// Tabs
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn))
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.hidden = p.id !== `tab-${btn.dataset.tab}`
    })
  })
})

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

function exportBase() {
  return safeFilename(state.fileName.replace(/\.(pst|ost)$/i, ''), 'outlook')
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
