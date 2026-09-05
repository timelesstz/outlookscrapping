import { Buffer } from 'buffer'
import { PstSession } from './extract.js'

let session = null

self.onmessage = (e) => {
  const data = e.data
  try {
    if (data.type === 'parse') {
      // Prefer the File (streamed in slices, any size); fall back to a
      // transferred buffer for callers that still send one.
      const source = data.file ? data.file : Buffer.from(data.buffer)
      session = new PstSession(source)
      const result = session.parse((progress) => {
        self.postMessage({ type: 'progress', ...progress })
      }, data.scope)
      self.postMessage({ type: 'parsed', ...result })
    } else if (data.type === 'details') {
      if (!session) throw new Error('No PST file loaded')
      self.postMessage({
        type: 'details',
        reqId: data.reqId,
        details: session.getDetails(data.ids),
      })
    } else if (data.type === 'search') {
      if (!session) throw new Error('No PST file loaded')
      self.postMessage({ type: 'search', reqId: data.reqId, ...session.searchBodies(data.query, { limit: data.limit }) })
    } else if (data.type === 'attachments') {
      if (!session) throw new Error('No PST file loaded')
      self.postMessage({ type: 'attachments', reqId: data.reqId, attachments: session.getAttachments(data.id) })
    } else if (data.type === 'attachment') {
      if (!session) throw new Error('No PST file loaded')
      const att = session.getAttachment(data.id, data.index)
      self.postMessage({ type: 'attachment', reqId: data.reqId, name: att.name, mime: att.mime, size: att.size, data: att.data }, [att.data])
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      reqId: data.reqId,
      message: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : '',
    })
  }
}
