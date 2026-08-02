// db.js
// Server-side persistence for analysis results (Phase 1, item #1).
//
// Why this exists: results used to live only in the browser's localStorage,
// which means they vanish if the user clears their browser, switches
// devices, or just has storage disabled. This module saves every analysis
// permanently in a real database file on the server instead.
//
// Uses Node's built-in `node:sqlite` (stable/experimental since Node 22.5+)
// instead of a native module like better-sqlite3 — this avoids requiring
// node-gyp / a C++ build toolchain on whoever's machine runs this backend,
// which is a common source of "npm install" failures on student/Windows
// machines. No separate database server to install or run; it's just a
// file on disk (backend/data/rfp.db).
//
// If you outgrow SQLite (e.g. multiple backend instances writing at once),
// swapping this file for a Postgres-backed version later is a drop-in
// replacement — every function here keeps the same signature.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('\n[FATAL] This backend requires Node.js v22.5+ (for the built-in node:sqlite module).');
  console.error(`You are running Node ${process.version}. Please upgrade Node and try again.\n`);
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = path.join(DATA_DIR, 'rfp.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS analyses (
    id            TEXT PRIMARY KEY,
    batch_id      TEXT,
    file_name     TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued', -- queued | active | completed | failed
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    score         INTEGER,
    recommendation TEXT,
    error         TEXT,
    result_json   TEXT
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_analyses_created_at ON analyses(created_at DESC);');

// Phase 3, item #8 (multi-agent pipeline): the proposal pipeline needs the
// ORIGINAL RFP text again, later, after the Go/No-Go analysis has already
// finished — but the analyses table previously only kept the Gemini
// *result*, not the source document. This column stores that raw text
// (single doc or the merged-doc text) so a proposal can be generated for
// any past analysis without asking the user to re-upload/re-paste it.
// Guarded in a try/catch because SQLite's ALTER TABLE ADD COLUMN throws if
// the column already exists (e.g. on every restart after the first run).
try {
  db.exec('ALTER TABLE analyses ADD COLUMN source_text TEXT;');
} catch (e) {
  // column already exists — fine, nothing to do
}

try {
  db.exec('ALTER TABLE analyses ADD COLUMN pdf_path TEXT;');
} catch (e) {
  // column already exists — fine, nothing to do
}

// Phase 5, item #21 (aggregate dashboard): a "win rate" is meaningless
// without knowing which analysed RFPs were actually WON, LOST, or never
// bid on — nothing upstream of this tracked that outcome before now, since
// every prior feature only cared about the AI's GO/CAUTION/NO-GO verdict,
// not what actually happened afterwards. This column lets a user record
// that outcome by hand once a bid is decided; defaults to 'pending' so
// every existing/new analysis is a valid row without a migration step.
try {
  db.exec('ALTER TABLE analyses ADD COLUMN outcome TEXT NOT NULL DEFAULT \'pending\';');
} catch (e) {
  // column already exists — fine, nothing to do
}

// ===========================================================================
// Phase 4, item #13: Past-proposal RAG library.
//
// `proposal_documents` — one row per uploaded past-won proposal (metadata +
// ingest status). `proposal_chunks` — the text of that document split into
// retrieval-sized pieces, each with its own embedding vector. Embeddings are
// stored as a JSON-encoded array of floats in a TEXT column rather than a
// dedicated vector type — node:sqlite has no native vector index, and at the
// scale of an internal team's proposal library (dozens to low-hundreds of
// documents), a plain JS cosine-similarity scan over every stored chunk
// (see getAllProposalChunks + the caller in server.js) is fast enough that
// standing up Milvus/pgvector for this would be pure overhead.
// ===========================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS proposal_documents (
    id            TEXT PRIMARY KEY,
    file_name     TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued', -- queued | active | ready | failed
    chunk_count   INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
`);
// Phase 4, item #14: records whether this document's text came from the
// normal text-layer extractor or had to be OCR'd (scanned/image PDF), so
// the library UI can flag lower-confidence transcriptions even after a
// page reload (not just in the upload response). Guarded the same way as
// the source_text ALTER above, since ADD COLUMN throws on an existing column.
try {
  db.exec('ALTER TABLE proposal_documents ADD COLUMN ocr_used INTEGER NOT NULL DEFAULT 0;');
} catch (e) {
  // column already exists — fine, nothing to do
}

db.exec(`
  CREATE TABLE IF NOT EXISTS proposal_chunks (
    id            TEXT PRIMARY KEY,
    document_id   TEXT NOT NULL,
    chunk_index   INTEGER NOT NULL,
    text          TEXT NOT NULL,
    embedding     TEXT NOT NULL, -- JSON-encoded array of floats
    created_at    TEXT NOT NULL,
    FOREIGN KEY (document_id) REFERENCES proposal_documents(id) ON DELETE CASCADE
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_proposal_chunks_doc ON proposal_chunks(document_id);');

// ===========================================================================
// Phase 4, item #15: "Chat with this RFP" — per-analysis chunk store.
//
// Mirrors proposal_chunks but scoped to a single completed analysis so chat
// retrieval never bleeds across unrelated RFPs. Embeddings use the same JSON
// float-array-in-TEXT approach as the proposal library (see comment above).
// ===========================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS rfp_chunks (
    id            TEXT PRIMARY KEY,
    analysis_id   TEXT NOT NULL,
    chunk_index   INTEGER NOT NULL,
    text          TEXT NOT NULL,
    embedding     TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_rfp_chunks_analysis ON rfp_chunks(analysis_id);');

// ===========================================================================
// Phase 5, item #17: Team notes/comments on checklist items.
//
// A note is attached to one specific item inside a completed analysis —
// identified by `item_ref`, a string like "financial_checklist:2" or
// "deliverables:0:3" (category index : item index) that the frontend
// builds deterministically from where that item sits in the result JSON.
// `item_label` is stored alongside purely for display convenience (so a
// notes list can show "Note on: Payment Terms" without re-parsing the
// whole analysis result_json every time).
// ===========================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS analysis_notes (
    id            TEXT PRIMARY KEY,
    analysis_id   TEXT NOT NULL,
    item_ref      TEXT NOT NULL,
    item_label    TEXT,
    author        TEXT,
    text          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_notes_analysis ON analysis_notes(analysis_id);');


function nowIso() {
  return new Date().toISOString();
}

// Called the moment a job is accepted, before any Gemini call happens.
// `sourceText` (Phase 3, item #8) is optional so this stays backward
// compatible with any caller that doesn't have/need it.
function createQueued({ id, fileName, batchId, sourceText }) {
  const ts = nowIso();
  db.prepare(`
    INSERT INTO analyses (id, batch_id, file_name, status, created_at, updated_at, source_text)
    VALUES (?, ?, ?, 'queued', ?, ?, ?)
  `).run(id, batchId || null, fileName, ts, ts, sourceText || null);
}

// Phase 3, item #8: fetch just the original RFP text for a past analysis,
// so the proposal pipeline can run against it without re-sending the whole
// document over the wire. Kept as its own function (rather than bloating
// getById/rowToJob) since this text can be large and most callers never
// need it.
function getSourceText(id) {
  const row = db.prepare('SELECT source_text FROM analyses WHERE id = ?').get(id);
  return row ? row.source_text : null;
}

function setStatus(id, status) {
  db.prepare('UPDATE analyses SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, nowIso(), id);
}

// Called by the worker once Gemini + deterministic checks finish successfully.
function saveResult(id, data) {
  db.prepare(`
    UPDATE analyses
    SET status = 'completed',
        score = ?,
        recommendation = ?,
        result_json = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    typeof data.fit_score === 'number' ? data.fit_score : null,
    (data.recommendation || null),
    JSON.stringify(data),
    nowIso(),
    id
  );
}

function markFailed(id, errorMessage) {
  db.prepare(`
    UPDATE analyses SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
  `).run(String(errorMessage || 'Unknown error'), nowIso(), id);
}

function setPdfPath(id, pdfPath) {
  db.prepare('UPDATE analyses SET pdf_path = ? WHERE id = ?').run(pdfPath, id);
}

function rowToJob(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    batchId: row.batch_id || null,
    fileName: row.file_name,
    status: row.status,
    createdAt: row.created_at,
    savedAt: row.updated_at,
    score: row.score,
    recommendation: row.recommendation,
    error: row.error || null,
    pdfPath: row.pdf_path || null,
    outcome: row.outcome || 'pending',
    data: row.result_json ? JSON.parse(row.result_json) : null
  };
}

function getById(id) {
  const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
  return rowToJob(row);
}

// Only completed analyses show up in "history" — queued/active/failed jobs
// are tracked purely via /api/jobs/:id polling until they resolve.
function listCompleted(limit = 100) {
  const rows = db.prepare(`
    SELECT * FROM analyses WHERE status = 'completed'
    ORDER BY created_at DESC LIMIT ?
  `).all(limit);
  return rows.map(rowToJob);
}

function remove(id) {
  db.prepare('DELETE FROM rfp_chunks WHERE analysis_id = ?').run(id);
  db.prepare('DELETE FROM analyses WHERE id = ?').run(id);
}

function clearAll() {
  db.exec('DELETE FROM analyses;');
}

// Phase 5, item #21: record what actually happened to a bid (won / lost /
// no_bid), independently of the AI's GO/CAUTION/NO-GO verdict. 'pending' is
// the default until someone sets it — dashboard stats treat 'pending' as
// "not yet decided" and exclude it from win-rate math (see below).
const VALID_OUTCOMES = ['pending', 'won', 'lost', 'no_bid'];
function setOutcome(id, outcome) {
  if (!VALID_OUTCOMES.includes(outcome)) {
    throw new Error(`Invalid outcome "${outcome}". Must be one of: ${VALID_OUTCOMES.join(', ')}`);
  }
  db.prepare('UPDATE analyses SET outcome = ?, updated_at = ? WHERE id = ?').run(outcome, nowIso(), id);
  return getById(id);
}

// Phase 5, item #21: aggregate dashboard — win rate, average fit score, and
// totals across every completed analysis. Phase 5, item #22 reuses the same
// per-item counting logic (checklist items + risk flags) client-side for
// the single-analysis headline strip, but this function computes the
// ACROSS-ALL-RFPS rollups, which only make sense server-side against the
// full history table rather than whatever one result happens to be loaded
// in the browser.
function getDashboardStats() {
  const rows = db.prepare('SELECT score, recommendation, outcome, result_json FROM analyses WHERE status = \'completed\'').all();

  const totalAnalyses = rows.length;
  const recommendationCounts = { GO: 0, CAUTION: 0, 'NO-GO': 0 };
  const outcomeCounts = { pending: 0, won: 0, lost: 0, no_bid: 0 };
  let scoreSum = 0;
  let scoredCount = 0;
  let totalItemsExtracted = 0;
  let totalRisksFlagged = 0;
  let highRisksFlagged = 0;

  for (const row of rows) {
    if (typeof row.score === 'number') {
      scoreSum += row.score;
      scoredCount += 1;
    }
    const rec = ['GO', 'CAUTION', 'NO-GO'].includes(row.recommendation) ? row.recommendation : 'CAUTION';
    recommendationCounts[rec] += 1;

    const outcome = VALID_OUTCOMES.includes(row.outcome) ? row.outcome : 'pending';
    outcomeCounts[outcome] += 1;

    if (row.result_json) {
      try {
        const data = JSON.parse(row.result_json);
        const checklistCount = ['financial_checklist', 'legal_checklist', 'operations_checklist', 'technical_checklist']
          .reduce((sum, key) => sum + (Array.isArray(data[key]) ? data[key].length : 0), 0);
        const deliverableCount = (Array.isArray(data.deliverables_checklist) ? data.deliverables_checklist : [])
          .reduce((sum, cat) => sum + (Array.isArray(cat.items) ? cat.items.length : 0), 0);
        totalItemsExtracted += checklistCount + deliverableCount;

        const risks = Array.isArray(data.risk_flags) ? data.risk_flags : [];
        totalRisksFlagged += risks.length;
        highRisksFlagged += risks.filter(r => r && r.severity === 'HIGH').length;
      } catch (e) {
        // malformed/legacy result_json — skip counting items/risks for this
        // row rather than letting one bad row break the whole dashboard
      }
    }
  }

  const decidedCount = outcomeCounts.won + outcomeCounts.lost;
  const winRate = decidedCount > 0 ? Math.round((outcomeCounts.won / decidedCount) * 1000) / 10 : null;

  return {
    totalAnalyses,
    averageFitScore: scoredCount > 0 ? Math.round((scoreSum / scoredCount) * 10) / 10 : null,
    recommendationCounts,
    outcomeCounts,
    decidedCount,
    winRate, // percentage, 0-100, or null if no won/lost decisions recorded yet
    totalItemsExtracted,
    totalRisksFlagged,
    highRisksFlagged
  };
}

// --- Proposal library (Phase 4, item #13) ---------------------------------

function createProposalDocument({ id, fileName, ocrUsed }) {
  const ts = nowIso();
  db.prepare(`
    INSERT INTO proposal_documents (id, file_name, status, chunk_count, created_at, updated_at, ocr_used)
    VALUES (?, ?, 'queued', 0, ?, ?, ?)
  `).run(id, fileName, ts, ts, ocrUsed ? 1 : 0);
}

function setProposalDocumentStatus(id, status, error) {
  db.prepare(`
    UPDATE proposal_documents SET status = ?, error = ?, updated_at = ? WHERE id = ?
  `).run(status, error || null, nowIso(), id);
}

// Called once ingestion succeeds: replaces any existing chunks for this
// document (defensive — lets a failed/partial ingest be safely re-run) and
// inserts the fresh set in one go.
function saveProposalChunks(documentId, chunks) {
  const del = db.prepare('DELETE FROM proposal_chunks WHERE document_id = ?');
  const insert = db.prepare(`
    INSERT INTO proposal_chunks (id, document_id, chunk_index, text, embedding, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const ts = nowIso();
  del.run(documentId);
  for (const c of chunks) {
    insert.run(crypto.randomUUID(), documentId, c.index, c.text, JSON.stringify(c.embedding), ts);
  }
  db.prepare(`
    UPDATE proposal_documents SET status = 'ready', chunk_count = ?, error = NULL, updated_at = ? WHERE id = ?
  `).run(chunks.length, ts, documentId);
}

function listProposalDocuments() {
  const rows = db.prepare(`
    SELECT id, file_name, status, chunk_count, error, created_at, updated_at, ocr_used
    FROM proposal_documents ORDER BY created_at DESC
  `).all();
  return rows.map(r => ({
    id: r.id,
    fileName: r.file_name,
    status: r.status,
    chunkCount: r.chunk_count,
    error: r.error || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ocrUsed: !!r.ocr_used
  }));
}

function getProposalDocument(id) {
  const r = db.prepare('SELECT * FROM proposal_documents WHERE id = ?').get(id);
  if (!r) {
    return null;
  }
  return {
    id: r.id, fileName: r.file_name, status: r.status,
    chunkCount: r.chunk_count, error: r.error || null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    ocrUsed: !!r.ocr_used
  };
}

function deleteProposalDocument(id) {
  db.prepare('DELETE FROM proposal_chunks WHERE document_id = ?').run(id);
  db.prepare('DELETE FROM proposal_documents WHERE id = ?').run(id);
}

// Loads every chunk (across every ready document) with its embedding
// decoded back into a plain array — used by the /search endpoint's
// in-memory cosine-similarity ranking. Fine at this library's scale (see
// comment above the table definitions); if the library ever grows into the
// thousands of chunks, this is the point to swap in a real vector index.
function getAllProposalChunks() {
  const rows = db.prepare(`
    SELECT pc.id, pc.document_id, pc.chunk_index, pc.text, pc.embedding, pd.file_name
    FROM proposal_chunks pc
    JOIN proposal_documents pd ON pd.id = pc.document_id
    WHERE pd.status = 'ready'
  `).all();
  return rows.map(r => ({
    id: r.id,
    documentId: r.document_id,
    chunkIndex: r.chunk_index,
    text: r.text,
    embedding: JSON.parse(r.embedding),
    fileName: r.file_name
  }));
}

// --- RFP chat chunks (Phase 4, item #15) ----------------------------------

function saveRfpChunks(analysisId, chunks) {
  const del = db.prepare('DELETE FROM rfp_chunks WHERE analysis_id = ?');
  const insert = db.prepare(`
    INSERT INTO rfp_chunks (id, analysis_id, chunk_index, text, embedding, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const ts = nowIso();
  del.run(analysisId);
  for (const c of chunks) {
    insert.run(crypto.randomUUID(), analysisId, c.index, c.text, JSON.stringify(c.embedding), ts);
  }
}

function getRfpChunksByAnalysis(analysisId) {
  const rows = db.prepare(`
    SELECT id, analysis_id, chunk_index, text, embedding
    FROM rfp_chunks WHERE analysis_id = ?
    ORDER BY chunk_index ASC
  `).all(analysisId);
  return rows.map(r => ({
    id: r.id,
    analysisId: r.analysis_id,
    chunkIndex: r.chunk_index,
    text: r.text,
    embedding: JSON.parse(r.embedding)
  }));
}

function countRfpChunks(analysisId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM rfp_chunks WHERE analysis_id = ?').get(analysisId);
  return row ? row.n : 0;
}

// --- Team notes (Phase 5, item #17) ---------------------------------------

function addNote({ analysisId, itemRef, itemLabel, author, text }) {
  const id = crypto.randomUUID();
  const ts = nowIso();
  db.prepare(`
    INSERT INTO analysis_notes (id, analysis_id, item_ref, item_label, author, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, analysisId, itemRef, itemLabel || null, author || 'Anonymous', text, ts);
  return { id, analysisId, itemRef, itemLabel: itemLabel || null, author: author || 'Anonymous', text, createdAt: ts };
}

function listNotesByAnalysis(analysisId) {
  const rows = db.prepare(`
    SELECT * FROM analysis_notes WHERE analysis_id = ? ORDER BY created_at ASC
  `).all(analysisId);
  return rows.map(r => ({
    id: r.id,
    analysisId: r.analysis_id,
    itemRef: r.item_ref,
    itemLabel: r.item_label || null,
    author: r.author,
    text: r.text,
    createdAt: r.created_at
  }));
}

function deleteNote(id) {
  db.prepare('DELETE FROM analysis_notes WHERE id = ?').run(id);
}



module.exports = {
  createQueued,
  setPdfPath,
  addNote,
  listNotesByAnalysis,
  deleteNote,
  setStatus,
  saveResult,
  markFailed,
  getById,
  getSourceText,
  listCompleted,
  remove,
  clearAll,
  setOutcome,
  getDashboardStats,
  createProposalDocument,
  setProposalDocumentStatus,
  saveProposalChunks,
  listProposalDocuments,
  getProposalDocument,
  deleteProposalDocument,
  getAllProposalChunks,
  saveRfpChunks,
  getRfpChunksByAnalysis,
  countRfpChunks
};