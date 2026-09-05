// E2E: admin PIN login flow against a mocked DeepSeek endpoint.
// Expected key is derived by decrypting public/vault.json with the passphrase
// in /tmp/vault_pass.txt — no secrets on the command line.
import { preview } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import { decryptVault } from '../src/vault.js'

const PASS = fs.readFileSync('/tmp/vault_pass.txt', 'utf8').trim()
const EXPECT_KEY = await decryptVault(PASS, JSON.parse(fs.readFileSync('public/vault.json', 'utf8')))
const PST = 'node_modules/pst-extractor/example/testdata/enron.pst'

const server = await preview({ preview: { port: 4209, strictPort: true } })
const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage({ viewport: { width: 1300, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
let authSeen = null
await page.route('**/chat/completions', async (route) => {
  authSeen = route.request().headers()['authorization']
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '{"ok": true}' } }], usage: { total_tokens: 5 } }) })
})
const load = async () => {
  await page.check('#scope-forensic')
  await page.setInputFiles('#file-input', PST)
  await page.waitForSelector('#results-screen:not([hidden])', { timeout: 60000 })
}
const btn = () => page.$eval('#ai-settings-btn', (b) => b.textContent)
const vis = (id) => page.$eval(id, (e) => !e.hidden && !e.closest('[hidden]'))

await page.goto('http://localhost:4209/')
await page.evaluate(() => localStorage.clear())
await page.reload()
await load()
await page.waitForFunction(() => /Admin unlock/.test(document.querySelector('#ai-settings-btn').textContent), null, { timeout: 5000 })
await page.click('#ai-settings-btn')
console.log('1 first visit → passphrase view:', await vis('#ai-passphrase'), '| btn:', await btn())

await page.fill('#ai-pass', PASS)
await page.click('#ai-unlock')
await page.waitForSelector('#ai-pinset:not([hidden])', { timeout: 15000 })
console.log('2 after passphrase → set-PIN view:', await vis('#ai-pinset'))

await page.fill('#ai-pin-new', '2468')
await page.fill('#ai-pin-new2', '2468')
await page.click('#ai-pin-save')
await page.waitForSelector('#ai-loggedin:not([hidden])', { timeout: 15000 })
const stor = await page.evaluate(() => ({ plaintextKey: !!localStorage.getItem('tox-ai-key'), pinVault: !!localStorage.getItem('tox-ai-pin') }))
console.log('3 PIN saved → logged in | btn:', await btn(), '| storage:', JSON.stringify(stor))

await page.click('#ai-advanced summary')
await page.click('#ai-test')
await page.waitForFunction(() => /Connected/.test(document.querySelector('#ai-status').textContent), null, { timeout: 5000 })
console.log('4 API call uses vault key:', authSeen === `Bearer ${EXPECT_KEY}`)
await page.click('#ai-close')

await page.reload()
await load()
await page.waitForSelector('#ai-overlay:not([hidden])', { timeout: 8000 })
console.log('5 new visit → auto PIN prompt:', await vis('#ai-pinlogin'), '| btn:', await btn())

await page.fill('#ai-pin', '0000')
await page.click('#ai-pin-login')
await page.waitForFunction(() => /Wrong PIN/.test(document.querySelector('#ai-pin-status').textContent), null, { timeout: 15000 })
console.log('6 wrong PIN:', await page.$eval('#ai-pin-status', (e) => e.textContent))

await page.fill('#ai-pin', '2468')
await page.click('#ai-pin-login')
await page.waitForSelector('#ai-loggedin:not([hidden])', { timeout: 15000 })
console.log('7 right PIN → logged in | btn:', await btn())
await page.screenshot({ path: 'docs/admin-pin.png', clip: { x: 300, y: 120, width: 700, height: 420 } })

await page.click('#ai-lock')
await page.waitForTimeout(150)
console.log('8 log out → btn:', await btn(), '| view pinlogin:', await vis('#ai-pinlogin'))

for (let k = 1; k <= 5; k++) {
  await page.fill('#ai-pin', '1111')
  await page.click('#ai-pin-login')
  // Wait for THIS attempt's outcome: "N attempt(s) left" counting down, then the wipe message.
  const expect = k < 5 ? `(${5 - k} attempt` : 'Too many'
  await page.waitForFunction((t) => (document.querySelector('#ai-pin-status').textContent + document.querySelector('#ai-status').textContent).includes(t), expect, { timeout: 20000 })
}
console.log('9 after 5 wrong → passphrase view:', await vis('#ai-passphrase'), '| pin vault removed:', await page.evaluate(() => !localStorage.getItem('tox-ai-pin')), '| status:', (await page.$eval('#ai-status', (e) => e.textContent)).slice(0, 62))
console.log('ERRORS:', errors.length ? errors : 'none')
await ctx.close()
await browser.close()
await server.close()
