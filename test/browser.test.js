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

  // --- Accessibility: keyboard tab nav + modal focus handling ---
  await page.click('.tab[data-tab="addresses"]')
  await page.focus('#tabbtn-addresses')
  await page.keyboard.press('ArrowRight')
  const arrowTab = await page.evaluate(() => document.querySelector('.tab[aria-selected="true"]').dataset.tab)
  assert.equal(arrowTab, 'messages', `ArrowRight should activate messages, got ${arrowTab}`)
  const arrowFocus = await page.evaluate(() => document.activeElement?.dataset?.tab)
  assert.equal(arrowFocus, 'messages', 'focus should follow arrow-key tab navigation')
  // Opening a message moves focus into the dialog; Escape closes it
  await page.click('.tab[data-tab="messages"]')
  await page.click('#message-table tbody tr')
  await page.waitForSelector('#viewer-overlay:not([hidden])')
  const focusInDialog = await page.evaluate(() => document.querySelector('#viewer-overlay').contains(document.activeElement))
  assert.ok(focusInDialog, 'focus should move into the viewer dialog on open')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector('#viewer-overlay').hidden, null, { timeout: 5000 })
  await page.click('.tab[data-tab="addresses"]')

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

  // --- Forensic report + Clients combined view (second scenario) ---
  const page2 = await browser.newPage()
  const errs2 = []
  page2.on('pageerror', (err) => errs2.push(err.message))
  await page2.goto('http://localhost:4173/')
  await page2.fill('#scope-domains', 'enron.com')
  await page2.check('#scope-forensic')
  await page2.check('#scope-deepscan')
  await page2.setInputFiles('#file-input', FIXTURE)
  await page2.waitForSelector('#results-screen:not([hidden])', { timeout: 60000 })
  // Forensic tab shows the key sections
  await page2.click('.tab[data-tab="forensic"]')
  await page2.waitForSelector('#forensic-report .fx-section', { timeout: 15000 })
  const sections = await page2.$$eval('#forensic-report .fx-section > h3', (hs) => hs.map((h) => h.textContent))
  for (const want of ['Audit findings', 'Systemic problems', 'Financial register', 'Client complaints']) {
    assert.ok(sections.some((t) => t.includes(want)), `forensic report missing section: ${want}`)
  }
  // Clients tab: add a second mailbox and confirm the combined count grows
  await page2.click('.tab[data-tab="clients"]')
  const clientsBefore = await page2.$$eval('#clients-view .cl-row[data-client]', (r) => r.length)
  assert.ok(clientsBefore > 0, 'expected clients before combine')
  await page2.setInputFiles('#add-file-input', 'node_modules/pst-extractor/example/testdata/pstextractortest@outlook.com.ost')
  await page2.waitForFunction(() => /2 mailboxes/.test(document.querySelector('#file-summary').textContent), null, { timeout: 60000 })
  await page2.click('.tab[data-tab="clients"]')
  const clientsAfter = await page2.$$eval('#clients-view .cl-row[data-client]', (r) => r.length)
  assert.ok(clientsAfter > clientsBefore, `combined view should add clients (${clientsBefore} -> ${clientsAfter})`)
  // Open a client case file, then export the forensic workbook
  const fxDownloads = []
  page2.on('download', (d) => fxDownloads.push(d.suggestedFilename()))
  await page2.click('#clients-view .cl-row[data-client]')
  await page2.waitForSelector('#client-case:not([hidden])', { timeout: 10000 })
  await page2.click('.tab[data-tab="forensic"]')
  await page2.click('[data-export="forensic-xlsx"]')
  await page2.waitForTimeout(1500)
  assert.ok(fxDownloads.length >= 1, 'forensic workbook should download')
  assert.deepEqual(errs2, [], `forensic page errors: ${errs2.join('; ')}`)
  console.log('Forensic + Clients scenario passed. Sections:', sections.length, '| clients', clientsBefore, '->', clientsAfter)

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`)
  await page.screenshot({ path: 'test/screenshot.png', fullPage: true })
  console.log('Browser test passed.')
} finally {
  await browser.close()
  await server.close()
}
