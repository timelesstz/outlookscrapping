# PROJECT_AUDIT.md — Timeless Outlook Extractor

Persistent audit & recovery ledger. Updated after each batch so the state of the
project is never re-discovered from zero.

- **Last pass:** 2026-10-04
- **Branch:** `claude/ecstatic-pasteur-w4fot3`
- **Baseline at audit start:** build ✅, `npm test` ✅ (smoke: 2 sample mailboxes), deploy #23 green.

---

## 1. Project understanding

**What it is.** A 100%-client-side single-page web app (Vite + vanilla JS) that
extracts and investigates Microsoft Outlook **PST/OST** files entirely in the
browser. No backend, no database, no server-side auth, no payments. The file is
parsed in a Web Worker via `pst-extractor`, streamed in 1 MiB slices so
multi-GB files never load fully into memory. Hosted as a static site on GitHub
Pages.

**Who uses it & what it solves.** An investigator / auditor / business owner who
has one or more staff mailboxes and needs to know: which clients have problems,
where the financial issues are, and who is being ignored — plus extract email
lists, browse messages, and export evidence.

**Primary workflows**
1. Load PST/OST → pick scope (addresses / messages / contacts / forensic +
   deep scan + "our domains") → scan in worker → results tabs.
2. Email-address harvesting → CSV / Excel / TXT.
3. Messages browse + body view (sandboxed) + `.eml` + attachment download.
4. Forensic report → audit findings, client complaints, systemic problems,
   financial register, staff responsiveness, trends, red flags; period filter;
   triage; exports (PDF/Word/Excel/HTML/JSON/CSV).
5. Clients tab → attention-ranked clients + org roll-up + per-client case file +
   evidence-pack ZIP.
6. Optional AI layer (DeepSeek, bring-your-own-key, opt-in): per-client deep
   dive, complaint review, executive summary, ask-the-mailbox.
7. Combine multiple mailboxes into one view; auto save/resume via IndexedDB.
8. Admin key stored as an encrypted vault (passphrase) + per-device PIN login.

## 2. Architecture / project map

```
index.html            upload screen, results tabs, modals (AI/admin, viewer)
src/main.js           UI controller: state, tabs, rendering, exports, AI, admin, save/resume
src/worker.js         Web Worker: parse / addfile / details / search / attachments
src/extract.js        PstSession: streamed PST reader, folder walk, address dedup, multi-file accumulate
src/forensic.js       ForensicCollector: categories, complaints, audit, clients, staff, financial, themes, trends
src/forensic-render.js  Forensic report HTML (in-app + standalone doc) + period filter
src/clients-render.js   Clients list, org roll-up, case file, staff view, AI-dive render
src/ai.js             DeepSeek client + prompt builders (prompts are plain text, not DOM)
src/exporters.js      CSV/XLSX/TXT/JSON/Word(.doc)/print-PDF/multi-sheet workbook
src/zip.js            dependency-free STORE ZIP writer (evidence pack)
src/vault.js          AES-256-GCM + PBKDF2 passphrase vault for the API key
src/storage.js        IndexedDB save/resume of finished analyses
src/cyberbg.js        decorative matrix-rain canvas (cosmetic only)
scripts/check.mjs     zero-dep quality gate (syntax + no debug/markers/keys)
test/smoke.test.js    Node data-layer test (CI gate)
test/browser.test.js  Playwright E2E: extraction, exports, forensic, combined view
.github/workflows/deploy.yml  CI: check → test → build → gh-pages
```

Data flow per feature: **UI action → worker message → PstSession/ForensicCollector
→ structured result → render (escaped) → export**. Email bodies decode lazily;
only summaries + the forensic report are kept in memory / persisted.

## 3. Sections N/A to this project (with reason)

| Framework section | Status | Reason |
|---|---|---|
| Backend / controllers / services | N/A | No server; all logic runs in the browser/worker. |
| Database schema / migrations | N/A | No DB. Local state only: IndexedDB (saved analyses), localStorage (settings/triage/vault). |
| Authn/Authz server-side | N/A | No accounts. "Admin" = local passphrase/PIN gate on the user's own API key; no server to enforce against. |
| Payments / queues / cron / email sending | N/A | None. The only external call is the user's own DeepSeek API, opt-in. |
| SQL injection / CSRF / IDOR / server CORS | N/A | No server endpoints or SQL. |

## 4. Audit register

Severity: P0 critical · P1 major broken · P2 incomplete/degraded · P3 UX/quality · P4 polish.

