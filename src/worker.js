import { Buffer } from 'buffer'
import { PstSession } from './extract.js'

let session = null

self.onmessage = (e) => {
  const data = e.data
  try {
    if (data.type === 'parse') {
      session = new PstSession(Buffer.from(data.buffer))
      const result = session.parse((progress) => {
        self.postMessage({ type: 'progress', ...progress })
      })
      self.postMessage({ type: 'parsed', ...result })
    } else if (data.type === 'details') {
      if (!session) throw new Error('No PST file loaded')
      self.postMessage({
        type: 'details',
        reqId: data.reqId,
        details: session.getDetails(data.ids),
      })
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      reqId: data.reqId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
