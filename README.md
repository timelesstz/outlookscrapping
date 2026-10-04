# Timeless Outlook Extractor

Extract and **investigate** Microsoft Outlook **PST / OST** files entirely in your
browser. No installation, no upload — the file is parsed locally in a Web Worker
and never leaves your machine.

**Live:** https://timelesstz.github.io/outlookscrapping/
A Timeless International product · https://www.craftedbytimeless.com

---

## What it does

**Extraction**
- Email-address harvesting (deduplicated, with sent/received counts) → CSV / Excel / TXT
- Message browsing with a folder tree, sandboxed body viewer, `.eml` export, and
  per-message **attachment download**
- Contacts → CSV / Excel
- Handles PST **and** OST, ANSI or Unicode; no file-size limit (streamed in 1 MiB
  slices, so multi-GB files work without loading fully into memory)

**Forensic report** (opt-in; "Deep content scan" also reads bodies)
- Audit findings (unanswered complaints, payment/bank-change "BEC", spoofing,
  sensitive data, risky attachments, receivables, retention, after-hours…)
- Client complaints register (severity, type, answered/unanswered)
- Systemic problems (recurring themes across clients)
- Financial register (amounts + currency, invoice numbers, due dates, status)
- Staff responsiveness, monthly trends, period filter, triage (reviewed/dismissed)
- Every detection carries a reference (exhibit id + Internet Message-ID) and is
  clickable back to the source email
- Export: PDF (print) · Word (.doc) · multi-sheet Excel · HTML · JSON · CSV

**Clients** (client intelligence)
- Attention-ranked client list + organisation roll-up
- Per-client **case file** (problems, financial, timeline, complaints) with an
  **evidence-pack ZIP** (case file + all that client's attachments)
- Combine several mailboxes into **one** view ("Add mailbox")

**Convenience**
- **Save/resume**: a finished analysis is saved locally (IndexedDB) so reopening
  is instant; re-attach the file only to read bodies/attachments or run AI
- **"Our domain(s)"** setting so client-vs-staff is based on your real domains
- English **and Swahili** complaint/financial/legal keywords

**Optional AI layer — DeepSeek, bring-your-own-key, off by default**
- Per-client deep dive, complaint review, mailbox executive summary, ask-the-mailbox
- Only the specific emails involved in a request are sent — never the whole mailbox
- The key is stored locally. For a personal deployment it can also ship as an
  **encrypted vault** (`public/vault.json`, AES-256-GCM) unlocked by an admin
  passphrase, with a per-device **PIN** login. The key is never committed in plaintext.

## Privacy

Everything runs in your browser. Files are read locally; nothing is uploaded. The
only outbound network call is to the DeepSeek API, and only when you turn the AI
features on and only for the emails involved in that one request.

## Develop

```bash
npm install
npm run dev      # local dev server
npm run build    # production build → dist/
npm run check    # zero-dependency quality gate (syntax + no debug/markers/keys)
npm test         # node smoke test: extraction + forensic data layer
npm run ci       # check + test + build (what CI runs)
node test/browser.test.js   # Playwright end-to-end (needs a browser)
```

Push to the branch and GitHub Actions runs `check → test → build` and deploys to
GitHub Pages. See `PROJECT_AUDIT.md` for the architecture map and audit ledger.

## Tech

Vanilla JS + Vite · `pst-extractor` (PST/OST parsing in a Web Worker) ·
`xlsx` (SheetJS) for spreadsheets · dependency-free ZIP writer · DeepSeek
(OpenAI-compatible) for the optional AI layer.