| ID | Area | Finding | Sev | Evidence | Fix | Status |
|----|------|---------|-----|----------|-----|--------|
| A1 | Security/XSS | Attacker-controlled email fields (subject, sender, snippet, folder) rendered across many `innerHTML` sinks | P1 (if unescaped) | 38 innerHTML/srcdoc sinks; grep of content-field interpolations | Verified **all** DOM interpolations go through `esc()`/`escapeHtml()`/`n()`/`refs()`; body HTML only in `<iframe sandbox="">`; AI "ask" answer escaped before linkify | **VERIFIED — not vulnerable** |
| A2 | CI/CD | Deploy workflow built but never ran the test suite → a regression could ship | P2 | `deploy.yml` had only `npm ci`/`npm run build` | Added `npm run check` + `npm test` before build | **IMPLEMENTED & VERIFIED** (steps present; green locally) |
| A3 | Static quality | No lint/typecheck/format gate at all | P3 | no eslint/tsconfig/prettier | ESLint install hit a v9/v10 peer conflict → chose a **zero-dep** `scripts/check.mjs` (syntax-check every module; fail on debug/TODO/`debugger`/leaked `sk-` key); wired `npm run check` into CI | **IMPLEMENTED & VERIFIED** |
| A4 | Repo hygiene | Stray non-reproducible E2E `test/pin.e2e.mjs` (reads a `/tmp` passphrase) + generated `test/screenshot.png` committed | P4 | `git ls-files test/` | Removed `pin.e2e.mjs`; `screenshot.png` already gitignored/untracked | **IMPLEMENTED & VERIFIED** |
| A5 | Docs | README predates forensic/clients/AI/vault/PIN/multi-file/evidence features | P3 | README 49 lines, 8 keyword hits | Rewrote README to match the implementation | **IMPLEMENTED & VERIFIED** |
| A6 | Tests | Committed E2E covered only address extraction + exports; new forensic/clients surfaces unguarded | P2 | `test/browser.test.js` | Extended E2E: forensic sections present, combined multi-mailbox (5→10 clients), workbook export, zero page errors | **IMPLEMENTED & VERIFIED** |
| A7 | Secrets | API key must never reach the repo | P0 (if leaked) | per-commit `grep sk-[hex]`; vault stores ciphertext only | No key in any tracked file; `scripts/check.mjs` now fails the build if one appears | **VERIFIED** |
| A8 | Mock/placeholder data | Any production-facing fake data? | P2 (if present) | grep mock/fake/sample/Math.random | None. `Math.random` only in the cosmetic `cyberbg.js`. All figures derive from the loaded file. | **VERIFIED — none** |

No P0/P1 defects were found open. Nothing was fabricated to fill the table.

## 5. Known limitations / honest classifications

- **IMPLEMENTED, REQUIRES EXTERNAL VERIFICATION:** the DeepSeek AI layer is
  verified end-to-end against a *mocked* endpoint (prompts, JSON parsing,
  persistence, exports, error paths). A live key will confirm real responses;
  browsers may require a CORS proxy (handled via the API-base-URL setting).
- **NOT YET VALIDATED ON REAL DATA:** all heuristics (complaint/financial/Swahili
  keywords, amount/invoice/due-date extraction, our-domain classification) are
  verified on the two synthetic sample mailboxes only. Real client mail will need
  a tuning pass — the single highest-value next step.
- **Scale:** combined multi-mailbox keeps each file's session in the worker;
  message retention is capped at 100k rows total. Reading bodies/attachments/AI
  needs the file attached (save/resume restores analysis + exports without it).
- **Accessibility (P3, open):** modals lack full focus-trapping; tab roles are
  partial. Functional but not yet a dedicated a11y pass.
- **PDF export** is print-to-PDF (browser dialog), by design for a static site.

## 6. Verification matrix

| Module | Logic | Render | Persistence | Export | Tests | Status |
|---|---|---|---|---|---|---|
| Address harvesting | ✅ | ✅ | n/a | CSV/XLSX/TXT ✅ | smoke+E2E | VERIFIED |
| Messages + body view | ✅ | ✅ (sandboxed) | n/a | .eml/JSON ✅ | E2E | VERIFIED |
| Attachments | ✅ | ✅ | n/a | download+ZIP ✅ | E2E (pack) | VERIFIED |
| Forensic report | ✅ | ✅ | localStorage (triage) | PDF/Word/XLSX/HTML/JSON ✅ | E2E | VERIFIED |
| Clients + case file | ✅ | ✅ | n/a | XLSX/Word/PDF/ZIP ✅ | E2E | VERIFIED |
| Financial register | ✅ | ✅ | n/a | workbook ✅ | smoke(data) | VERIFIED (sample data) |
| Staff / trends / themes | ✅ | ✅ | n/a | workbook ✅ | smoke(data) | VERIFIED (sample data) |
| Multi-file combined | ✅ | ✅ | IndexedDB | ✅ | E2E | VERIFIED |
| Save / resume | ✅ | ✅ | IndexedDB | ✅ | prior E2E | VERIFIED |
| Admin vault + PIN | ✅ | ✅ | localStorage+vault.json | n/a | prior E2E (mocked) | VERIFIED |
| AI layer (DeepSeek) | ✅ | ✅ | localStorage | in reports | mocked E2E | REQUIRES EXTERNAL VERIFICATION |

## 7. Next actions (priority order)
1. Tune heuristics on a **real** client PST (currencies, our-domains, false positives).
2. Live DeepSeek key smoke test (confirm real responses / CORS).
3. Optional: accessibility pass (focus trap, ARIA) — P3.
