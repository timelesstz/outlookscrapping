import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { PstSession, isValidEmail } from '../src/extract.js'

// Sample mailboxes shipped with the pst-extractor package
const FIXTURES = [
  'node_modules/pst-extractor/example/testdata/enron.pst',
  'node_modules/pst-extractor/example/testdata/pstextractortest@outlook.com.ost',
]

assert.ok(isValidEmail('john.doe@example.com'))
assert.ok(!isValidEmail('/O=ENRON/OU=NA/CN=RECIPIENTS/CN=JDOE'))
assert.ok(!isValidEmail(''))
assert.ok(!isValidEmail('no-at-sign'))
assert.ok(!isValidEmail('IMCEANOTES-+22Jim+20Lokay+22@ENRON.com'))

for (const fixture of FIXTURES) {
  if (!existsSync(fixture)) {
    console.warn(`SKIP ${fixture} (fixture not found)`)
    continue
  }
  const session = new PstSession(readFileSync(fixture))
  let progressCalls = 0
  const result = session.parse(() => progressCalls++)

  assert.ok(result.folders.length > 1, `${fixture}: expected folders`)
  assert.ok(result.messages.length > 0, `${fixture}: expected messages`)
  assert.ok(result.addresses.length > 0, `${fixture}: expected harvested addresses`)
  for (const addr of result.addresses) {
    assert.ok(isValidEmail(addr.email), `${fixture}: invalid harvested address: ${addr.email}`)
    assert.equal(addr.total, addr.sent + addr.received)
  }
  const withDates = result.messages.filter((m) => m.date instanceof Date)
  assert.ok(withDates.length > 0, `${fixture}: expected message dates`)

  // Lazy body fetch for the first few messages
  const ids = result.messages.slice(0, 5).map((m) => m.id)
  const details = session.getDetails(ids)
  assert.equal(details.length, ids.length)
  assert.ok(
    details.some((d) => d.body.length > 0 || d.bodyHTML.length > 0),
    `${fixture}: expected at least one non-empty body`
  )

  console.log(
    `OK ${fixture}: ${result.folders.length} folders, ${result.messages.length} messages, ` +
    `${result.contacts.length} contacts, ${result.addresses.length} unique addresses ` +
    `(${progressCalls} progress events)`
  )
}

console.log('Smoke test passed.')
