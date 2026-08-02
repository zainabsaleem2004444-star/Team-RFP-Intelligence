# SPS RFP Intelligence Portal v2.0

## Setup (VS Code)

### 0. Prerequisites
- **Node.js v22.5 or newer** (needed for the built-in `node:sqlite` module used to persist results).
- **Redis** running locally (needed for the background analysis job queue).
  - **macOS/Linux:** Install with `apt install redis-server`, `brew install redis`, or run the official Docker image, then start it (`redis-server`).
  - **Windows:** WSL/Docker can be flaky depending on your Windows install (some builds are missing the `LxssManager` service entirely, which breaks WSL). If you hit this, skip WSL/Docker and install [Memurai](https://www.memurai.com/get-memurai) (free Developer Edition) — it's a native, Redis-protocol-compatible Windows service that installs like any normal app and listens on `127.0.0.1:6379` by default, so no `.env` changes are needed. Verify it's running with `Get-Service Memurai` in PowerShell (should show `Status: Running`).

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Add your Gemini API key
Edit `backend/.env`:
```
GEMINI_API_KEY=YOUR_KEY_HERE
PORT=3001
REDIS_URL=redis://127.0.0.1:6379
INSURANCE_THRESHOLD=5000000
PAYMENT_TERMS_MAX_DAYS_FOR_GO=30
CONFIDENCE_REVIEW_THRESHOLD=60
FIT_GO_THRESHOLD=70
FIT_NOGO_THRESHOLD=40
DEADLINE_URGENT_DAYS=7
GEMINI_MODEL=gemini-3.6-flash
CROSS_CHECK_ENABLED=true
GEMINI_CROSS_CHECK_MODEL=gemini-3.5-flash-lite
CROSS_CHECK_AMOUNT_TOLERANCE_PCT=5

# Phase 4, item #13 — Past-proposal RAG library
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
RAG_CHUNK_MAX_CHARS=1200
RAG_CHUNK_OVERLAP_CHARS=150
RAG_SEARCH_DEFAULT_TOP_K=5
RAG_MAX_CHUNKS_PER_DOCUMENT=400

# Phase 4, item #14 — OCR fallback for scanned/image PDFs
OCR_FALLBACK_ENABLED=true
GEMINI_VISION_MODEL=gemini-3.5-flash
OCR_FALLBACK_MIN_CHARS=40

# Phase 4, item #15 — Chat with this RFP
CHAT_SOURCE_TEXT_MAX_CHARS=60000
CHAT_MAX_HISTORY_TURNS=6
```
`GEMINI_CROSS_CHECK_MODEL` must be a *different* model from `GEMINI_MODEL` — that's the point of the cross-check (see Phase 3, item #7 below). Model names change fairly often; if either one 404s, run:
```bash
curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY_HERE"
```
and pick two from the list your key can actually call (any entry with `generateContent` in `supportedGenerationMethods`). `GEMINI_EMBEDDING_MODEL` (item #13) hits a different endpoint (`embedContent`) and needs its own check the same way if it 404s. `GEMINI_VISION_MODEL` (item #14) defaults to whatever `GEMINI_MODEL` is set to, since Gemini's main models are natively multimodal — only override it if you specifically want OCR done by a different model than normal analysis.

### 3. Start Redis (if not already running)
```bash
redis-server
```
*(Windows + Memurai users: skip this step — Memurai runs automatically as a background service after install.)*

### 4. Run the server
```bash
npm start
```
This starts both the API and the background worker that processes analysis jobs.

### 5. Open in browser
http://localhost:3001

## Features
- ✅ Row-by-row YES/NO/REVIEW checklist (Financial, Legal, Operations, Technical)
- ✅ GO/CAUTION/NO-GO verdict with fit score
- ✅ Analysis history — saved server-side in a SQLite database (`backend/data/rfp.db`), so it survives browser clears and works across devices
- ✅ Analyses run as background jobs (BullMQ + Redis) instead of blocking the request, so long multi-exhibit RFPs don't risk a timeout
- ✅ Deliverables, Evaluation Criteria, Risks tabs
- ✅ Print / Export PDF
- ✅ Supports PDF, DOCX, TXT files
- ✅ Confidence scoring (0-100%) on every extracted checklist item — anything below CONFIDENCE_REVIEW_THRESHOLD is auto-flagged for human review and a GO decision is auto-downgraded to NEEDS REVIEW
- ✅ Deterministic + AI hybrid — the LLM only does text understanding (extraction); fixed business rules (insurance minimums, deadline pass/fail + urgency window, fit-score → GO/CAUTION/NO-GO thresholds, hard-disqualifier veto) all run in plain JS, tunable via .env
- ✅ Schema-enforced JSON output — Gemini calls pass a strict `responseSchema` (required fields, correct types, enum values for answer/decision/recommendation) so malformed model output is constrained at generation time; a second normalization pass (`normalizeAnalysisResult` in `backend/server.js`) coerces any still-unexpected shape into safe defaults before it reaches the database or deterministic checks, so the app can't crash on a bad model response
- ✅ JSON export API endpoint — `GET /api/analyses/:id/export.json` returns a completed analysis as a downloadable, structured JSON file, so any external tool or script can pull a result by ID without going through the UI
- ✅ PDF export API endpoint — `GET /api/analyses/:id/export.pdf` generates a real PDF report server-side (via `pdfkit`) covering the recommendation, fit score, deadline, all four checklists, deliverables, and insurance figures — a genuine generated PDF, not a browser print-to-PDF of the HTML view
- ✅ **Second-model cross-check (Phase 3, item #7)** — after the primary model finishes, a *different* model (`GEMINI_CROSS_CHECK_MODEL`) independently re-reads the RFP and re-extracts the 4 facts that actually drive the decision (payment terms days, deadline, insurance figures, disqualifiers) with no knowledge of the primary model's answers. Disagreement caps a `GO` down to `CAUTION` and is shown in the UI/exports; agreement shows a confirmation note.
- ✅ **Multi-agent proposal pipeline (Phase 3, item #8)** — `POST /api/proposal/generate` runs three sequential, single-purpose agents against a completed analysis: **Compliance Agent** (extracts mandatory forms/certs/eligibility, no writing) → **Proposal Writer Agent** (drafts the proposal, must satisfy the compliance brief) → **Reviewer Agent** (checks the draft, fixes issues, returns the final text). Runs as a background job like `/api/analyze`; poll it the same way via `GET /api/jobs/:id`. As of Phase 4, item #16, the Writer Agent also pulls relevant language from the past-proposal RAG library — see below.
- ✅ **Past-proposal RAG library (Phase 4, item #13)** — a searchable library of your own previously-won proposals. Upload past proposals via the **Library** UI; each is chunked and embedded (`GEMINI_EMBEDDING_MODEL`) as a background job, then searchable via semantic (embedding cosine-similarity) search — not keyword matching — so a query can surface relevant language even when it doesn't share exact wording with the source text.
- ✅ **OCR fallback for scanned PDFs (Phase 4, item #14)** — if a PDF's normal text-layer extraction comes back with fewer than `OCR_FALLBACK_MIN_CHARS` characters (i.e. it's a scanned/image-only PDF), the raw PDF bytes are automatically sent to a Gemini vision model (`GEMINI_VISION_MODEL`) for transcription instead. Applies to both the main analysis upload flow and the proposal library upload. Documents extracted this way are flagged with a 🔍 badge in the UI so a lower-confidence transcription is never mistaken for a direct text extraction.
- ✅ **"Chat with this RFP" (Phase 4, item #15)** — ask direct questions about any already-analysed RFP and get answers sourced back to the document text, via `POST /api/analyses/:id/chat`. The model is instructed to answer only from the saved RFP text, say plainly when something isn't covered rather than guess, and return a short verbatim supporting quote + page/section hint with every answer so it can be verified against the source.
- ✅ **RAG-integrated proposal generation (Phase 4, item #16)** — the Proposal Writer Agent (see item #8 above) now retrieves the most relevant chunks from the item #13 library before drafting, and reuses that past winning language where it genuinely fits the new RFP. The final result includes `past_examples_used: [{ fileName, score }]` so which past proposals (if any) influenced a given draft is visible and auditable. Falls back gracefully (drafts normally, `past_examples_used: []`) if the library is empty or retrieval fails.

## API Endpoints
All endpoints are prefixed with the backend URL (default `http://localhost:3001`).

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check |
| POST | `/api/extract` | Upload a file (PDF/DOCX/TXT), get back extracted plain text (auto-OCR'd if scanned — see item #14) |
| POST | `/api/analyze` | Queue a single-document analysis job, returns a job id |
| POST | `/api/analyze-merged` | Queue a multi-document (merged) analysis job, returns a job id |
| GET | `/api/jobs/:id` | Poll a job's status (`queued`/`active`/`completed`/`failed`) and get its result once done |
| GET | `/api/history` | List all completed analyses |
| DELETE | `/api/history/:id` | Delete one analysis from history |
| DELETE | `/api/history` | Clear all history |
| GET | `/api/analyses/:id/export.json` | Download a completed analysis as a JSON file |
| GET | `/api/analyses/:id/export.pdf` | Download a completed analysis as a server-generated PDF report |
| POST | `/api/analyses/:id/chat` | **(Phase 4, item #15)** Ask a question about a completed analysis's source RFP text; body `{ question, history? }`, returns a sourced answer synchronously (no job/poll needed) |
| POST | `/api/proposal/generate` | Queue the 3-agent proposal pipeline (`{ analysisId }`) for a completed analysis, returns a job id. Now pulls relevant past-proposal language from the RAG library (item #16) as part of drafting |
| GET | `/api/proposals/:id/export.txt` | Download the finished proposal pipeline's final draft as plain text |
| POST | `/api/proposals/library` | **(Phase 4, item #13)** Upload a past-won proposal (multipart, field `file`) to ingest into the RAG library; returns a job id — chunking + embedding happen as a background job |
| GET | `/api/proposals/library` | **(Phase 4, item #13)** List all documents in the proposal library with status (`queued`/`active`/`ready`/`failed`) and chunk count |
| DELETE | `/api/proposals/library/:id` | **(Phase 4, item #13)** Remove a document (and its chunks) from the library |
| POST | `/api/proposals/library/search` | **(Phase 4, item #13)** Semantic search over the library; body `{ query, topK? }`, returns ranked chunks with file name, snippet, and similarity score |

The two analysis export endpoints, `/api/proposal/generate`, and `/api/analyses/:id/chat` return `409 Conflict` if the referenced analysis/proposal hasn't finished yet (still `queued`/`active`), and `404 Not Found` if the id doesn't exist.

## Roadmap status (Phase 1 / Phase 2 plan)
| # | Item | Status |
|---|------|--------|
| 1 | Server-side database (SQLite) | Done — `backend/db.js` |
| 2 | Background job queue (BullMQ + Redis) | Done — `backend/queue.js` |
| 3 | Status polling | Done — `GET /api/jobs/:id` |
| 4 | Schema-enforced JSON output | Done — `RFP_RESULT_SCHEMA` + `normalizeAnalysisResult()` in `backend/server.js` |
| 5 | Confidence scoring (0-100%) | Done — `runConfidenceReview()` in `backend/server.js` |
| 6 | Deterministic + AI hybrid (expanded) | Done — `applyDeterministicChecks()` in `backend/server.js` (insurance threshold, fit-score thresholds, disqualifier veto, deadline pass/fail + urgency window) |
| 7 | JSON + PDF export API endpoints | Done — `GET /api/analyses/:id/export.json` and `GET /api/analyses/:id/export.pdf` in `backend/server.js` |

## Roadmap status (Phase 3 plan)
| # | Item | Status |
|---|------|--------|
| 7 | Second-model cross-check | Done — `crossCheckHighRiskFields()`, `GEMINI_CROSS_CHECK_MODEL`/`CROSS_CHECK_ENABLED`/`CROSS_CHECK_AMOUNT_TOLERANCE_PCT` in `backend/server.js`; result banner in `frontend/index.html` |
| 8 | Multi-agent pipeline (Compliance → Proposal Writer → Reviewer) | Done — `processProposalPipeline()` + `POST /api/proposal/generate` in `backend/server.js`; draft panel + download in `frontend/index.html`; `source_text` persistence added to `backend/db.js` |
| 12 | Addendum diff tracking | Done — `POST /api/addendum-diff`, `computeChunkDiff()`/`chunkRfpText()` in `backend/server.js`; comparison panel in `frontend/index.html` |

## Roadmap status (Phase 4 plan — Advanced Intelligence)
| # | Item | Status |
|---|------|--------|
| 13 | Past-proposal RAG library | Done — `POST/GET /api/proposals/library`, `DELETE /api/proposals/library/:id`, `POST /api/proposals/library/search`, `processProposalIngestJob()`, `chunkForEmbedding()`, `cosineSimilarity()`, `callGeminiEmbedding()` in `backend/server.js`; `proposal_documents`/`proposal_chunks` tables in `backend/db.js`; Library modal in `frontend/index.html` |
| 14 | OCR fallback for scanned/image PDFs | Done — `extractTextFromUpload()`, `buildOcrPrompt()`, `extractTextViaVisionOCR()`, `OCR_FALLBACK_ENABLED`/`GEMINI_VISION_MODEL`/`OCR_FALLBACK_MIN_CHARS` in `backend/server.js`; `ocr_used` column in `backend/db.js`; 🔍 badge in `frontend/index.html` |
| 15 | "Chat with this RFP" | Done — `POST /api/analyses/:id/chat`, `buildChatPrompt()`, `CHAT_ANSWER_SCHEMA` in `backend/server.js`; chat panel (`renderChatPanel()`/`sendChatMessage()`) in `frontend/index.html` |
| 16 | Proposal generation engine pulling from RAG library | Done — `retrievePastProposalLanguage()` wired into `processProposalPipeline()`, updated `buildProposalWriterPrompt()` in `backend/server.js`; `past_examples_used` surfaced in the proposal result |

**Phase 4 is fully implemented.** Item #16's RAG boost only has an effect once the library (item #13) has been seeded with at least one past proposal — with an empty library, proposal generation still runs normally, it just has nothing to pull from.