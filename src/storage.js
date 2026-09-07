// Save/resume finished analyses in IndexedDB so reopening a mailbox is instant.
// Only the analysis (report + message summaries, no bodies) is stored, locally
// in this browser. Reading a body/attachment or running AI needs the file
// re-attached.
const DB = 'tox-analyses'
const STORE = 'analyses'

function open() {
  return new Promise((resolve, reject) => {
    let req
    try { req = indexedDB.open(DB, 1) } catch (e) { reject(e); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'signature' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx(mode, fn) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const store = t.objectStore(STORE)
    const out = fn(store)
    t.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : out) }
    t.onerror = () => { db.close(); reject(t.error) }
    t.onabort = () => { db.close(); reject(t.error) }
  })
}

export async function saveAnalysis(record) {
  try { await tx('readwrite', (s) => s.put(record)); return true } catch { return false }
}

export async function listAnalyses() {
  try {
    const items = await tx('readonly', (s) => {
      const r = s.getAll()
      return r
    })
    const arr = Array.isArray(items) ? items : []
    // Return light metadata only (no huge payloads) for the resume list.
    return arr.map((a) => ({ signature: a.signature, savedAt: a.savedAt, sources: a.sources, scope: a.scope, fileName: a.fileName, counts: a.counts }))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
  } catch { return [] }
}

export async function loadAnalysis(signature) {
  try { return await tx('readonly', (s) => s.get(signature)) } catch { return null }
}

export async function deleteAnalysis(signature) {
  try { await tx('readwrite', (s) => s.delete(signature)); return true } catch { return false }
}

export function signatureOf(sources) {
  return (sources || []).map((s) => String(s).toLowerCase()).sort().join(' + ') || 'unnamed'
}
