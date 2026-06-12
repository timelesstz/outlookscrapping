// End-to-end check: serve the production build, upload the sample PST through
// the real UI, and verify all three tabs populate. Run with: node test/browser.test.js
import assert from 'node:assert/strict'
import { preview } from 'vite'
import { chromium } from 'playwright'

const FIXTURE = 'node_modules/pst-extractor/example/testdata/enron.pst'

const server = await preview({ preview: { port: 4173, strictPort: true } })
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  await page.goto('http://localhost:4173/')
  assert.equal(await page.title(), 'Timeless Outlook Extractor')

  await page.setInputFiles('#file-input', FIXTURE)
  await page.waitForSelector('#results-screen:not([hidden])', { timeout: 60000 })

  const summary = await page.textContent('#file-summary')
  console.log('Summary:', summary.trim())
  assert.match(summary, /50 unique addresses/)
  assert.match(summary, /71 messages/)

  const addressRows = await page.locator('#address-table tbody tr').count()
  assert.ok(addressRows > 10, `expected address rows, got ${addressRows}`)

  // Messages tab: open the first message and wait for its body to load
  await page.click('.tab[data-tab="messages"]')
  await page.click('#message-table tbody tr')
  await page.waitForSelector('#viewer-overlay:not([hidden])')
  await page.waitForFunction(() => {
    const text = document.querySelector('#viewer-body-text')
    const html = document.querySelector('#viewer-body-html')
    return (!text.hidden && text.textContent !== 'Loading…') || !html.hidden
  }, { timeout: 30000 })
  const subject = await page.textContent('#viewer-subject')
  console.log('Opened message:', subject.trim())
  await page.keyboard.press('Escape')

  // Exports produce downloads
  const downloads = []
  page.on('download', (d) => downloads.push(d.suggestedFilename()))
  await page.click('.tab[data-tab="addresses"]')
  await page.click('[data-export="addresses-csv"]')
  await page.click('[data-export="addresses-xlsx"]')
  await page.click('[data-export="addresses-txt"]')
  await page.waitForFunction(() => true) // flush event loop
  await page.waitForTimeout(1500)
  console.log('Downloads:', downloads)
  assert.equal(downloads.length, 3, `expected 3 downloads, got ${downloads.length}`)

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`)
  await page.screenshot({ path: 'test/screenshot.png', fullPage: true })
  console.log('Browser test passed.')
} finally {
  await browser.close()
  await server.close()
}
