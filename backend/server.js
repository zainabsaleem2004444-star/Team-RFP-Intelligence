// server.js
// Backend proxy for the RFP Intelligence Portal.
//
// Why this exists: the Gemini API key must never live in browser/frontend code.
// Anyone can open dev tools and read it out of page source or network requests
// if it's called from the browser directly. This server holds the key in an
// environment variable (.env, NOT committed to git) and the frontend calls
// THIS server instead of calling Google directly.

// Phase 6, item #26: environment-based config — load the .env file that matches
// NODE_ENV automatically (development/production/test) instead of manually
// swapping .env files by hand. Falls back to plain .env if no env-specific
// file exists (e.g. a fresh local clone that hasn't split them out yet).
const path = require('path');
const fs = require('fs');
const NODE_ENV = process.env.NODE_ENV || 'development';
const envFile = path.join(__dirname, `.env.${NODE_ENV}`);
require('dotenv').config({ path: fs.existsSync(envFile) ? envFile : path.join(__dirname, '.env') });
console.log(`[config] NODE_ENV=${NODE_ENV}, loaded ${fs.existsSync(envFile) ? `.env.${NODE_ENV}` : '.env'}`);

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const db = require('./db');
const { startWorker, enqueueAnalysis } = require('./queue');

// Simple PDF text extraction without pdf-parse
async function parsePdf(buffer) {
  try {
    // Try pdf-parse first
    const pdfParse = require('pdf-parse');
    return await pdfParse(buffer);
  } catch(e1) {
    try {
      // Fallback: extract readable text directly from PDF buffer
      const text = buffer.toString('latin1');
      const matches = text.match(/\(([^)]{2,200})\)/g) || [];
      const extracted = matches
        .map(m => m.slice(1, -1))
        .filter(s => /[a-zA-Z]{3,}/.test(s))
        .join(' ')
        .replace(/\\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim();
      if (extracted.length > 100) {
        return { text: extracted };
      }
      throw new Error('Could not extract text from PDF');
    } catch(e2) {
      throw new Error('PDF parsing failed: ' + e2.message);
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Phase 5, item #18: where auto-generated Puppeteer PDF reports live on disk.
const PDF_REPORTS_DIR = path.join(__dirname, 'data', 'pdf-reports');
if (!fs.existsSync(PDF_REPORTS_DIR)) {
  fs.mkdirSync(PDF_REPORTS_DIR, { recursive: true });
}

// Phase 5, item #19: automated alerts (Slack + email), both OFF unless enabled in .env.
const nodemailer = require('nodemailer');
const SLACK_ALERTS_ENABLED = String(process.env.SLACK_ALERTS_ENABLED || 'false').toLowerCase() === 'true';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const EMAIL_ALERTS_ENABLED = String(process.env.EMAIL_ALERTS_ENABLED || 'false').toLowerCase() === 'true';
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || '';
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || '';

async function sendSlackAlert(text) {
  if (!SLACK_ALERTS_ENABLED || !SLACK_WEBHOOK_URL) {
    return;
  }
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch (err) {
    console.warn('[alerts] Slack send failed (non-fatal):', err.message);
  }
}

let mailTransporter = null;
function getMailTransporter() {
  if (mailTransporter) {
    return mailTransporter;
  }
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return mailTransporter;
}

async function sendEmailAlert(subject, text) {
  if (!EMAIL_ALERTS_ENABLED || !ALERT_EMAIL_TO || !process.env.SMTP_HOST) {
    return;
  }
  try {
    await getMailTransporter().sendMail({ from: ALERT_EMAIL_FROM, to: ALERT_EMAIL_TO, subject, text });
  } catch (err) {
    console.warn('[alerts] Email send failed (non-fatal):', err.message);
  }
}

async function fireAnalysisAlerts(finalResult, fileName) {
  const rec = (finalResult.recommendation || 'CAUTION').toUpperCase();
  const score = typeof finalResult.fit_score === 'number' ? finalResult.fit_score : '—';
  const msg = `✅ Analysis complete: "${fileName}" — ${rec} (score ${score}/100)`;
  await sendSlackAlert(msg);
  await sendEmailAlert(`RFP Analysis Complete: ${fileName}`, msg);

  if (finalResult.deadline_urgent === true) {
    const urgentMsg = `⏰ Deadline approaching: "${fileName}" — only ${finalResult.deadline_days_remaining} day(s) left (deadline ${finalResult.deadline_date_iso}).`;
    await sendSlackAlert(urgentMsg);
    await sendEmailAlert(`URGENT deadline: ${fileName}`, urgentMsg);
  }
}

// FIX #3: insurance go/no-go threshold is now a config value, not something
// baked into the LLM prompt as a "fact-finding" instruction. Change this (or
// set INSURANCE_THRESHOLD in .env) to match your company's actual risk
// tolerance. The LLM's job is now only to extract the real dollar figures
// from the RFP text; the GO/NO-GO math happens here in plain JS.
const INSURANCE_THRESHOLD = Number(process.env.INSURANCE_THRESHOLD || 5000000);

// Same pattern as INSURANCE_THRESHOLD above, for the Financial/Accounting
// Checklist's Payment Terms rule ("GO if NET30, escalate to accounting if
// slower than NET30"). The LLM only extracts the actual number of days
// stated in the RFP; the GO vs escalate decision happens in code below
// (see runPaymentTermsCheck) so it can't be talked into the wrong answer.
const PAYMENT_TERMS_MAX_DAYS_FOR_GO = Number(process.env.PAYMENT_TERMS_MAX_DAYS_FOR_GO || 30);

// Phase 2, item #5 (confidence scoring) + item #6 (expanded deterministic
// hybrid) config. All are plain numbers so a non-engineer on the team can
// tune business behavior in .env without touching any code.
const CONFIDENCE_REVIEW_THRESHOLD = Number(process.env.CONFIDENCE_REVIEW_THRESHOLD || 60);
const FIT_GO_THRESHOLD = Number(process.env.FIT_GO_THRESHOLD || 70);
const FIT_NOGO_THRESHOLD = Number(process.env.FIT_NOGO_THRESHOLD || 40);
const DEADLINE_URGENT_DAYS = Number(process.env.DEADLINE_URGENT_DAYS || 7);

// Phase 3, item #7: second-model cross-check config. A DIFFERENT model
// (not just a second call to the same one) independently re-derives the
// small set of facts that actually decide GO/NO-GO — payment terms,
// deadline, insurance figures, disqualifiers — straight from the RFP text,
// with no knowledge of what the first model said. Two different models
// making the same mistake on the same passage is far less likely than one
// model being consistently wrong with itself, so this catches a class of
// error confidence-scoring alone can't (a model that's simply misread a
// clause, but is "confident" about its misreading).
const CROSS_CHECK_ENABLED = String(process.env.CROSS_CHECK_ENABLED || 'true').toLowerCase() !== 'false';
const GEMINI_CROSS_CHECK_MODEL = process.env.GEMINI_CROSS_CHECK_MODEL || 'gemini-2.5-pro';
// Dollar figures rarely match to the penny even when both models agree in
// substance (e.g. one reads "$5,000,000", the other "$5M aggregate") — a
// small tolerance avoids flagging that as a disagreement.
const CROSS_CHECK_AMOUNT_TOLERANCE_PCT = Number(process.env.CROSS_CHECK_AMOUNT_TOLERANCE_PCT || 5);

// Phase 3, item #12: addendum diff tracking config. A "chunk" is roughly a
// paragraph — chunks shorter than this are dropped from the diff entirely,
// since RFP text extracted from PDFs is full of one-line page headers,
// footers, and page-number markers ("Page 5 of 21") that would otherwise
// show up as noisy false "changes" every time a page break shifts by one.
const ADDENDUM_DIFF_MIN_CHUNK_CHARS = Number(process.env.ADDENDUM_DIFF_MIN_CHUNK_CHARS || 25);

// Phase 4, item #13: past-proposal RAG library config. Chunk size/overlap
// are in characters (not tokens) to keep this dependency-free — roughly
// 1200 chars ≈ 200-250 words, small enough for precise retrieval, with a
// 150-char overlap so a sentence that straddles a chunk boundary still
// appears whole in at least one chunk. GEMINI_EMBEDDING_MODEL is separate
// from GEMINI_MODEL because embedding models and generative models are
// different model families entirely — Google may deprecate/replace one
// without touching the other, so this stays independently configurable.
const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const RAG_CHUNK_MAX_CHARS = Number(process.env.RAG_CHUNK_MAX_CHARS || 1200);
const RAG_CHUNK_OVERLAP_CHARS = Number(process.env.RAG_CHUNK_OVERLAP_CHARS || 150);
const RAG_SEARCH_DEFAULT_TOP_K = Number(process.env.RAG_SEARCH_DEFAULT_TOP_K || 5);
// Embedding calls run sequentially per chunk (see embedChunksSequentially) —
// this caps how many chunks a single document ingest will embed, so one
// huge accidental upload can't run away with your Gemini quota/time.
const RAG_MAX_CHUNKS_PER_DOCUMENT = Number(process.env.RAG_MAX_CHUNKS_PER_DOCUMENT || 400);

// Phase 4, item #14: OCR fallback config. Scanned/image-only PDFs (a paper
// RFP run through a scanner, or a "print to PDF" of a fax) have no text
// layer at all, so pdf-parse "succeeds" without an error but returns almost
// nothing. GEMINI_VISION_MODEL defaults to the same model as GEMINI_MODEL
// since Gemini's flash/pro models are natively multimodal (they accept a
// PDF's raw bytes and read the page images directly) — kept as a separate
// env var in case a future deployment wants a stronger/cheaper model
// specifically for OCR without touching the main analysis model.
// OCR_FALLBACK_MIN_CHARS is deliberately low (not "0"): a genuine extraction
// failure typically yields a handful of stray characters (page-number
// artifacts, etc.), not exactly zero, so this is the threshold below which
// the text layer is treated as "not really there."
const OCR_FALLBACK_ENABLED = String(process.env.OCR_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const OCR_FALLBACK_MIN_CHARS = Number(process.env.OCR_FALLBACK_MIN_CHARS || 40);

// Phase 4, item #15: "Chat with this RFP" config. CHAT_SOURCE_TEXT_MAX_CHARS
// caps how much of the saved RFP text gets sent per turn — most RFPs fit
// comfortably under this, and it keeps a single chat call's token cost/
// latency bounded the same way the proposal writer prompt already slices
// its input (see buildProposalWriterPrompt). CHAT_MAX_HISTORY_TURNS caps how
// many prior Q/A pairs get replayed into the prompt on each new question —
// a long chat session would otherwise keep growing the prompt on every
// turn; only the most recent turns are usually relevant to a follow-up.
const CHAT_SOURCE_TEXT_MAX_CHARS = Number(process.env.CHAT_SOURCE_TEXT_MAX_CHARS || 60000);
const CHAT_MAX_HISTORY_TURNS = Number(process.env.CHAT_MAX_HISTORY_TURNS || 6);

// ===========================================================================
// SPS's internal "RFP Checklist" document, hardcoded verbatim (by section)
// as the authoritative criteria this tool evaluates every RFP against.
// This is the actual company reference document, not a paraphrase — it's
// injected into every prompt so Gemini scores each RFP against SPS's real
// financial, legal, operations, and technical criteria by default, without
// anyone having to retype it into the "strengths"/"gaps" boxes each time.
// Two of these rules are ALSO enforced as hard code, not just prompt text
// (see PAYMENT_TERMS_MAX_DAYS_FOR_GO / INSURANCE_THRESHOLD above and
// runPaymentTermsCheck / runInsuranceCheck below), because the source
// document states them as unambiguous, no-judgment-call thresholds:
//   - Payment Terms: GO if NET30, escalate to accounting if slower.
//   - Insurance Requirements: GO if $5M, NO-GO if more than $5M.
// Every other item below is a fact-finding checklist item — Gemini answers
// it from the RFP text (see the ~30 named checklist items already built
// into buildPrompt/buildMergedPrompt), and a person still applies judgment
// to items like Eligibility Criteria, Capability, and Quantum of Input
// Required, which describe categories of judgment rather than pass/fail
// tests. If SPS's checklist changes, edit this constant directly — no
// other code needs to change.
// ===========================================================================
const SPS_RFP_CHECKLIST_FULL_TEXT = `FINANCIAL / ACCOUNTING CHECKLIST

Payment Terms:
Review the payment schedule, including milestones, retainage, and any penalties for late payments.
Take a GO decision if payment plan is NET30, if more than NET30 then escalate it to accounting.

Financial Stability Requirements:
Check if the RFP requires financial statements or proof of financial stability, and ensure your company can meet these requirements.

Unaudited Financial Statements

Insurance Requirements:
Ensure that your company can meet any insurance requirements.
If $5M then GO decision.
If more than $5M then NO-GO.

Profitability Analysis:
Assess the potential profitability of the project by comparing the expected revenue against projected costs.

Bid Bond:

Eligibility Criteria:
- Relevant Experience
- Registration Requirement
- Financial Statement of Previous Year

Capability:
- Qualified Personnel
- Technical Knowhow

Quantum of Input Required:
- Expected Revenue Generation
- Period of Implementation
- Insurance Coverage
- Compliance of Law

LEGAL CHECKLIST

Compliance Requirements:
Verify that the project complies with relevant laws and regulations, including data protection laws.

State Registration:
Verify if there is a requirement for the company to be registered in the state where the project is being executed and ensure compliance if needed.

E-Verify:
Check if the RFP requires the use of the E-Verify system.

Contractual Obligations:
Review the terms and conditions to ensure they are acceptable, including termination clauses, liability limits, and dispute resolution mechanisms.

OPERATIONS CHECKLIST

Required Forms:
Identify all required forms that need to be completed and signed, such as certifications, compliance forms, or declarations.
- Insurance Requirement
- Information Form: Tax ID, Owner Name, % of ownership
- Small Business (MD)
- MBE (specify type)
- Workers Comp Insurance
- Business with Iran

Submission Deadlines:
Ensure all forms are completed accurately and submitted by the required deadlines.

Document Compliance:
Verify that all documents are in compliance with the RFP's formatting and submission requirements.

Signatory Authority:
Ensure the correct individuals with the necessary authority sign the forms.

Checklist of Required Documents:
Cross-check the RFP to ensure all required documents and forms are included in your submission.
Responsible Person: RFP Owner/Lead
Meeting with Ops

Vendor Registration:
Specific info needed to complete registration.
Who will be responsible.

TECHNICAL CHECKLIST

Scope of Services/Products:
Identify whether the RFP aligns with the services or products that SPS offers, such as Identity and Access Management, cybersecurity solutions, etc.

Technical Requirements:
Review the technical specifications in the RFP to ensure they match SPS's capabilities and offerings.

Compliance with Industry Standards:
Ensure the RFP's technical requirements adhere to industry standards and best practices that SPS follows.

Security Considerations:
Assess whether the RFP includes security requirements that SPS can meet, including data protection, encryption, and access controls.

Integration Needs:
Determine if the project requires integration with other systems and whether SPS can support these needs.`;

// Fallback context sent as COMPANY STRENGTHS / COMPANY GAPS whenever the
// frontend's boxes are left blank. Both simply point the model at the full
// checklist above so it evaluates every RFP the way SPS actually would.
const DEFAULT_COMPANY_STRENGTHS = 'SPS\'s core service offerings and capabilities: Identity and Access Management (IAM) solutions and cybersecurity solutions are our primary service lines. We can meet standard industry technical requirements and security considerations (data protection, encryption, access controls) and support common system integration needs. We can meet NET30 payment terms and insurance coverage requirements up to $5,000,000 without escalation. See the full SPS RFP Checklist supplied in this prompt for the complete evaluation criteria.';

const DEFAULT_COMPANY_GAPS = 'Known gaps/limitations and watch-items per SPS\'s RFP Checklist: payment terms slower than NET30 require escalation to accounting rather than an automatic GO; any single insurance coverage above $5,000,000 is a NO-GO; financial-statement/proof-of-stability requests, bid bonds, EFT/vendor registration (e.g. eVA), state registration, E-Verify, Workers Comp, Small Business (MD)/MBE certification, and "Business with Iran" declarations all require manual confirmation before committing. See the full SPS RFP Checklist supplied in this prompt for the complete evaluation criteria.';

if (!GEMINI_API_KEY) {
  console.error('\n[FATAL] GEMINI_API_KEY is not set.');
  console.error('Create a .env file in /backend (copy .env.example) and paste your key in.\n');
  process.exit(1);
}

// --- CORS ---
// In dev, allow your local frontend. In production, set FRONTEND_ORIGIN in .env
// to your deployed frontend's URL and lock this down (avoid '*').
const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

app.use(express.json({ limit: '5mb' })); // RFP text can be long; allow a generous body size

// --- File upload handling ---
// Files are kept in memory only (never written to disk) and discarded after
// the request completes. Max 15MB, restricted to PDF/DOCX/TXT.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okTypes = [
      'application/pdf',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ];
    const okExt = /\.(pdf|txt|doc|docx)$/i.test(file.originalname);
    if (okTypes.includes(file.mimetype) || okExt) {
      return cb(null, true);
    }
    cb(new Error('Unsupported file type. Upload a PDF, DOCX, or TXT file.'));
  }
});

// --- Basic rate limiting ---
// Protects your free Gemini quota from being burned by retries/abuse.
const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 minutes
  max: 300,                 // 300 requests per IP per window (plenty for local dev/testing)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' }
});
app.use('/api/', limiter);

// --- Health check ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Extract endpoint ---
// Frontend uploads the raw file here first. We extract plain text server-side
// (so the browser never needs a PDF/DOCX parsing library) and hand back the
// text for the user to review/edit before analysis, plus the filename.
async function extractTextFromUpload(buffer, mimetype, originalname) {
  let text = '';
  let ocrUsed = false;
  if (mimetype === 'application/pdf' || /\.pdf$/i.test(originalname)) {
    const parsed = await parsePdf(buffer);
    text = (parsed.text || '').trim();

    // Phase 4, item #14: OCR fallback. parsePdf() only ever finds text that
    // is embedded in the PDF as an actual text layer. A scanned paper RFP
    // (or any PDF that's really just a stack of page images) has NO text
    // layer, so parsePdf "succeeds" without throwing but hands back next to
    // nothing. Rather than surface that as a generic "couldn't read this
    // file" error, route the raw PDF bytes to a vision-capable Gemini model
    // and let it read the page images directly, the way a person would.
    if (OCR_FALLBACK_ENABLED && text.length < OCR_FALLBACK_MIN_CHARS) {
      console.warn(`[OCR] "${originalname}": text layer had only ${text.length} char(s) — falling back to vision OCR (${GEMINI_VISION_MODEL}).`);
      try {
        const ocrText = await extractTextViaVisionOCR(buffer, originalname);
        if (ocrText && ocrText.length > text.length) {
          text = ocrText;
          ocrUsed = true;
        }
      } catch (ocrErr) {
        // Don't let an OCR failure mask/replace whatever (little) the
        // regular parser found — just log it and fall through with
        // whatever `text` already holds, so the existing "text too short"
        // error message below still fires with its normal wording.
        console.error(`[OCR] "${originalname}" vision OCR fallback failed: ${ocrErr.message}`);
      }
    }
  } else if (/\.(docx)$/i.test(originalname)) {
    // Lightweight DOCX text extraction without extra heavy deps:
    // DOCX is a zip; pull document.xml and strip tags.
    text = await extractDocxText(buffer);
  } else {
    // .txt or .doc fallback: treat as plain text
    text = buffer.toString('utf-8');
  }
  return { text: (text || '').trim(), ocrUsed };
}

// Phase 4, item #14: builds the OCR transcription prompt. Deliberately asks
// for plain-text transcription (not JSON) — the goal here is a faithful
// reading of the page images, and forcing structured output would spend the
// model's effort on formatting instead of accuracy. Page markers are
// requested so the output stays a drop-in replacement for normal
// `rfpText` everywhere downstream (chunking, analysis prompts, RAG ingest)
// without any special-casing elsewhere in the app.
function buildOcrPrompt(originalname) {
  return `You are transcribing the text content of a scanned or image-based PDF document named "${originalname}". This document has no machine-readable text layer, so you must read it visually, the way OCR software would.

Instructions:
- Transcribe ALL visible text, in natural reading order, exactly as written. Do not summarize, paraphrase, or skip sections.
- Preserve headings and numbered/bulleted lists as plain text. For tables, use one line per row with columns separated by " | ".
- Insert a line "--- Page N ---" before the transcribed content of each page.
- If a page or region is blank, illegible, or purely decorative (e.g. a cover photo with no text), write "[illegible or no text]" for that portion instead of guessing at content.
- Do not add commentary, explanations, or anything that isn't actually printed on the page.

Return ONLY the transcribed text — no preamble, no markdown code fences.`;
}

// Phase 4, item #14: sends the RAW PDF bytes (not a rasterized image we'd
// have to generate ourselves) to a vision-capable Gemini model. Gemini's
// generateContent endpoint accepts PDF documents as an inlineData part and
// reads the page images internally, so this needs no extra PDF-to-image
// dependency (no native canvas/poppler binaries to install or ship). Plain
// text response — see buildOcrPrompt above.
async function extractTextViaVisionOCR(buffer, originalname) {
  const base64 = buffer.toString('base64');
  const text = await callGeminiAPI(buildOcrPrompt(originalname), {
    model: GEMINI_VISION_MODEL,
    extraParts: [{ inlineData: { mimeType: 'application/pdf', data: base64 } }]
  });
  return stripJsonFences(text).trim();
}

app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const { buffer, mimetype, originalname } = req.file;
    const { text, ocrUsed } = await extractTextFromUpload(buffer, mimetype, originalname);

    if (text.length < 50) {
      return res.status(422).json({ error: 'Could not extract readable text from this file, even with OCR fallback. Try a different file or paste the text manually.' });
    }

    // Phase 4, item #14: let the frontend show the user that this file was
    // scanned/image-only and read via vision OCR rather than a normal text
    // layer, so a lower-confidence transcription doesn't look identical to
    // a clean text extraction.
    res.json({ filename: originalname, text, ocrUsed });
  } catch (err) {
    console.error('Extract error:', err.message);
    res.status(502).json({ error: err.message || 'Could not read the uploaded file.' });
  }
});

// Minimal DOCX text extraction (no external binary deps): unzip in-memory,
// read word/document.xml, strip XML tags, collapse whitespace.
async function extractDocxText(buffer) {
  const { default: JSZip } = await import('jszip').then(m => ({ default: m.default || m }));
  const zip = await JSZip.loadAsync(buffer);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) {
    throw new Error('Could not read this DOCX file.');
  }
  const xml = await xmlFile.async('string');
  return xml
    .replace(/<w:p[ >]/g, '\n$&')        // newline before each paragraph
    .replace(/<[^>]+>/g, '')              // strip all tags
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Main analysis endpoint (NOW ASYNC — Phase 1 item #2) ---
// Frontend sends: { rfpText, strengths, gaps }
// Instead of calling Gemini inline and blocking the request until it's
// done, we save a "queued" row in the database and hand the real work off
// to a BullMQ background job (see queue.js + the worker below). The
// response comes back immediately with a job id the frontend can poll via
// GET /api/jobs/:id.
app.post('/api/analyze', async (req, res) => {
  try {
    const { rfpText, strengths, gaps, fileName } = req.body;

    if (!rfpText || typeof rfpText !== 'string' || rfpText.trim().length < 200) {
      return res.status(400).json({ error: 'rfpText is missing or too short. Upload a valid RFP document.' });
    }

    const id = crypto.randomUUID();
    const name = fileName || 'Untitled RFP';
    db.createQueued({ id, fileName: name, sourceText: rfpText });
    await enqueueAnalysis(id, { kind: 'single', id, rfpText, strengths: (strengths && strengths.trim()) || DEFAULT_COMPANY_STRENGTHS, gaps: (gaps && gaps.trim()) || DEFAULT_COMPANY_GAPS, fileName: name });

    res.status(202).json({ id, status: 'queued', fileName: name });
  } catch (err) {
    console.error('Analysis enqueue error:', err.message);
    res.status(502).json({ error: err.message || 'Could not queue analysis. Please try again.' });
  }
});

// --- Merged analysis endpoint (ASYNC — Phase 1 item #2) ---
// Frontend sends: { documents: [{ filename, text }, ...], strengths, gaps }
// Combines MULTIPLE documents belonging to the same RFP opportunity into a
// SINGLE background job (one Gemini call once it runs) instead of blocking
// the request while Gemini reads every exhibit. Returns a job id right
// away; the frontend polls GET /api/jobs/:id until status is
// 'completed' or 'failed'.
app.post('/api/analyze-merged', async (req, res) => {
  try {
    const { documents, strengths, gaps } = req.body;

    if (!Array.isArray(documents) || documents.length === 0) {
      return res.status(400).json({ error: 'documents array is missing or empty.' });
    }
    for (const d of documents) {
      if (!d.text || typeof d.text !== 'string' || d.text.trim().length < 50) {
        return res.status(400).json({ error: `Document "${d.filename || 'unknown'}" has no readable text.` });
      }
    }

    const fileName = documents.length > 1
      ? `${documents.length} documents merged: ${documents.map(d => d.filename).join(', ')}`
      : documents[0].filename;

    const id = crypto.randomUUID();
    const mergedSourceText = documents.map(d => `--- ${d.filename} ---\n${d.text}`).join('\n\n');
    db.createQueued({ id, fileName, sourceText: mergedSourceText });
    await enqueueAnalysis(id, { kind: 'merged', id, documents, strengths: (strengths && strengths.trim()) || DEFAULT_COMPANY_STRENGTHS, gaps: (gaps && gaps.trim()) || DEFAULT_COMPANY_GAPS, fileName });

    res.status(202).json({ id, status: 'queued', fileName });
  } catch (err) {
    console.error('Merged analysis enqueue error:', err.message);
    res.status(502).json({ error: err.message || 'Could not queue analysis. Please try again.' });
  }
});

// --- Job status / result polling ---
// The frontend calls this every couple seconds after receiving a job id
// from /api/analyze or /api/analyze-merged. Status is one of:
// 'queued' | 'active' | 'completed' | 'failed'. `data` is only populated
// once status is 'completed'.
app.get('/api/jobs/:id', (req, res) => {
  const job = db.getById(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  res.json(job);
});

// --- Proposal generation (Phase 3, item #8) ---
// Frontend sends: { analysisId } — the id of an already-completed analysis.
// Kicks off the 3-agent pipeline (Compliance -> Writer -> Reviewer) as its
// own background job, same async/poll pattern as /api/analyze. Poll the
// returned id via the existing GET /api/jobs/:id.
app.post('/api/proposal/generate', async (req, res) => {
  try {
    const { analysisId } = req.body;
    if (!analysisId || typeof analysisId !== 'string') {
      return res.status(400).json({ error: 'analysisId is required.' });
    }

    const analysisJob = db.getById(analysisId);
    if (!analysisJob) {
      return res.status(404).json({ error: 'Analysis not found.' });
    }
    if (analysisJob.status !== 'completed' || !analysisJob.data) {
      return res.status(409).json({ error: `That analysis is not ready yet (status: ${analysisJob.status}).` });
    }

    const sourceText = db.getSourceText(analysisId);
    if (!sourceText) {
      return res.status(409).json({ error: 'Original RFP text is no longer available for this analysis. Re-run the analysis to enable proposal generation.' });
    }

    const id = crypto.randomUUID();
    const fileName = `Proposal draft: ${analysisJob.fileName}`;
    db.createQueued({ id, fileName, sourceText });
    await enqueueAnalysis(id, {
      kind: 'proposal',
      id,
      analysisId,
      sourceText,
      analysisData: analysisJob.data,
      strengths: DEFAULT_COMPANY_STRENGTHS,
      gaps: DEFAULT_COMPANY_GAPS,
      fileName
    });

    res.status(202).json({ id, status: 'queued', fileName });
  } catch (err) {
    console.error('Proposal enqueue error:', err.message);
    res.status(502).json({ error: err.message || 'Could not queue proposal generation. Please try again.' });
  }
});

// --- Addendum diff endpoint (Phase 3, item #12) ---
// Frontend sends: { analysisId, newText, newFileName }
// analysisId points at a PAST completed analysis whose original RFP text we
// already have saved (db.getSourceText — the same column item #8 added).
// newText is the freshly-extracted text of the amended/re-uploaded RFP the
// user just gave us (via the existing POST /api/extract endpoint — this
// route never re-implements file parsing, it just receives text).
// This goes through the same queue/job system as every other slow request
// (see processAddendumDiffJob below), so it's pollable via the SAME
// GET /api/jobs/:id endpoint everything else already uses — no new polling
// route needed.
app.post('/api/addendum-diff', async (req, res) => {
  try {
    const { analysisId, newText, newFileName } = req.body;
    if (!analysisId || typeof analysisId !== 'string') {
      return res.status(400).json({ error: 'analysisId is required.' });
    }
    if (!newText || typeof newText !== 'string' || newText.trim().length < 50) {
      return res.status(400).json({ error: 'newText is missing or too short. Upload a valid amended RFP.' });
    }

    const analysisJob = db.getById(analysisId);
    if (!analysisJob) {
      return res.status(404).json({ error: 'Original analysis not found.' });
    }
    if (analysisJob.status !== 'completed' || !analysisJob.data) {
      return res.status(409).json({ error: `That analysis is not ready yet (status: ${analysisJob.status}).` });
    }

    const oldText = db.getSourceText(analysisId);
    if (!oldText) {
      return res.status(409).json({ error: 'Original RFP text is no longer available for this analysis. Re-run the analysis to enable addendum tracking.' });
    }

    const id = crypto.randomUUID();
    const fileName = `Addendum diff: ${analysisJob.fileName}`;
    db.createQueued({ id, fileName });
    await enqueueAnalysis(id, {
      kind: 'addendum-diff',
      id,
      originalAnalysisId: analysisId,
      oldFileName: analysisJob.fileName,
      newFileName: newFileName || 'Amended RFP',
      oldText,
      newText,
      fileName
    });

    res.status(202).json({ id, status: 'queued', fileName });
  } catch (err) {
    console.error('Addendum diff enqueue error:', err.message);
    res.status(502).json({ error: err.message || 'Could not queue addendum comparison. Please try again.' });
  }
});

// ===========================================================================
// PHASE 4, item #15 — "Chat with this RFP".
//
// Purpose: let someone ask direct questions about a specific, already-
// analysed RFP ("what's the insurance requirement?", "is subcontracting
// allowed?") and get an answer sourced back to the actual document text,
// instead of re-reading the whole checklist output or the original PDF by
// eye. This is intentionally NOT the same retrieval path as the Phase 4
// item #13 proposal-library search: that feature does semantic search
// across a whole CORPUS of many past-won proposals (so embeddings + cosine
// similarity earn their keep). Here there is exactly one document already
// in hand for the whole conversation, well within a single prompt's budget
// (see CHAT_SOURCE_TEXT_MAX_CHARS above) — running it through an embed/
// chunk/rank pipeline would add latency and an extra Gemini call for no
// retrieval benefit. Same deterministic-first spirit as the rest of the
// app, though: the model is instructed to answer ONLY from the supplied
// text and to say so plainly when something isn't in it, and every answer
// carries a short verbatim quote back to the source so a person can verify
// it against the original document rather than take the answer on faith.
// Synchronous (one Gemini call, same as /api/proposals/library/search) —
// no job queue/poll needed, this is meant to feel like an actual chat.
// ===========================================================================

const CHAT_ANSWER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    found_in_document: { type: 'BOOLEAN' },
    supporting_quote: { type: 'STRING' },
    location_hint: { type: 'STRING' }
  },
  required: ['answer', 'found_in_document', 'supporting_quote', 'location_hint']
};

function buildChatPrompt(fileName, sourceText, history, question) {
  // Only replay the most recent N turns (see CHAT_MAX_HISTORY_TURNS) so a
  // long-running chat session doesn't keep growing the prompt forever.
  const recentHistory = Array.isArray(history) ? history.slice(-CHAT_MAX_HISTORY_TURNS) : [];
  const historyText = recentHistory.length
    ? recentHistory.map(h => `Q: ${h.question}\nA: ${h.answer}`).join('\n\n')
    : '(none yet — this is the first question)';

  return `You are answering questions about a single RFP (Request for Proposal) document named "${fileName}", for someone who is deciding whether/how to bid on it. Answer ONLY using the RFP TEXT given below. Do not use outside knowledge about this company, this procurement, or RFPs in general, and do not guess, infer, or fill in anything the text does not actually say.

RFP TEXT:
"""
${String(sourceText || '').slice(0, CHAT_SOURCE_TEXT_MAX_CHARS)}
"""

PRIOR CONVERSATION (for context on follow-up questions like "what about the second one?"):
${historyText}

NEW QUESTION: ${question}

Return ONLY a JSON object matching the schema:
- "answer": a direct, plain-English answer to the question. If the document doesn't address it, say so plainly (e.g. "This RFP does not specify a page limit.") instead of guessing.
- "found_in_document": true if the RFP text actually contains information that answers the question; false if you are reporting that it's not stated.
- "supporting_quote": when found_in_document is true, a SHORT excerpt (under ~25 words) copied verbatim from the RFP TEXT above that backs up the answer, so it can be verified against the source. Empty string when found_in_document is false.
- "location_hint": a page or section reference if one is visible near the supporting text (e.g. "Page 4" or "Section 3.2" or "--- Page 7 ---" marker), else empty string. Never invent a page/section number that isn't actually shown in the text.`;
}

app.post('/api/analyses/:id/chat', async (req, res) => {
  try {
    const { id } = req.params;
    const { question, history } = req.body;

    if (!question || typeof question !== 'string' || question.trim().length < 2) {
      return res.status(400).json({ error: 'question is required.' });
    }
    if (history !== undefined && !Array.isArray(history)) {
      return res.status(400).json({ error: 'history, if provided, must be an array.' });
    }

    const analysisJob = db.getById(id);
    if (!analysisJob) {
      return res.status(404).json({ error: 'Analysis not found.' });
    }
    if (analysisJob.status !== 'completed' || !analysisJob.data) {
      return res.status(409).json({ error: `That analysis is not ready yet (status: ${analysisJob.status}).` });
    }

    const sourceText = db.getSourceText(id);
    if (!sourceText) {
      return res.status(409).json({ error: 'Original RFP text is no longer available for this analysis. Re-run the analysis to enable chat.' });
    }

    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    const prompt = buildChatPrompt(analysisJob.fileName, sourceText, history, question.trim());
    const result = await callGeminiJSON(prompt, model, CHAT_ANSWER_SCHEMA);

    res.json({
      question: question.trim(),
      answer: result.answer || '',
      foundInDocument: !!result.found_in_document,
      supportingQuote: result.supporting_quote || '',
      locationHint: result.location_hint || ''
    });
  } catch (err) {
    console.error('RFP chat error:', err.message);
    res.status(502).json({ error: err.message || 'Could not answer that question. Please try again.' });
  }
});

// ===========================================================================
// PHASE 4, item #13 — Past-proposal RAG library.
//
// Purpose: when writing a new proposal, the fastest way to answer "how did
// we answer a similar requirement before?" is to search actual PAST WON
// proposals, not re-derive an answer from scratch every time. This adds a
// small library: upload past proposals, they get chunked + embedded in the
// background, and /search does semantic retrieval over them. #16 (the
// proposal generation engine) will call the same search function to pull
// relevant past language into new drafts — this ships the library +
// retrieval first since there's no existing corpus to seed it with yet.
// ===========================================================================

// --- Upload / ingest a past-won proposal into the library -----------------
// Frontend sends a single file (multipart/form-data, field name "file"),
// same upload middleware /api/extract already uses. Text is extracted
// synchronously (fast, no Gemini call), but chunking + embedding every
// chunk DOES call Gemini repeatedly, so — same pattern as every other
// Gemini-calling route in this file — that part is handed off to the
// background job queue and polled via the existing GET /api/jobs/:id.
app.post('/api/proposals/library', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }
    const { buffer, mimetype, originalname } = req.file;

    const { text, ocrUsed } = await extractTextFromUpload(buffer, mimetype, originalname);
    if (text.length < 50) {
      return res.status(422).json({ error: 'Could not extract readable text from this file, even with OCR fallback. Try a different file.' });
    }

    const documentId = crypto.randomUUID();
    db.createProposalDocument({ id: documentId, fileName: originalname, ocrUsed });

    // Re-uses the same `analyses` table as every other background job for
    // polling (kind distinguishes it) — no separate job-status table needed.
    const jobId = crypto.randomUUID();
    db.createQueued({ id: jobId, fileName: `Ingest: ${originalname}` });
    await enqueueAnalysis(jobId, { kind: 'proposal-ingest', id: jobId, documentId, fileName: originalname, text });

    res.status(202).json({ jobId, documentId, status: 'queued', fileName: originalname, ocrUsed });
  } catch (err) {
    console.error('Proposal library upload error:', err.message);
    res.status(502).json({ error: err.message || 'Could not ingest this proposal. Please try again.' });
  }
});

// --- List / delete library documents ---------------------------------------
app.get('/api/proposals/library', (req, res) => {
  res.json(db.listProposalDocuments());
});

app.delete('/api/proposals/library/:id', (req, res) => {
  db.deleteProposalDocument(req.params.id);
  res.json({ ok: true });
});

// --- Semantic search over the library --------------------------------------
// Frontend sends: { query, topK? }. Embeds the query with the SAME
// embedding model every stored chunk was embedded with (mixing embedding
// models would make the cosine-similarity comparison meaningless), then
// ranks every ready chunk in the library by similarity. Synchronous (one
// embedding call, then cheap in-memory math) — no job/poll needed here.
app.post('/api/proposals/library/search', async (req, res) => {
  try {
    const { query, topK } = req.body;
    if (!query || typeof query !== 'string' || query.trim().length < 3) {
      return res.status(400).json({ error: 'query is required (min 3 characters).' });
    }
    const k = Math.min(Math.max(Number(topK) || RAG_SEARCH_DEFAULT_TOP_K, 1), 20);

    const chunks = db.getAllProposalChunks();
    if (chunks.length === 0) {
      return res.json({ query, results: [] });
    }

    const queryEmbedding = await callGeminiEmbedding(query, GEMINI_EMBEDDING_MODEL);
    const ranked = chunks
      .map(c => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(c => ({
        documentId: c.documentId,
        fileName: c.fileName,
        chunkIndex: c.chunkIndex,
        text: c.text,
        score: Math.round(c.score * 1000) / 1000
      }));

    res.json({ query, results: ranked });
  } catch (err) {
    console.error('Proposal library search error:', err.message);
    res.status(502).json({ error: err.message || 'Search failed. Please try again.' });
  }
});

// --- History endpoints (server-side, replaces browser localStorage) ---
// Every completed analysis is already saved permanently by the worker
// (see db.saveResult below), so history survives page reloads, browser
// clears, and works across devices — it's just a database read now.
app.get('/api/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  res.json(db.listCompleted(limit));
});

app.delete('/api/history/:id', (req, res) => {
  db.remove(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/history', (req, res) => {
  db.clearAll();
  res.json({ ok: true });
});

// PHASE 5, item #21 — record a bid's real-world outcome (won/lost/no_bid),
// separately from the AI's GO/CAUTION/NO-GO verdict. This is what makes a
// "win rate" on the aggregate dashboard mean something — without it there's
// nothing to divide won-count by. Defaults to 'pending' until set.
app.patch('/api/history/:id/outcome', (req, res) => {
  const job = db.getById(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Analysis not found.' });
  }
  try {
    const updated = db.setOutcome(req.params.id, req.body.outcome);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PHASE 5, item #21 — aggregate dashboard: win rate, average fit score, and
// totals rolled up across every completed RFP analysis. Pure read of
// already-saved data (db.getDashboardStats does the aggregation), so this
// is synchronous — no job/poll needed.
app.get('/api/dashboard', (req, res) => {
  res.json(db.getDashboardStats());
});

// ===========================================================================
// PHASE 5, item #17 — Team notes/comments on checklist items.
//
// A note is scoped to a specific item inside a completed analysis, using an
// "itemRef" string the FRONTEND builds (e.g. "financial_checklist:2" or
// "deliverables:0:3") so the server never needs to know the shape of the
// analysis JSON — it just stores/returns a ref, a label, an author, and
// text. No auth system exists in this app, so "author" is just a free-text
// name field the person types in — good enough for an internal team tool,
// not meant to be tamper-proof.
// ===========================================================================

// GET /api/analyses/:id/notes — all notes for one analysis, oldest first.
app.get('/api/analyses/:id/notes', (req, res) => {
  const job = db.getById(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Analysis not found.' });
  }
  res.json(db.listNotesByAnalysis(req.params.id));
});

// POST /api/analyses/:id/notes — add a note to one checklist item.
app.post('/api/analyses/:id/notes', (req, res) => {
  const { itemRef, itemLabel, author, text } = req.body;
  const job = db.getById(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Analysis not found.' });
  }
  if (!itemRef || typeof itemRef !== 'string') {
    return res.status(400).json({ error: 'itemRef is required.' });
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }
  const note = db.addNote({
    analysisId: req.params.id,
    itemRef,
    itemLabel: itemLabel || null,
    author: (author && author.trim()) || 'Anonymous',
    text: text.trim()
  });
  res.status(201).json(note);
});

// DELETE /api/analyses/:id/notes/:noteId — remove a single note.
app.delete('/api/analyses/:id/notes/:noteId', (req, res) => {
  db.deleteNote(req.params.noteId);
  res.json({ ok: true });
});

// ===========================================================================
// EXPORT ENDPOINTS (JSON + PDF) — added per team request:
//   1) an "output in JSON" option to sit alongside the existing PDF/HTML
//      checklist export, and
//   2) real HTTP API endpoints that hand back an analysis in JSON (so any
//      other tool/script — not just this frontend — can pull a result by
//      job id without scraping HTML).
//
// Both live under /api/analyses/:id/export.* and both require the analysis
// referenced by :id to already be 'completed' (i.e. the Gemini job finished
// and a result was saved by the worker) — a queued/active/failed job has no
// result yet, so we return 409 Conflict rather than an empty/broken file.
// ===========================================================================

// Turns an arbitrary uploaded file name into a safe download file name
// (letters/numbers/dash/underscore only, capped length) so nothing weird
// ends up in a Content-Disposition header.
function safeExportFileBase(fileName) {
  const cleaned = String(fileName || 'rfp-analysis')
    .replace(/\.[^./\\]+$/, '')       // drop original extension, if any
    .replace(/[^a-z0-9\-_]+/gi, '_')  // anything else -> underscore
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || 'rfp-analysis').slice(0, 80);
}

// GET /api/analyses/:id/export.json
// Returns the full analysis (fit score, recommendation, all four checklists,
// deliverables, insurance figures, disqualifiers) as a downloadable .json
// file, plus a bit of job metadata (id/fileName/timestamps) that isn't part
// of the raw Gemini result but is useful context for whoever consumes it.
app.get('/api/analyses/:id/export.json', (req, res) => {
  const job = db.getById(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Analysis not found.' });
  }
  if (job.status !== 'completed' || !job.data) {
    return res.status(409).json({ error: `Analysis is not ready yet (status: ${job.status}).` });
  }

  const payload = {
    id: job.id,
    fileName: job.fileName,
    createdAt: job.createdAt,
    completedAt: job.savedAt,
    ...job.data
  };

  const base = safeExportFileBase(job.fileName);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${base}-analysis.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// GET /api/proposals/:id/export.txt (Phase 3, item #8)
// Downloads the final draft the 3-agent pipeline produced, as plain text.
app.get('/api/proposals/:id/export.txt', (req, res) => {
  const job = db.getById(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Proposal not found.' });
  }
  if (job.status !== 'completed' || !job.data || job.data.kind !== 'proposal') {
    return res.status(409).json({ error: `That proposal is not ready yet (status: ${job.status}).` });
  }

  const base = safeExportFileBase(job.fileName);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.txt"`);
  res.send(job.data.final_proposal_text || '');
});

// GET /api/analyses/:id/export.pdf
// Generates a real PDF (not a print-to-PDF of HTML) server-side with
// pdfkit, covering the same checklist data as the JSON export above, and
// streams it straight to the response.
app.get('/api/analyses/:id/export.pdf', (req, res) => {
  const job = db.getById(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Analysis not found.' });
  }
  if (job.status !== 'completed' || !job.data) {
    return res.status(409).json({ error: `Analysis is not ready yet (status: ${job.status}).` });
  }

  try {
    const base = safeExportFileBase(job.fileName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${base}-report.pdf"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    doc.pipe(res);
    renderPdfReport(doc, job.data, job.fileName);
    doc.end();
  } catch (err) {
    console.error('PDF export error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not generate PDF report.' });
    }
  }
});

// --- PDF layout helpers -----------------------------------------------
const PDF_COLORS = { go: '#1f9d6b', nogo: '#d6453d', caution: '#b8860b', muted: '#666666', text: '#1a1a1a' };

function pdfDecisionColor(decision) {
  const d = String(decision || '').toUpperCase();
  if (d === 'GO') {
    return PDF_COLORS.go;
  }
  if (d === 'NO-GO') {
    return PDF_COLORS.nogo;
  }
  if (d.includes('ESCALATE') || d.includes('REVIEW') || d.includes('ACTION')) {
    return PDF_COLORS.caution;
  }
  return PDF_COLORS.text;
}

// Adds a new page if we're near the bottom margin, so a section header
// never ends up alone at the foot of a page with its content pushed over.
function pdfEnsureSpace(doc, needed = 60) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

function pdfSectionTitle(doc, title) {
  pdfEnsureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.fontSize(13).fillColor(PDF_COLORS.text).font('Helvetica-Bold').text(title);
  doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor('#dddddd').lineWidth(1).stroke();
  doc.moveDown(0.4);
  doc.font('Helvetica');
}

// Renders one FINANCIAL/LEGAL/OPERATIONS/TECHNICAL checklist array as a
// simple bullet list: item name, Yes/No + decision on one line, reason
// underneath in muted text.
function pdfChecklist(doc, title, items) {
  if (!Array.isArray(items) || !items.length) {
    return;
  }
  pdfSectionTitle(doc, title);
  items.forEach((item) => {
    pdfEnsureSpace(doc, 50);
    doc.fontSize(10).fillColor(PDF_COLORS.text).font('Helvetica-Bold')
      .text(`• ${item.item || 'Unnamed item'}`, { continued: false });
    doc.font('Helvetica').fontSize(9).fillColor(PDF_COLORS.muted);
    const answer = item.answer || 'N/A';
    const decision = item.decision || '—';
    doc.fillColor(pdfDecisionColor(decision))
      .text(`   Answer: ${answer}    Decision: ${decision}${item.confidence ? `    Confidence: ${item.confidence}%` : ''}`);
    if (item.reason) {
      doc.fillColor(PDF_COLORS.muted).text(`   ${item.reason}`, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 10 });
    }
    doc.moveDown(0.3);
  });
}

// Renders the deliverables checklist (grouped by category, with a due date
// per category) as nested bullets.
function pdfDeliverables(doc, categories) {
  if (!Array.isArray(categories) || !categories.length) {
    return;
  }
  pdfSectionTitle(doc, '📋 Deliverables Checklist');
  categories.forEach((cat) => {
    pdfEnsureSpace(doc, 40);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(PDF_COLORS.text)
      .text(`${cat.category || 'Uncategorized'}${cat.due_date && cat.due_date !== 'N/A' ? `  (Due: ${cat.due_date})` : ''}`);
    doc.font('Helvetica');
    (cat.items || []).forEach((item) => {
      pdfEnsureSpace(doc, 30);
      doc.fontSize(9).fillColor(pdfDecisionColor(item.decision))
        .text(`   - ${item.item || 'Unnamed deliverable'}  [${item.mandatory === 'NO' ? 'Optional' : 'Mandatory'} · ${item.decision || '—'}]`);
      if (item.reason) {
        doc.fillColor(PDF_COLORS.muted).text(`     ${item.reason}`, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 20 });
      }
    });
    doc.moveDown(0.3);
  });
}

// Renders the insurance_figures array as a plain table (coverage type /
// amount / basis / applies-to-this-contract).
function pdfInsuranceFigures(doc, figures) {
  if (!Array.isArray(figures) || !figures.length) {
    return;
  }
  pdfSectionTitle(doc, '🛡️ Insurance Figures Extracted');
  figures.forEach((f) => {
    pdfEnsureSpace(doc, 24);
    const amount = f.amount === null || f.amount === undefined
      ? (f.is_statutory ? 'Statutory (no fixed $ amount)' : 'Not specified')
      : `$${Number(f.amount).toLocaleString()}`;
    const applies = f.applies_to_this_contract === false ? 'NOT APPLICABLE' : 'APPLIES';
    doc.fontSize(9).fillColor(PDF_COLORS.text).font('Helvetica-Bold')
      .text(`• ${f.coverage_type || 'Unspecified coverage'}: `, { continued: true })
      .font('Helvetica').fillColor(PDF_COLORS.muted)
      .text(`${amount} — ${applies}${f.basis ? ` (${f.basis})` : ''}`);
  });
}

// Top-level entry point: lays out the whole report onto `doc` in order.
// Called for both the standalone export.pdf route.
function renderPdfReport(doc, data, fileName) {
  const rec = (data.recommendation || 'CAUTION').toUpperCase();
  const recColor = pdfDecisionColor(rec);
  const score = typeof data.fit_score === 'number' ? data.fit_score : '—';

  doc.fontSize(18).font('Helvetica-Bold').fillColor(PDF_COLORS.text).text('RFP Analysis Report');
  doc.fontSize(11).font('Helvetica').fillColor(PDF_COLORS.muted).text(fileName || 'RFP Document');
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor(PDF_COLORS.muted).text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(0.8);

  // Recommendation + fit score banner
  doc.fontSize(14).font('Helvetica-Bold').fillColor(recColor).text(`Recommendation: ${rec}    Fit Score: ${score}/100`);
  if (data.deadline_date_iso) {
    doc.fontSize(10).font('Helvetica').fillColor(PDF_COLORS.text).text(`Deadline: ${data.deadline_date_iso}`);
  }
  doc.moveDown(0.3);
  if (data.recommendation_summary) {
    doc.fontSize(10).font('Helvetica').fillColor(PDF_COLORS.text)
      .text(data.recommendation_summary, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  }

  if (Array.isArray(data.disqualifiers) && data.disqualifiers.length) {
    doc.moveDown(0.4);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(PDF_COLORS.nogo).text('⚠ Disqualifiers');
    doc.font('Helvetica').fontSize(9).fillColor(PDF_COLORS.text);
    data.disqualifiers.forEach(d => doc.text(`• ${d}`));
  }

  if (data.cross_check && data.cross_check.status === 'disagreement') {
    doc.moveDown(0.4);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(PDF_COLORS.nogo).text(`⚠ Second-Model Cross-Check (${data.cross_check.model})`);
    doc.font('Helvetica').fontSize(9).fillColor(PDF_COLORS.text);
    data.cross_check.items.filter(i => !i.agrees).forEach(i => {
      doc.text(`• ${i.label}: primary="${i.primary_value}" vs cross-check="${i.cross_check_value}"`);
    });
  }

  pdfDeliverables(doc, data.deliverables_checklist);
  pdfInsuranceFigures(doc, data.insurance_figures);
  pdfChecklist(doc, '💰 Financial / Accounting Checklist', data.financial_checklist);
  pdfChecklist(doc, '⚖️ Legal Checklist', data.legal_checklist);
  pdfChecklist(doc, '🏢 Operations Checklist', data.operations_checklist);
  pdfChecklist(doc, '🔧 Technical Checklist', data.technical_checklist);
}

// ===========================================================================
// PHASE 2 — Deterministic + AI hybrid (Team-RFP-Intelligence Phase 2, items
// #5 confidence scoring and #6 expanded deterministic/AI hybrid).
//
// Philosophy: the LLM's job is ONLY text understanding — find the sentence,
// extract the figure, rate how sure it is. Every judgment call that can be
// expressed as a fixed business rule (a threshold, a date comparison, a
// veto list) is made here in plain JS, using values the LLM extracted, so
// the same inputs always produce the same GO/NO-GO answer and a business
// rule can be retuned in .env without touching the prompt or re-testing the
// model's arithmetic. Each sub-function below does exactly one rule and
// they run in a fixed, documented order (see applyDeterministicChecks).
// ===========================================================================

const CHECKLIST_KEYS = [
  'financial_checklist',
  'legal_checklist',
  'operations_checklist',
  'technical_checklist'
];

// --- Phase 2, item #5: Confidence scoring -------------------------------
// The LLM self-rates each checklist item's "confidence" (0-100, see the
// CONFIDENCE SCORING RULE in buildPrompt/buildMergedPrompt). We never trust
// that number blindly for a business decision — we just use it to decide
// whether a human needs to look at this specific line before anyone acts on
// it. A missing/unparseable confidence is treated as 0 (least trusted),
// never assumed to be fine.
function reviewChecklistItem(item) {
  if (!item || typeof item !== 'object') {
    return item;
  }

  let confidence = Number(item.confidence);
  if (isNaN(confidence)) {
    confidence = 0;
  }
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));
  item.confidence = confidence;

  const unverifiedText = /not explicitly stated|verify manually/i.test(item.reason || '');
  item.needs_human_review = confidence < CONFIDENCE_REVIEW_THRESHOLD || unverifiedText;

  // Deterministic downgrade: a low-confidence extraction is never allowed to
  // sit silently at "GO" — someone has to confirm it first. We only ever
  // downgrade an existing decision, never upgrade one or invent a new value.
  if (item.needs_human_review && (item.decision || '').toUpperCase() === 'GO') {
    item.decision = 'NEEDS REVIEW';
  }
  return item;
}

function runConfidenceReview(out) {
  let total = 0, low = 0, sum = 0;

  const reviewArray = (arr) => {
    if (!Array.isArray(arr)) {
      return;
    }
    arr.forEach(item => {
      reviewChecklistItem(item);
      total += 1;
      sum += item.confidence;
      if (item.needs_human_review) {
        low += 1;
      }
    });
  };

  CHECKLIST_KEYS.forEach(key => reviewArray(out[key]));
  if (Array.isArray(out.deliverables_checklist)) {
    out.deliverables_checklist.forEach(cat => reviewArray(cat.items));
  }

  // Summary the frontend can show as a single banner ("14 of 32 items need
  // human review") instead of making the reader hunt through every table.
  out.confidence_summary = {
    average_confidence: total ? Math.round(sum / total) : null,
    low_confidence_count: low,
    total_items_scored: total,
    review_threshold: CONFIDENCE_REVIEW_THRESHOLD
  };
  return out;
}

// --- Phase 2, item #6 (pre-existing rule): Insurance threshold check ----
// The LLM extracts the raw dollar figures it found (insurance_figures) plus
// whether each one is statutory (no fixed $) and, for tiered coverage like
// Cyber Liability, whether that specific tier applies to this contract.
// We only compare the threshold against entries that are (a) a real dollar
// figure and (b) actually applicable — so a Tier 3/medical-data cyber
// liability figure doesn't wrongly trigger NO-GO on a general web project
// just because it appears somewhere in the RFP's insurance exhibit.
function runInsuranceCheck(out) {
  if (Array.isArray(out.insurance_figures) && out.insurance_figures.length) {
    const applicableValues = out.insurance_figures
      .filter(f => f.is_statutory !== true && f.applies_to_this_contract !== false)
      .map(f => Number(f.amount))
      .filter(n => !isNaN(n) && n > 0);
    const highestSingle = applicableValues.length ? Math.max(...applicableValues) : null;
    out.insurance_highest_single_coverage = highestSingle;
    out.insurance_threshold_used = INSURANCE_THRESHOLD;
    out.insurance_exceeds_threshold = highestSingle !== null ? highestSingle > INSURANCE_THRESHOLD : null;

    // Flag if the model couldn't confidently determine tier applicability at all,
    // so the frontend can surface a "needs manual review" note.
    const undeterminedTiers = out.insurance_figures.filter(
      f => f.applies_to_this_contract === false && /could not be determined/i.test(f.tier_note || '')
    );
    out.insurance_tier_needs_review = undeterminedTiers.length > 0;
  }
  return out;
}

// --- SPS RFP Checklist, Financial/Accounting section: Payment Terms rule -
// "Take a GO decision if payment plan is NET30, if more than NET30 then
// escalate it to accounting." Same pattern as runInsuranceCheck above: the
// LLM only extracts the actual number of days from the RFP text
// (payment_terms_days on the "Payment Terms" financial_checklist item); the
// GO-vs-escalate comparison against PAYMENT_TERMS_MAX_DAYS_FOR_GO happens
// here in plain JS so it can't be reasoned into the wrong answer, and so a
// non-engineer can retune the threshold via .env without touching the
// prompt. If the RFP doesn't state a day count, this leaves the LLM's own
// decision (usually "NEEDS REVIEW") untouched rather than guessing.
function runPaymentTermsCheck(out) {
  if (!Array.isArray(out.financial_checklist)) {
    return out;
  }

  const paymentItem = out.financial_checklist.find(
    i => i && typeof i.item === 'string' && i.item.trim().toLowerCase() === 'payment terms'
  );
  if (!paymentItem) {
    return out;
  }

  const days = Number(paymentItem.payment_terms_days);
  out.payment_terms_threshold_used = PAYMENT_TERMS_MAX_DAYS_FOR_GO;

  if (paymentItem.payment_terms_days === null || paymentItem.payment_terms_days === undefined || isNaN(days)) {
    out.payment_terms_days_found = null;
    return out; // no day count found — leave the LLM's own decision as-is
  }

  out.payment_terms_days_found = days;

  if (days <= PAYMENT_TERMS_MAX_DAYS_FOR_GO) {
    paymentItem.decision = 'GO';
  } else {
    // Per SPS checklist: slower than NET30 is not an automatic NO-GO — it
    // must be escalated to accounting for a human decision.
    paymentItem.decision = 'ESCALATE TO ACCOUNTING';
    paymentItem.reason = `${paymentItem.reason || ''} [Payment terms are NET${days}, which exceeds the NET${PAYMENT_TERMS_MAX_DAYS_FOR_GO} threshold — escalated to accounting per SPS RFP Checklist.]`.trim();
  }
  return out;
}

// --- Phase 2, item #6 (expanded): fit_score → recommendation thresholds -
// The LLM is asked to guess its own GO/CAUTION/NO-GO label alongside
// fit_score, but two calls to the same model over the same text can drift
// (e.g. it writes fit_score 72 and recommendation "CAUTION" by mistake).
// The label a person actually sees is always recomputed here from the
// numeric score using one fixed rule, so it can never contradict the score
// next to it. This also caps a GO down to CAUTION when the insurance
// threshold rule above found a coverage requirement above what the company
// configured as its risk tolerance — a real business constraint, not a
// judgment call the LLM should be making.
function runFitScoreRecommendation(out) {
  const score = Number(out.fit_score);
  if (!isNaN(score)) {
    out.fit_score = Math.max(0, Math.min(100, Math.round(score)));
    out.recommendation = out.fit_score >= FIT_GO_THRESHOLD
      ? 'GO'
      : out.fit_score < FIT_NOGO_THRESHOLD
        ? 'NO-GO'
        : 'CAUTION';
  }

  if (out.insurance_exceeds_threshold === true && out.recommendation === 'GO') {
    out.recommendation = 'CAUTION';
    out.recommendation_summary = `⚠ Required insurance coverage exceeds your configured threshold ($${INSURANCE_THRESHOLD.toLocaleString()}) — capped from GO to CAUTION pending a risk review. ` + (out.recommendation_summary || '');
  }
  return out;
}

// --- Phase 2, item #6 (expanded): hard disqualifier veto -----------------
// The LLM's only job for disqualifiers is to find them in the text and list
// them (see prompt's "disqualifiers" field) — it does NOT decide what a
// disqualifier means for the recommendation. Any true hard disqualifier
// found unconditionally overrides the fit-score-based label above.
function runDisqualifierOverride(out) {
  if (Array.isArray(out.disqualifiers) && out.disqualifiers.length > 0) {
    out.recommendation = 'NO-GO';
    const warning = `⚠ ${out.disqualifiers.length} hard disqualifier(s) found in the RFP text — recommendation forced to NO-GO regardless of fit score. `;
    out.recommendation_summary = warning + (out.recommendation_summary || '');
  }
  return out;
}

// --- Phase 2, item #6 (pre-existing + expanded): deadline check ---------
// The LLM extracts deadline_date_iso (see DEADLINE RULE in the prompt); the
// pass/fail comparison against the real current date happens here, in code,
// so it can never be "reasoned" into the wrong answer. This is the LAST
// check to run and its NO-GO always wins over every rule above it — a
// passed deadline is a hard stop regardless of fit score or anything else.
// Expanded: also flags an approaching-but-not-yet-passed deadline as
// "urgent" (configurable window) so a fast-closing RFP doesn't get missed
// just because it technically still has time left.
function runDeadlineCheck(out) {
  if (out.deadline_date_iso) {
    const deadline = new Date(out.deadline_date_iso + 'T23:59:59');
    const now = new Date();
    const validDate = !isNaN(deadline.getTime());
    const passed = validDate && deadline.getTime() < now.getTime();
    out.deadline_passed = passed;

    if (passed) {
      out.recommendation = 'NO-GO';
      const warning = `⚠ SUBMISSION DEADLINE HAS PASSED (${out.deadline_date_iso}). This RFP cannot be submitted as-is — confirm whether an addendum has extended the deadline before proceeding. `;
      out.recommendation_summary = warning + (out.recommendation_summary || '');
    } else if (validDate) {
      const daysLeft = Math.ceil((deadline.getTime() - now.getTime()) / 86400000);
      out.deadline_days_remaining = daysLeft;
      out.deadline_urgent = daysLeft <= DEADLINE_URGENT_DAYS;
      if (out.deadline_urgent) {
        const urgentNote = `⏰ Only ${daysLeft} day(s) left to submit (deadline ${out.deadline_date_iso}). `;
        out.recommendation_summary = urgentNote + (out.recommendation_summary || '');
      }
    }
  } else {
    out.deadline_passed = null; // unknown — could not find/parse a deadline
  }
  return out;
}

// Orchestrator — fixed order matters: confidence review and the insurance
// extraction check run first (they only annotate data), then the fit-score
// label is computed from that data, then the disqualifier veto, then the
// deadline check last since a passed deadline must win over everything.
function applyDeterministicChecks(result) {
  let out = { ...result };
  out = runConfidenceReview(out);       // Phase 2, item #5
  out = runInsuranceCheck(out);         // Phase 2, item #6 (existing rule)
  out = runPaymentTermsCheck(out);      // SPS RFP Checklist, Financial section: NET30 rule
  out = runFitScoreRecommendation(out); // Phase 2, item #6 (expanded)
  out = runDisqualifierOverride(out);   // Phase 2, item #6 (expanded)
  out = runDeadlineCheck(out);          // Phase 2, item #6 (existing + expanded)
  return out;
}

// ===========================================================================
// PHASE 3, item #7 — Second-model cross-check.
//
// Purpose: everything above (confidence scoring, deterministic thresholds)
// still trusts ONE model's reading of the RFP text for the underlying facts
// (how many days, how many dollars, what date). If that model consistently
// misreads a clause, a confident-but-wrong number sails straight through.
// This step asks a DIFFERENT model — with no knowledge of the primary
// model's answers, only the raw RFP text — to independently re-derive the
// same handful of high-risk facts, then diffs the two. Agreement is a much
// stronger signal than one model's self-reported confidence; disagreement
// is a concrete, explainable reason to send something to a human.
//
// Scope is intentionally narrow: only the facts that actually drive a
// GO/NO-GO/escalate decision (payment terms days, deadline, insurance
// dollar figures, hard disqualifiers) — not a full second opinion on every
// checklist item, which would double Gemini spend for little extra safety.
// ===========================================================================

const CROSS_CHECK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    payment_terms_days: { type: 'INTEGER', nullable: true },
    deadline_date_iso: { type: 'STRING', nullable: true },
    insurance_figures: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          coverage_type: { type: 'STRING' },
          amount: { type: 'NUMBER', nullable: true }
        },
        required: ['coverage_type']
      }
    },
    disqualifiers: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['payment_terms_days', 'deadline_date_iso', 'insurance_figures', 'disqualifiers']
};

function buildCrossCheckPrompt(sourceText) {
  return `You are a second, independent reviewer auditing an RFP for four specific, high-risk facts. You have NOT seen any other analysis of this document — read ONLY the text below and extract these fields exactly as stated:

1. payment_terms_days — the number of days in the stated payment terms (e.g. "NET 45" -> 45). null if not stated anywhere.
2. deadline_date_iso — the RFP submission deadline, as YYYY-MM-DD. null if not stated.
3. insurance_figures — every SPECIFIC dollar coverage amount required (coverage_type + amount). Omit purely statutory ("as required by law", no fixed number) entries.
4. disqualifiers — any explicit hard disqualifier / mandatory exclusion stated in the RFP (e.g. "vendors currently in litigation with the state are ineligible to bid").

Return ONLY the JSON object matching the schema — no preamble, no commentary.

RFP TEXT:
"""${sourceText.slice(0, 100000)}"""`;
}

function pctDiff(a, b) {
  if (a == null || b == null || a === 0) {
    return null;
  }
  return Math.abs(a - b) / Math.abs(a) * 100;
}

// Runs the cross-check and merges its findings into the already-finalized
// result. Never throws — a cross-check failure (model error, bad JSON) is
// recorded as its own status rather than failing the whole analysis, since
// the primary analysis is already complete and usable on its own.
async function crossCheckHighRiskFields(sourceText, primary) {
  const summary = {
    model: GEMINI_CROSS_CHECK_MODEL,
    ran_at: new Date().toISOString(),
    items: [],
    disagreement_count: 0,
    status: 'ok'
  };

  if (!CROSS_CHECK_ENABLED || !sourceText) {
    summary.status = 'skipped';
    primary.cross_check = summary;
    return primary;
  }

  try {
    const verdict = await callGeminiJSON(buildCrossCheckPrompt(sourceText), GEMINI_CROSS_CHECK_MODEL, CROSS_CHECK_SCHEMA);

    // 1) Payment terms days
    const paymentItem = (primary.financial_checklist || []).find(
      i => i && typeof i.item === 'string' && i.item.trim().toLowerCase() === 'payment terms'
    );
    const primaryDays = paymentItem && paymentItem.payment_terms_days != null ? Number(paymentItem.payment_terms_days) : null;
    const otherDays = verdict.payment_terms_days == null ? null : Number(verdict.payment_terms_days);
    const daysAgree = (primaryDays == null && otherDays == null) || (primaryDays != null && otherDays != null && primaryDays === otherDays);
    summary.items.push({ field: 'payment_terms_days', label: 'Payment terms (days)', primary_value: primaryDays, cross_check_value: otherDays, agrees: daysAgree });

    // 2) Deadline date
    const primaryDeadline = primary.deadline_date_iso || null;
    const otherDeadline = verdict.deadline_date_iso || null;
    const deadlineAgree = (primaryDeadline || '').slice(0, 10) === (otherDeadline || '').slice(0, 10);
    summary.items.push({ field: 'deadline_date_iso', label: 'Submission deadline', primary_value: primaryDeadline, cross_check_value: otherDeadline, agrees: deadlineAgree });

    // 3) Highest applicable insurance figure (compares against the value
    // runInsuranceCheck already computed, so both sides mean "highest single
    // dollar requirement that actually applies to this contract").
    const primaryHighest = primary.insurance_highest_single_coverage ?? null;
    const otherAmounts = asArray(verdict.insurance_figures).map(f => Number(f && f.amount)).filter(n => !isNaN(n) && n > 0);
    const otherHighest = otherAmounts.length ? Math.max(...otherAmounts) : null;
    let insuranceAgree = primaryHighest == null && otherHighest == null;
    if (!insuranceAgree && primaryHighest != null && otherHighest != null) {
      const diff = pctDiff(primaryHighest, otherHighest);
      insuranceAgree = diff !== null && diff <= CROSS_CHECK_AMOUNT_TOLERANCE_PCT;
    }
    summary.items.push({ field: 'insurance_highest_coverage', label: 'Highest insurance coverage figure', primary_value: primaryHighest, cross_check_value: otherHighest, agrees: insuranceAgree });

    // 4) Disqualifiers — flag only if the second model found one the first
    // model's list doesn't already cover (a substring match either way,
    // since two models will phrase the same clause differently).
    const primaryDisq = asArray(primary.disqualifiers).map(s => String(s).toLowerCase().trim());
    const otherDisq = asArray(verdict.disqualifiers).map(s => String(s).toLowerCase().trim()).filter(Boolean);
    const newlyFound = otherDisq.filter(d => !primaryDisq.some(p => p.includes(d) || d.includes(p)));
    summary.items.push({
      field: 'disqualifiers',
      label: 'Hard disqualifiers',
      primary_value: primary.disqualifiers || [],
      cross_check_value: asArray(verdict.disqualifiers),
      agrees: newlyFound.length === 0,
      note: newlyFound.length ? `Second model found ${newlyFound.length} possible disqualifier(s) not in the primary list.` : undefined
    });

    summary.disagreement_count = summary.items.filter(i => !i.agrees).length;

    if (summary.disagreement_count > 0) {
      summary.status = 'disagreement';
      // Same pattern as the insurance-threshold cap in runFitScoreRecommendation:
      // a disagreement on a high-risk field is a real reason to pull a GO
      // back to CAUTION for human review, never to push a decision further
      // toward NO-GO on its own (that's still the deadline/disqualifier
      // checks' job).
      if (primary.recommendation === 'GO') {
        primary.recommendation = 'CAUTION';
      }
      const disagreedLabels = summary.items.filter(i => !i.agrees).map(i => i.label).join(', ');
      primary.recommendation_summary = `⚠ Second-model cross-check (${GEMINI_CROSS_CHECK_MODEL}) disagrees with the primary analysis on: ${disagreedLabels}. Please verify manually before proceeding. ` + (primary.recommendation_summary || '');
    }
  } catch (err) {
    summary.status = 'error';
    summary.error = err.message || 'Cross-check failed.';
    console.warn('[cross-check] failed:', summary.error);
  }

  primary.cross_check = summary;
  return primary;
}

function buildPrompt(rfpText, strengths, gaps) {
  // FIX #5: 60,000 characters (~15k tokens) was needlessly conservative for
  // a document whose value proposition is "read every exhibit". Gemini 2.5
  // Flash handles far more context; raise the ceiling substantially and log
  // when truncation still happens so it's visible, not silent.
  const CHAR_LIMIT = 400000;
  const wasTruncated = rfpText.length > CHAR_LIMIT;
  if (wasTruncated) {
    console.warn(`[WARN] RFP text truncated from ${rfpText.length} to ${CHAR_LIMIT} characters. Exhibits may be cut off — consider raising CHAR_LIMIT.`);
  }
  const truncated = wasTruncated ? rfpText.slice(0, CHAR_LIMIT) + '\n\n[TRUNCATED]' : rfpText;

  // FIX #2: give the model today's real date so it can compare it to the
  // RFP's stated due date instead of never checking at all.
  const todayIso = new Date().toISOString().slice(0, 10);

  return `You are a senior proposal/bid analyst. Read the ENTIRE RFP document below including ALL Exhibits (Exhibit A, Exhibit B, Exhibit C) and ALL Attachments carefully before answering. Do NOT skip exhibits — they contain critical insurance, legal, and compliance details.

TODAY'S DATE: ${todayIso}

===========================================================================
CRITICAL ANTI-HALLUCINATION RULE — READ THIS BEFORE ANYTHING ELSE:
The JSON template shown further below is a STRUCTURAL example only. Every
specific number, section letter, statute citation, dollar figure, or quoted
phrase inside that example is FAKE and must NEVER be reused, adapted,
paraphrased, or echoed in your real answer, even if it happens to sound
plausible for this RFP. Before writing any "reason" field:
  1. Search the actual RFP text below for a sentence that supports the claim.
  2. Copy the section number and figures from THAT sentence, character for
     character — do not round, approximate, or reconstruct from memory.
  3. If you cannot find a specific supporting sentence, write exactly:
     "Not explicitly stated in RFP — verify manually."
Reusing an example's wording or numbers when the source text says something
different (or says nothing) is a serious error. When in doubt, quote less
and say "verify manually" more.
===========================================================================

STRICT RULES:
1. Read EVERY section including Exhibit A (General Terms), Exhibit B (Special Terms - Insurance), Exhibit C (Additional Terms - Data/Security) before answering.
2. answer must be "YES", "NO", or "N/A" — based ONLY on what is actually written in the RFP.
3. reason must quote the EXACT page number AND section number, in the format "Page N, Section X.Y: <specific text/numbers from the RFP>" (e.g. "Page 5, Exhibit B Section B.2: requires Workers Compensation with statutory limits"). See the PAGE CITATION RULE below for how to determine the page number. Never say "Not mentioned" if it appears in exhibits. If it genuinely doesn't appear anywhere, say "Not explicitly stated in RFP — verify manually," never invent a plausible-sounding citation.
4. PAYMENT TERMS RULE: Search for NET30, "30 days," or similar payment-timing language. Report exactly what the RFP says, including which party it applies to (University paying Contractor, or Contractor paying subcontractors). Do not assume NET30 applies to the University's payments unless the text says so explicitly for that direction. On the "Payment Terms" item specifically, also include an integer field "payment_terms_days" = the number of days the University/buyer takes to pay the Contractor (e.g. 30 for NET30, 45 for NET45), or null if that direction of payment timing is not stated. Do NOT decide GO/escalate yourself — that comparison happens in code afterward using this number.
5. INSURANCE EXTRACTION RULE: Find every insurance coverage type and dollar figure stated in Exhibit B (and Exhibit C if it adds cyber/security-specific figures). For EACH one, add an entry to "insurance_figures": { "coverage_type": "...", "amount": <number, no $ or commas, or null if the coverage is statutory/no-fixed-amount>, "is_statutory": <true if the RFP says "statutory limits" with no dollar figure, e.g. Workers Compensation — false otherwise>, "basis": "per occurrence / aggregate / combined single limit / range — exactly as stated, or 'not specified'", "applies_to_this_contract": <true/false>, "tier_note": "<short explanation of why this entry does or doesn't apply>" }.
   TIERED COVERAGE HANDLING: Some RFPs (like this one's Cyber Liability section) define multiple risk TIERS (e.g. Tier 1/2/3) based on how sensitive the data access is, where only ONE tier applies to a given contract — they are not all simultaneously required. When you encounter tiered coverage:
     a. Read the RFP's Statement of Needs and any Data/Security exhibit to determine what kind of data THIS specific engagement actually involves (e.g. does the vendor access student PII/FERPA records, payment card data, or PHI/medical records, or is it limited to general/public website content?).
     b. Mark "applies_to_this_contract": true on the ONE tier that matches that data-sensitivity level, and "applies_to_this_contract": false on the other tiers, with a "tier_note" explaining which data-sensitivity factor drove the determination.
     c. If you cannot confidently determine which tier applies from the text, mark all tiers "applies_to_this_contract": false and set "tier_note" to "Tier applicability could not be determined from RFP text — requires manual review with the contracting officer."
   Do NOT invent a per-occurrence/aggregate split if the RFP only gives one combined figure or a range — report it exactly as written. Do not calculate GO/NO-GO yourself; just extract the real figures and tier applicability — the threshold comparison is done in code afterward.
6. E-VERIFY RULE: Search Exhibit A carefully for E-Verify. Quote the exact Virginia Code section number as written in the RFP — do not recall it from general knowledge of similar clauses in other RFPs.
7. WORKERS COMP RULE: Search Exhibit B Insurance section carefully.
8. DELIVERABLES RULE: Extract every concrete deliverable, document, form, attachment, or submission item the RFP requires the bidder to submit. Include due dates where stated. For EVERY child item's "reason" field, you MUST start with "Page N, Section X.Y:" (see PAGE CITATION RULE below for how to find N) followed by a short paraphrase of what that section actually requires — e.g. "Page 13, Section XI.B.2: requires Complete Pricing Pages, Contractor Data Sheet, and Substitute W-9 Form as attachments." Never leave a deliverable's reason vague or generic, and never omit the page number — a reader must be able to flip straight to that physical page in the RFP PDF and find the requirement.
   YOU MUST SPLIT DELIVERABLES INTO AT LEAST 3-5 SEPARATE CATEGORIES. Do NOT place every deliverable under one giant category, even if they share a due date — that defeats the purpose of grouping. Group by document TYPE, not by due date. Use categories like (adapt names to what the RFP actually contains):
     - "Cover Sheet & Signature Documents" (RFP cover page, addenda acknowledgments, signature pages)
     - "Required Attachments & Forms" (lettered/numbered attachments, W-9, data sheets)
     - "SWAM / Diversity Compliance Documents" (past and proposed SWAM plans, certifications)
     - "Written Narrative & Technical Response Sections" (statement-of-needs responses, evaluation-criteria narratives, exceptions tab)
     - "Pricing & Cost Submission" (pricing schedules, cost tables)
   If a category would end up with more than 6-7 items, split it further rather than leaving it oversized. A single category holding most or all of the deliverables is treated as an error — re-check your grouping before finalizing.
9. fit_score 0-100. Give your best estimate; write a "recommendation" of GO/CAUTION/NO-GO alongside it as your own first read — but note that the final label shown to the user is recalculated in code from fit_score using fixed thresholds (GO >=70, NO-GO <40, CAUTION otherwise), so your label is advisory, not authoritative.
9b. CONFIDENCE SCORING RULE: Every object in deliverables_checklist items, financial_checklist, legal_checklist, operations_checklist, and technical_checklist MUST include an integer "confidence" field (0-100) rating how directly the RFP text supports that specific "reason". This is NOT a measure of how important the item is — only how solid the evidence is. Score it honestly using this scale:
   - 90-100: You quoted/paraphrased an exact sentence with a real page + section citation that directly answers the question.
   - 60-89: You found clearly relevant text, but the answer required minor inference (e.g. the section implies it without using the exact word).
   - 30-59: The text is ambiguous, only tangentially related, or you had to combine weak signals from multiple places.
   - 0-29: You could not find supporting text at all and are relying on general knowledge of typical RFPs, or the reason is "Not explicitly stated in RFP — verify manually."
   Do NOT default every item to a high number — under-confident, honest scores are more useful than flattering ones, because low-confidence items get automatically flagged for human review in code afterward.
10. DEADLINE RULE: Find the RFP's stated proposal submission due date (usually on the cover page and/or in the Instructions section). Convert it to ISO format YYYY-MM-DD and put it in "deadline_date_iso". If no clear date is stated, set "deadline_date_iso" to null. Compare it to TODAY'S DATE above yourself as a sanity check, and if it has clearly already passed, mention that plainly in "recommendation_summary" as well (this will also be verified independently in code).
11. CITATION ACCURACY RULE: Copy statute numbers, section letters/numbers, and dollar figures character-for-character from the RFP text. Never approximate, round, or reconstruct them from memory of similar documents.
12. PAGE CITATION RULE: The RFP text below likely contains literal page-footer markers such as "Page 5 of 21" (the total page count varies by document) printed at the bottom of every page — this is real text extracted from the PDF, not something you need to guess. Scan the document for whatever that exact footer pattern is in THIS RFP before relying on it. For every "reason" field anywhere in your output (deliverables_checklist, financial_checklist, legal_checklist, operations_checklist, technical_checklist):
    a. Find the specific sentence in the RFP text that supports your claim.
    b. Scan FORWARD from that sentence to the next "Page N of M" (or similar) footer marker that appears after it — that marker tells you which page the sentence is printed on (the marker appears at the END of the page it belongs to, since it's a footer).
    c. Prefix the reason with "Page N, " followed by the section reference and a colon, e.g. "Page 5, Exhibit B Section B.2: ..." or "Page 13, Section XI.B.2: ...".
    d. If the content appears before the very first page marker in the text (e.g. cover page content), use "Page 1" for the cover page.
    e. If you genuinely cannot locate any nearby page marker, use "Page unknown, Section X.Y:" — but still include whatever section reference you did find. Never drop the section reference just because the page is uncertain, and never fabricate a page number you didn't actually locate via a marker.
13. Output ONLY valid JSON. No markdown. No trailing commas. No commentary.
14. RISK FLAGGING RULE: Separately from the general legal_checklist, identify any clauses that represent a genuine RISK to SPS — specifically: unfair/one-sided payment terms, uncapped or excessive liability exposure, unfavorable IP/ownership assignment clauses, or one-sided termination rights. For each one found, add an entry to "risk_flags": { "risk_type": "Unfair Payment Terms" | "Liability" | "IP Rights" | "Termination" | "Other", "severity": "LOW"|"MEDIUM"|"HIGH", "description": "<plain-language explanation of the risk>", "reason": "<Page N, Section X.Y: exact text>" }. Do NOT duplicate every legal_checklist item here — only genuine red flags a business owner would want called out on their own, separate from the routine compliance checklist. If none exist, return an empty array.
===========================================================================
SPS RFP EVALUATION CRITERIA (internal checklist — evaluate the RFP against
EVERY section below; this is the authoritative basis for your GO/CAUTION/
NO-GO judgment, on top of the STRICT RULES above):
===========================================================================
${SPS_RFP_CHECKLIST_FULL_TEXT}
===========================================================================

COMPANY STRENGTHS: ${strengths || '(not provided)'}
COMPANY GAPS: ${gaps || '(not provided)'}

RETURN THIS EXACT JSON STRUCTURE — every value below is a FAKE placeholder to show you the shape only. Replace ALL of them with real data found in the RFP text, following the anti-hallucination rule above:
{
  "fit_score": 0,
  "recommendation": "CAUTION",
  "recommendation_summary": "<write 2-3 sentences using only facts you actually found in the text below>",
  "deadline_date_iso": "<YYYY-MM-DD found in the RFP, or null if not found>",

  "deliverables_checklist": [
    {
      "category": "<a logical group name you choose, e.g. Proposal Submission Documents>",
      "due_date": "<deadline for this group as stated in the RFP, or N/A>",
      "items": [
        {
          "item": "<name of the specific document/form/attachment>",
          "mandatory": "YES",
          "decision": "ACTION REQUIRED",
          "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
        }
      ]
    }
  ],

  "insurance_figures": [
    {
      "coverage_type": "<e.g. Workers Compensation, Commercial General Liability, Cyber Liability Tier 1>",
      "amount": null,
      "is_statutory": false,
      "basis": "<per occurrence / aggregate / combined single limit / range — exactly as the RFP states it, or 'not specified'>",
      "applies_to_this_contract": true,
      "tier_note": "<if this is a tiered coverage, explain why this tier does/doesn't match this engagement's data sensitivity; otherwise 'Not tiered — applies as stated'>"
    }
  ],

  "financial_checklist": [
    {
      "item": "Payment Terms",
      "question": "What do the RFP's payment terms actually say, and to which party do they apply?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0, "payment_terms_days": 30
    },
    {
      "item": "Financial Stability Requirements",
      "question": "Does RFP require financial statements or proof of financial stability?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Unaudited Financial Statements",
      "question": "Are unaudited financial statements acceptable?",
      "answer": "N/A",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — start with Page N, Section X.Y: if it exists in the text below, otherwise write exactly 'Not explicitly stated in RFP — verify manually'>", "confidence": 0
    },
    {
      "item": "Profitability Analysis",
      "question": "Can expected revenue cover projected costs based on RFP pricing structure?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Bid Bond",
      "question": "Is a bid bond / proposal bond required?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    }
  ],

  "legal_checklist": [
    {
      "item": "Relevant Experience",
      "question": "Does RFP require relevant experience?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Registration Requirement",
      "question": "Is company registration required (eVA, SEC, or state)?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Financial Statement of Previous Year",
      "question": "Is previous year financial statement required?",
      "answer": "NO",
      "decision": "GO",
      "reason": "<verify — start with Page N, Section X.Y: if it exists in the text below, otherwise write exactly 'Not explicitly stated in RFP — verify manually'>", "confidence": 0
    },
    {
      "item": "Qualified Personnel",
      "question": "Does RFP specify qualified personnel requirements?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Technical Knowhow",
      "question": "Does RFP require specific technical expertise?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Expected Revenue Generation",
      "question": "Is contract value or expected revenue estimable from pricing schedule?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Period of Implementation",
      "question": "Is implementation period or contract duration defined?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Insurance Coverage",
      "question": "Are all required insurance coverages stated in Exhibit B?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — list the coverage TYPES only here; put dollar figures in insurance_figures instead>", "confidence": 0
    },
    {
      "item": "Compliance of Law",
      "question": "Does RFP require compliance with applicable laws and regulations?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Compliance Requirements (Data Protection)",
      "question": "Are FERPA, HIPAA, GLBA, PCI-DSS or other data protection requirements mentioned?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "State Registration",
      "question": "Is registration in the state (Virginia/eVA/SEC) required?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "E-Verify",
      "question": "Does RFP require use of E-Verify system? Check Exhibit A carefully.",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with Page N, Exhibit A Section S: followed by the EXACT Virginia Code section number as written in the RFP text below, do not recall from memory>", "confidence": 0
    },
    {
      "item": "Contractual Obligations",
      "question": "Are termination clauses, liability limits, and dispute resolution defined?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    }
  ],

  "operations_checklist": [
    {
      "item": "Insurance Requirement Form",
      "question": "Is a certificate of insurance or insurance form required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Information Form (Tax ID, Owner Name, Ownership %)",
      "question": "Is a company information form with Tax ID required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Small Business (SWAM)",
      "question": "Is Small Business (SWAM) certification required or evaluated?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "MBE Certification",
      "question": "Is MBE / minority business certification required or evaluated?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Workers Comp Insurance",
      "question": "Is Workers Compensation Insurance required? Check Exhibit B.",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Business with Iran",
      "question": "Is a declaration regarding business with Iran required?",
      "answer": "NO",
      "decision": "GO",
      "reason": "<verify — start with Page N, Section X.Y: if applicable, otherwise write exactly 'Not explicitly stated in RFP — verify manually'>", "confidence": 0
    },
    {
      "item": "Submission Deadlines",
      "question": "Are submission deadlines clearly stated?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with Page N, [Cover Page or Section X.Y]: followed by the exact date and time as written in the RFP text below>", "confidence": 0
    },
    {
      "item": "Document Compliance",
      "question": "Are formatting and submission requirements defined?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Signatory Authority",
      "question": "Is an authorized signatory required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Vendor Registration",
      "question": "Is vendor registration (eVA) required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    }
  ],

  "technical_checklist": [
    {
      "item": "Scope of Services Alignment",
      "question": "Does RFP scope align with company services and capabilities?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Technical Requirements",
      "question": "Do technical specs (Drupal, APIs, AI search) match company capabilities?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Compliance with Industry Standards",
      "question": "Does RFP require WCAG, Section 508, NIST or other industry standards?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Security Considerations",
      "question": "Are security requirements (encryption, access controls, data protection) stated?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    },
    {
      "item": "Integration Needs",
      "question": "Does project require system integrations (Drupal, APIs)?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>", "confidence": 0
    }
  ],

  "disqualifiers": [
    "<list only TRUE hard disqualifiers found explicitly in the text below, or leave this array empty>"
  ]
}"disqualifiers": [
    "<list only TRUE hard disqualifiers found explicitly in the text below, or leave this array empty>"
  ],

  "risk_flags": [
    {
      "risk_type": "Unfair Payment Terms",
      "severity": "MEDIUM",
      "description": "<plain-language explanation of why this is risky>",
      "reason": "<verify — Page N, Section X.Y: exact text found in the RFP below>"
    }
  ]
}

IMPORTANT: The JSON above shows the SHAPE of the answer only. Every "reason", quote, number, and citation must be replaced with something you actually verified in the RFP text below. If you did not find real support for a field, use "Not explicitly stated in RFP — verify manually" rather than filling in something plausible-sounding.

For deliverables_checklist: Use a TWO-LEVEL parent-child structure.
- "category" = a logical group name (e.g. "Proposal Submission Documents", "Required Attachments & Forms", "Technical & Narrative Sections", "SWAM & Compliance Documents")
- "due_date" = the deadline for that group (usually the main RFP deadline)
- "items" = array of individual deliverable items under that category
- Extract EVERY document, form, attachment (Attachment A, B, C, D, W-9, SWAM Plans, pricing pages, signed cover sheet, narrative sections, etc.) that the RFP requires the bidder to submit.
- For each item: mandatory YES/NO, decision ACTION REQUIRED or OPTIONAL, reason with exact RFP section.

RFP FULL TEXT (read every word including all Exhibits):
"""
${truncated}
"""`;
}

// --- Merged prompt builder (FIXED) ---
// Builds a single prompt covering MULTIPLE documents belonging to the same
// RFP opportunity. Every document is wrapped in clear START/END markers so
// the model can reliably tag each finding with the exact source filename
// via the required "source_document" field.
//
// IMPORTANT: this carries the SAME full checklist scaffold as the
// single-document buildPrompt (all ~30 named Financial/Legal/Operations/
// Technical items) so merged analyses are just as thorough as single-doc
// ones — the earlier version only gave Gemini one example item per section
// and a "same shape" note, which caused it to invent far fewer items than
// it should. Every example value below is a FAKE placeholder (per the
// anti-hallucination rule) and every item now also carries "source_document".
function buildMergedPrompt(documents, strengths, gaps) {
  const CHAR_LIMIT_PER_DOC = 200000;
  let combinedText = '';
  documents.forEach((d, i) => {
    const name = d.filename || `Document ${i + 1}`;
    let text = d.text || '';
    if (text.length > CHAR_LIMIT_PER_DOC) {
      console.warn(`[WARN] "${name}" truncated from ${text.length} to ${CHAR_LIMIT_PER_DOC} characters.`);
      text = text.slice(0, CHAR_LIMIT_PER_DOC) + '\n[TRUNCATED]';
    }
    combinedText += `\n\n===== DOCUMENT START: "${name}" =====\n${text}\n===== DOCUMENT END: "${name}" =====\n`;
  });

  const todayIso = new Date().toISOString().slice(0, 10);

  return `You are a senior proposal/bid analyst. You have been given MULTIPLE documents belonging to the SAME RFP opportunity (e.g. the main RFP, a pre-bid conference form, an addendum, separately-issued exhibits). Each document below is wrapped in ===== DOCUMENT START: "<filename>" ===== / ===== DOCUMENT END ===== markers showing its exact filename.

Produce ONE COMBINED analysis across ALL documents together — do NOT produce separate results per document. Merge deliverables, checklists, and insurance figures into single unified lists. For EVERY finding, you MUST include a "source_document" field with the EXACT filename (copied from the DOCUMENT START marker) it came from, so every fact can be traced back to its file. If the same requirement appears in more than one document, tag it with whichever document states it most explicitly, and you may add a note in "tier_note"/"reason" if documents conflict.

Read EVERY document below in full, including all Exhibits and Attachments in each one. Do not skip any document just because another one looks more important — required forms, deadlines, and disqualifiers can appear in any of them.

TODAY'S DATE: ${todayIso}

===========================================================================
CRITICAL ANTI-HALLUCINATION RULE — READ THIS BEFORE ANYTHING ELSE:
The JSON template shown further below is a STRUCTURAL example only. Every
specific number, section letter, statute citation, dollar figure, or quoted
phrase inside that example is FAKE and must NEVER be reused, adapted,
paraphrased, or echoed in your real answer, even if it happens to sound
plausible for this RFP. Before writing any "reason" field:
  1. Search the actual document text below for a sentence that supports the claim.
  2. Copy the section number and figures from THAT sentence, character for
     character — do not round, approximate, or reconstruct from memory.
  3. If you cannot find a specific supporting sentence, write exactly:
     "Not explicitly stated in RFP — verify manually."
Reusing an example's wording or numbers when the source text says something
different (or says nothing) is a serious error. When in doubt, quote less
and say "verify manually" more.
===========================================================================

STRICT RULES:
1. Read EVERY section of every document including all Exhibits before answering.
2. answer must be "YES", "NO", or "N/A" — based ONLY on what is actually written in the documents.
3. reason must quote the EXACT page number AND section number, in the format "Page N, Section X.Y: <specific text/numbers from the document>". See the PAGE CITATION RULE below. Never say "Not mentioned" if it appears in an exhibit. If it genuinely doesn't appear anywhere, say "Not explicitly stated in RFP — verify manually," never invent a plausible-sounding citation.
4. Every item in deliverables_checklist, financial_checklist, legal_checklist, operations_checklist, and technical_checklist MUST include "source_document" set to the exact filename (from the DOCUMENT START marker) that the reason/citation actually came from.
5. PAYMENT TERMS RULE: Search for NET30, "30 days," or similar payment-timing language. Report exactly what the text says, including which party it applies to. Do not assume it applies to the buyer's payments unless stated explicitly for that direction. On the "Payment Terms" item specifically, also include an integer field "payment_terms_days" = the number of days the buyer takes to pay the Contractor (e.g. 30 for NET30, 45 for NET45), or null if that direction of payment timing is not stated anywhere. Do NOT decide GO/escalate yourself — that comparison happens in code afterward using this number.
6. INSURANCE EXTRACTION RULE: Find every insurance coverage type and dollar figure stated anywhere across the documents. For EACH one, add an entry to "insurance_figures": { "coverage_type": "...", "amount": <number, no $ or commas, or null if statutory/no-fixed-amount>, "is_statutory": <true if "statutory limits" with no dollar figure, else false>, "basis": "per occurrence / aggregate / combined single limit / range — exactly as stated, or 'not specified'", "applies_to_this_contract": <true/false>, "tier_note": "<short explanation>", "source_document": "<exact filename>" }.
   TIERED COVERAGE HANDLING: If multiple risk TIERS are defined where only ONE applies to this contract, mark "applies_to_this_contract": true on the ONE tier that matches this engagement's actual data sensitivity, false on the others, with a tier_note explaining why. If you cannot confidently determine which tier applies, mark all tiers false and note "Tier applicability could not be determined from RFP text — requires manual review with the contracting officer." Do not invent splits the text doesn't give you. Do not calculate GO/NO-GO yourself — the threshold comparison is done in code afterward.
7. E-VERIFY RULE: Search every document carefully for E-Verify requirements. Quote the exact statute/code section number as written — do not recall from memory of similar clauses elsewhere.
8. WORKERS COMP RULE: Search every document's insurance section carefully.
9. DELIVERABLES RULE: Extract every concrete deliverable, document, form, attachment, or submission item ANY of the documents requires the bidder to submit. Include due dates where stated. For EVERY child item's "reason" field, start with "Page N, Section X.Y:" followed by a short paraphrase of what that section actually requires. Never omit the page number — a reader must be able to flip straight to that physical page and find the requirement.
   YOU MUST SPLIT DELIVERABLES INTO AT LEAST 3-5 SEPARATE CATEGORIES. Do NOT place every deliverable under one giant category. Group by document TYPE, not by due date. Use categories like (adapt to what the documents actually contain):
     - "Cover Sheet & Signature Documents"
     - "Required Attachments & Forms"
     - "SWAM / Diversity Compliance Documents"
     - "Written Narrative & Technical Response Sections"
     - "Pricing & Cost Submission"
     - "Post-Award Deliverables" (if applicable)
   If a category would end up with more than 6-7 items, split it further. A single category holding most or all of the deliverables is treated as an error.
10. fit_score 0-100. Give your best estimate; write a "recommendation" of GO/CAUTION/NO-GO as your own first read — but the final label shown to the user is recalculated in code from fit_score using fixed thresholds (GO >=70, NO-GO <40, CAUTION otherwise), so your label is advisory, not authoritative.
10b. CONFIDENCE SCORING RULE: Every object in deliverables_checklist items, financial_checklist, legal_checklist, operations_checklist, and technical_checklist MUST include an integer "confidence" field (0-100) rating how directly the source text supports that specific "reason" (not how important the item is). Use: 90-100 = exact sentence with a real page+section citation directly answers it; 60-89 = clearly relevant text but required minor inference; 30-59 = ambiguous or only tangentially related; 0-29 = no supporting text found / relying on general knowledge / "Not explicitly stated." Score honestly — low scores automatically trigger human review in code afterward, so there's no benefit to inflating them.
11. DEADLINE RULE (multi-document): Identify the REAL final RFP submission deadline — not a pre-bid conference RSVP date, not a Q&A cutoff, not a form-response date. If one document looks like an early-stage form (e.g. a pre-bid response form) rather than the main RFP itself, say so plainly in "recommendation_summary" so the reader understands why an individual document's date may look expired even if the real opportunity is still open. Convert the real deadline to ISO format YYYY-MM-DD in "deadline_date_iso", or null if no clear date is stated anywhere. Compare it to TODAY'S DATE yourself as a sanity check (this will also be verified independently in code).
12. CITATION ACCURACY RULE: Copy statute numbers, section letters/numbers, and dollar figures character-for-character. Never approximate, round, or reconstruct from memory.
13. PAGE CITATION RULE: Documents likely contain literal page-footer markers such as "Page 5 of 21" — real text extracted from the file. For every "reason" field:
    a. Find the specific sentence that supports your claim, and note WHICH document it's in.
    b. Scan FORWARD from that sentence to the next "Page N of M" footer marker in THAT SAME document.
    c. Prefix the reason with "Page N, " followed by the section reference and a colon.
    d. If content appears before the first page marker (e.g. cover page), use "Page 1".
    e. If no nearby page marker exists, use "Page unknown, Section X.Y:" — never fabricate a page number, and never drop the section reference just because the page is uncertain.
14. If the same requirement or fact is stated differently across two documents (a conflict), keep both, note the conflict explicitly in the "reason" text, and set "source_document" to the more authoritative/detailed document (or list both filenames separated by " / " if genuinely both matter).
15. Output ONLY valid JSON. No markdown. No trailing commas. No commentary.
16. RISK FLAGGING RULE: Separately from the general legal_checklist, identify any clauses that represent a genuine RISK to SPS — specifically: unfair/one-sided payment terms, uncapped or excessive liability exposure, unfavorable IP/ownership assignment clauses, or one-sided termination rights. For each one found, add an entry to "risk_flags": { "risk_type": "Unfair Payment Terms" | "Liability" | "IP Rights" | "Termination" | "Other", "severity": "LOW"|"MEDIUM"|"HIGH", "description": "<plain-language explanation of the risk>", "reason": "<Page N, Section X.Y: exact text>", "source_document": "<exact filename>" }. Do NOT duplicate every legal_checklist item here — only genuine red flags. If none exist, return an empty array.
===========================================================================
SPS RFP EVALUATION CRITERIA (internal checklist — evaluate the RFP against
EVERY section below; this is the authoritative basis for your GO/CAUTION/
NO-GO judgment, on top of the STRICT RULES above):
===========================================================================
${SPS_RFP_CHECKLIST_FULL_TEXT}
===========================================================================

COMPANY STRENGTHS: ${strengths || '(not provided)'}
COMPANY GAPS: ${gaps || '(not provided)'}

RETURN THIS EXACT JSON STRUCTURE — every value below is a FAKE placeholder to show you the shape only. Replace ALL of them with real data found in the documents below, following the anti-hallucination rule above. Every item array below must be populated as fully as the documents support — do not stop at one or two items per section if more standard items apply; check EVERY item listed and only omit ones that are genuinely not covered by any document (in which case still include the item with answer "N/A" and reason "Not explicitly stated in RFP — verify manually."):
{
  "fit_score": 0,
  "recommendation": "CAUTION",
  "recommendation_summary": "<2-3 sentences using only facts you actually found in the documents below>",
  "deadline_date_iso": "<YYYY-MM-DD found in the documents, or null if not found>",

  "deliverables_checklist": [
    {
      "category": "<a logical group name you choose>",
      "due_date": "<deadline for this group as stated, or N/A>",
      "items": [
        { "item": "<name of the specific document/form/attachment>", "mandatory": "YES", "decision": "ACTION REQUIRED", "reason": "<verify — Page N, Section X.Y: ...>", "confidence": 0, "source_document": "<exact filename>" }
      ]
    }
  ],

  "insurance_figures": [
    { "coverage_type": "<e.g. Workers Compensation, Commercial General Liability, Cyber Liability Tier 1>", "amount": null, "is_statutory": false, "basis": "<per occurrence / aggregate / combined single limit / range, or 'not specified'>", "applies_to_this_contract": true, "tier_note": "<explanation, or 'Not tiered — applies as stated'>", "source_document": "<exact filename>" }
  ],

  "financial_checklist": [
    { "item": "Payment Terms", "question": "What do the payment terms actually say, and to which party do they apply?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "payment_terms_days": 30, "source_document": "<exact filename>" },
    { "item": "Financial Stability Requirements", "question": "Is proof of financial stability required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Unaudited Financial Statements", "question": "Are unaudited financial statements acceptable?", "answer": "N/A", "decision": "NEEDS REVIEW", "reason": "<verify or 'Not explicitly stated in RFP — verify manually'>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Profitability Analysis", "question": "Can expected revenue cover projected costs based on the pricing structure?", "answer": "YES", "decision": "GO", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Bid Bond", "question": "Is a bid bond / proposal bond required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Electronic Funds Transfer (EFT) Registration", "question": "Is EFT registration mandatory?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Invoicing / Billing Terms", "question": "What are the stated invoicing requirements and timelines?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" }
  ],

  "legal_checklist": [
    { "item": "Relevant Experience", "question": "Is relevant experience required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Registration Requirement", "question": "Is company registration required (state/eVA/SEC/etc.)?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Financial Statement of Previous Year", "question": "Is a previous year financial statement required?", "answer": "NO", "decision": "GO", "reason": "<verify or 'Not explicitly stated in RFP — verify manually'>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Qualified Personnel", "question": "Are qualified personnel requirements specified?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Technical Knowhow", "question": "Is specific technical expertise required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Expected Revenue Generation", "question": "Is contract value or expected revenue estimable from the pricing schedule?", "answer": "YES", "decision": "GO", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Period of Implementation", "question": "Is the implementation period or contract duration defined?", "answer": "YES", "decision": "GO", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Insurance Coverage", "question": "Are required insurance coverages stated?", "answer": "YES", "decision": "GO", "reason": "<verify — list coverage TYPES only here; dollar figures go in insurance_figures>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Compliance of Law", "question": "Is compliance with applicable laws and regulations required?", "answer": "YES", "decision": "GO", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Compliance Requirements (Data Protection)", "question": "Are FERPA, HIPAA, GLBA, PCI-DSS or other data protection requirements mentioned?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "State Registration", "question": "Is state-level registration required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "E-Verify", "question": "Is use of the E-Verify system required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify — the EXACT statute/code section as written, do not recall from memory>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Contractual Obligations", "question": "Are termination clauses, liability limits, and dispute resolution defined?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Bid/Proposal Irrevocability Period", "question": "How long must the bid remain valid and irrevocable?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Document Retention Period", "question": "How long must the contractor retain contract-related records?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" }
  ],

  "operations_checklist": [
    { "item": "Insurance Requirement Form", "question": "Is a certificate of insurance or insurance form required?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Information Form (Tax ID, Owner Name, Ownership %)", "question": "Is a company information form with Tax ID required?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Small Business (SWAM)", "question": "Is Small Business (SWAM) certification required or evaluated?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "MBE Certification", "question": "Is MBE / minority business certification required or evaluated?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Workers Comp Insurance", "question": "Is Workers Compensation Insurance required?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Business with Iran / Restricted Entities Declaration", "question": "Is a declaration regarding business with restricted countries/entities required?", "answer": "NO", "decision": "GO", "reason": "<verify or 'Not explicitly stated in RFP — verify manually'>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Submission Deadlines", "question": "Are submission deadlines clearly stated?", "answer": "YES", "decision": "GO", "reason": "<verify — exact date and time as written>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Document Compliance", "question": "Are formatting and submission requirements defined?", "answer": "YES", "decision": "GO", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Signatory Authority", "question": "Is an authorized signatory required?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Vendor Registration", "question": "Is vendor registration (e.g. eVA or equivalent) required?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" }
  ],

  "technical_checklist": [
    { "item": "Scope of Services Alignment", "question": "Does the scope align with typical vendor services and capabilities?", "answer": "YES", "decision": "GO", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Technical Requirements", "question": "Do the technical specs match standard vendor capabilities?", "answer": "YES", "decision": "GO", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Manufacturer / Reseller Authorization", "question": "Is the bidder required to be an authorized reseller or hold a manufacturer authorization letter?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Compliance with Industry Standards", "question": "Are WCAG, Section 508, NIST or other industry standards required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Security Considerations", "question": "Are security requirements (encryption, access controls, data protection) stated?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" },
    { "item": "Integration Needs", "question": "Does the project require system integrations (APIs, SSO, etc.)?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "confidence": 0, "source_document": "<exact filename>" }
  ],

  ""disqualifiers": [
    "<list only TRUE hard disqualifiers found explicitly in the documents below, with a Page/Section citation, or leave this array empty>"
  ],

  "risk_flags": [
    {
      "risk_type": "Unfair Payment Terms",
      "severity": "MEDIUM",
      "description": "<plain-language explanation of why this is risky>",
      "reason": "<verify — Page N, Section X.Y: exact text found in the documents below>",
      "source_document": "<exact filename>"
    }
  ]
}
IMPORTANT: The JSON above shows the SHAPE and the STANDARD ITEM SET only. Every "reason", quote, number, and citation must be replaced with something you actually verified in the documents below. Populate every checklist item listed above by actually checking the documents for it — use "N/A" / "Not explicitly stated in RFP — verify manually" ONLY when a standard item is genuinely absent from every document, never skip an item entirely. You may ADD additional items beyond this list if the documents contain other important requirements not covered above.

For deliverables_checklist: Use a TWO-LEVEL parent-child structure exactly as shown — "category" groups, each containing an "items" array. Extract EVERY document, form, attachment (numbered/lettered attachments, W-9, SWAM plans, pricing pages, signed cover sheet, narrative sections, post-award deliverables, etc.) that ANY of the documents requires the bidder to submit, tagged with which document it came from.

DOCUMENTS (read every word, including all exhibits, in every document):
"""
${combinedText}
"""`;
}

// ===========================================================================
// PHASE 1, item #4 — Schema-enforced JSON output.
//
// Why this exists: `responseMimeType: 'application/json'` alone only tells
// Gemini to emit *some* JSON — it says nothing about which keys must exist,
// what type each value must be, or what an enum's allowed values are. A
// model can still (and, across enough requests, eventually will) emit a
// checklist item missing "confidence", a "recommendation" that isn't one of
// GO/CAUTION/NO-GO, or an "amount" that's a string instead of a number.
// Every one of those would previously either crash the deterministic-checks
// pass in applyDeterministicChecks() or corrupt the SQLite row silently.
//
// The fix is two layers:
//   1. `RFP_RESULT_SCHEMA` below is passed as `generationConfig.responseSchema`
//      so Gemini's own structured-output constraint decoding forces the
//      *shape* of the JSON at generation time (required fields, correct
//      types, enum values) — malformed output is rejected before it ever
//      leaves Google's servers.
//   2. `normalizeAnalysisResult()` is a second, independent safety net that
//      runs on our side after parsing. Even a model that doesn't honor
//      responseSchema (e.g. someone swaps GEMINI_MODEL to a model that
//      ignores it), or a schema that's technically satisfied but still
//      semantically odd, gets coerced into a shape the rest of the app can
//      always safely iterate over. This function never throws — it repairs
//      what it can and only ever produces the safe default shape, so a
//      malformed response degrades to an empty/low-confidence result
//      instead of crashing the worker.
// ===========================================================================

const CHECKLIST_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    item: { type: 'STRING' },
    question: { type: 'STRING' },
    answer: { type: 'STRING', enum: ['YES', 'NO', 'N/A'] },
    decision: { type: 'STRING' },
    reason: { type: 'STRING' },
    confidence: { type: 'INTEGER' },
    // Only populated on the "Payment Terms" item — see PAYMENT TERMS RULE
    // in the prompt and runPaymentTermsCheck() below.
    payment_terms_days: { type: 'INTEGER', nullable: true },
    source_document: { type: 'STRING' }
  },
  required: ['item', 'answer', 'decision', 'reason', 'confidence']
};

// Own dedicated section for high-risk legal/financial red flags — pulled
// out of the general legal_checklist so a reader sees dangerous clauses
// immediately, instead of hunting through 14 regular legal items.
const RISK_FLAG_SCHEMA = {
  type: 'OBJECT',
  properties: {
    risk_type: { type: 'STRING', enum: ['Unfair Payment Terms', 'Liability', 'IP Rights', 'Termination', 'Other'] },
    severity: { type: 'STRING', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    description: { type: 'STRING' },
    reason: { type: 'STRING' },
    source_document: { type: 'STRING' }
  },
  required: ['risk_type', 'severity', 'description', 'reason']
};

const DELIVERABLE_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    item: { type: 'STRING' },
    mandatory: { type: 'STRING', enum: ['YES', 'NO'] },
    decision: { type: 'STRING' },
    reason: { type: 'STRING' },
    confidence: { type: 'INTEGER' },
    source_document: { type: 'STRING' }
  },
  required: ['item', 'mandatory', 'decision', 'reason', 'confidence']
};

const DELIVERABLE_CATEGORY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: { type: 'STRING' },
    due_date: { type: 'STRING' },
    items: { type: 'ARRAY', items: DELIVERABLE_ITEM_SCHEMA }
  },
  required: ['category', 'items']
};

const INSURANCE_FIGURE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    coverage_type: { type: 'STRING' },
    amount: { type: 'NUMBER', nullable: true },
    is_statutory: { type: 'BOOLEAN' },
    basis: { type: 'STRING' },
    applies_to_this_contract: { type: 'BOOLEAN' },
    tier_note: { type: 'STRING' },
    source_document: { type: 'STRING' }
  },
  required: ['coverage_type', 'is_statutory', 'applies_to_this_contract']
};

const RFP_RESULT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    fit_score: { type: 'INTEGER' },
    recommendation: { type: 'STRING', enum: ['GO', 'CAUTION', 'NO-GO'] },
    recommendation_summary: { type: 'STRING' },
    deadline_date_iso: { type: 'STRING', nullable: true },
    deliverables_checklist: { type: 'ARRAY', items: DELIVERABLE_CATEGORY_SCHEMA },
    insurance_figures: { type: 'ARRAY', items: INSURANCE_FIGURE_SCHEMA },
    financial_checklist: { type: 'ARRAY', items: CHECKLIST_ITEM_SCHEMA },
    legal_checklist: { type: 'ARRAY', items: CHECKLIST_ITEM_SCHEMA },
    operations_checklist: { type: 'ARRAY', items: CHECKLIST_ITEM_SCHEMA },
    technical_checklist: { type: 'ARRAY', items: CHECKLIST_ITEM_SCHEMA },
    disqualifiers: { type: 'ARRAY', items: { type: 'STRING' } },
    risk_flags: { type: 'ARRAY', items: RISK_FLAG_SCHEMA }
  },
  required: [
    'fit_score', 'recommendation', 'recommendation_summary', 'deadline_date_iso',
    'deliverables_checklist', 'insurance_figures', 'financial_checklist',
    'legal_checklist', 'operations_checklist', 'technical_checklist', 'disqualifiers',
    'risk_flags'
  ]
};

// --- Layer 2 safety net: coerce whatever we got into a safe, iterable shape.
// Never throws. Missing/wrong-typed fields are replaced with safe defaults
// rather than left as-is, so nothing downstream has to guess.
function asArray(v) {
  return Array.isArray(v) ? v : [];
}
function asString(v, fallback = '') {
  return typeof v === 'string' ? v : (v == null ? fallback : String(v));
}
function asBool(v, fallback = false) {
  return typeof v === 'boolean' ? v : fallback;
}

function normalizeChecklistItem(item) {
  if (!item || typeof item !== 'object') {
    item = {};
  }
  const ptDays = Number(item.payment_terms_days);
  return {
    ...item,
    item: asString(item.item, 'Unnamed item'),
    question: asString(item.question, ''),
    answer: ['YES', 'NO', 'N/A'].includes(item.answer) ? item.answer : 'N/A',
    decision: asString(item.decision, 'NEEDS REVIEW'),
    reason: asString(item.reason, 'Not explicitly stated in RFP — verify manually.'),
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0,
    ...(item.payment_terms_days !== undefined ? { payment_terms_days: Number.isFinite(ptDays) ? ptDays : null } : {}),
    ...(item.source_document !== undefined ? { source_document: asString(item.source_document) } : {})
  };
}

function normalizeDeliverableItem(item) {
  if (!item || typeof item !== 'object') {
    item = {};
  }
  return {
    ...item,
    item: asString(item.item, 'Unnamed deliverable'),
    mandatory: ['YES', 'NO'].includes(item.mandatory) ? item.mandatory : 'YES',
    decision: asString(item.decision, 'ACTION REQUIRED'),
    reason: asString(item.reason, 'Not explicitly stated in RFP — verify manually.'),
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0,
    ...(item.source_document !== undefined ? { source_document: asString(item.source_document) } : {})
  };
}

function normalizeInsuranceFigure(fig) {
  if (!fig || typeof fig !== 'object') {
    fig = {};
  }
  const amountNum = Number(fig.amount);
  return {
    ...fig,
    coverage_type: asString(fig.coverage_type, 'Unspecified coverage'),
    amount: fig.amount === null || fig.amount === undefined || isNaN(amountNum) ? null : amountNum,
    is_statutory: asBool(fig.is_statutory, false),
    basis: asString(fig.basis, 'not specified'),
    applies_to_this_contract: asBool(fig.applies_to_this_contract, true),
    tier_note: asString(fig.tier_note, 'Not tiered — applies as stated')
  };
}

function normalizeAnalysisResult(raw) {
  const out = (raw && typeof raw === 'object') ? { ...raw } : {};

  const scoreNum = Number(out.fit_score);
  out.fit_score = Number.isFinite(scoreNum) ? scoreNum : 0;
  out.recommendation = ['GO', 'CAUTION', 'NO-GO'].includes(out.recommendation) ? out.recommendation : 'CAUTION';
  out.recommendation_summary = asString(out.recommendation_summary, '');
  out.deadline_date_iso = (typeof out.deadline_date_iso === 'string' && out.deadline_date_iso) ? out.deadline_date_iso : null;

  out.deliverables_checklist = asArray(out.deliverables_checklist).map(cat => ({
    ...(cat && typeof cat === 'object' ? cat : {}),
    category: asString(cat && cat.category, 'Uncategorized'),
    due_date: asString(cat && cat.due_date, 'N/A'),
    items: asArray(cat && cat.items).map(normalizeDeliverableItem)
  }));

  out.insurance_figures = asArray(out.insurance_figures).map(normalizeInsuranceFigure);
  out.financial_checklist = asArray(out.financial_checklist).map(normalizeChecklistItem);
  out.legal_checklist = asArray(out.legal_checklist).map(normalizeChecklistItem);
  out.operations_checklist = asArray(out.operations_checklist).map(normalizeChecklistItem);
  out.technical_checklist = asArray(out.technical_checklist).map(normalizeChecklistItem);
  out.disqualifiers = asArray(out.disqualifiers).map(d => asString(d)).filter(Boolean);

  out.risk_flags = asArray(out.risk_flags).map(r => ({
    risk_type: ['Unfair Payment Terms', 'Liability', 'IP Rights', 'Termination', 'Other'].includes(r && r.risk_type) ? r.risk_type : 'Other',
    severity: ['LOW', 'MEDIUM', 'HIGH'].includes(r && r.severity) ? r.severity : 'MEDIUM',
    description: asString(r && r.description, ''),
    reason: asString(r && r.reason, 'Not explicitly stated in RFP — verify manually.'),
    ...(r && r.source_document !== undefined ? { source_document: asString(r.source_document) } : {})
  }));

  return out;

}

// Low-level, retry-hardened call to the Gemini API. Everything model- or
// schema-specific is a parameter now (model, schema) so this ONE retry path
// serves: the main analysis call, the item #7 cross-check call (different
// model, different schema), and every item #8 pipeline-agent call (same or
// different model, sometimes no schema at all for free-text proposal
// writing). Returns the raw text Gemini returned; callers decide whether/how
// to parse it.
async function callGeminiAPI(prompt, { model, schema, extraParts } = {}) {
  // gemini-2.5-flash was deprecated ahead of schedule; Google's current
  // recommended replacement is gemini-3.5-flash (GA since May 19, 2026).
  // Configurable via .env in case Google deprecates this one too later —
  // no code change needed, just update GEMINI_MODEL.
  const useModel = model || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const generationConfig = { temperature: 0.2 };
  if (schema) {
    // Phase 1, item #4: forces Gemini's structured-output decoding to only
    // ever emit JSON matching this exact shape (required keys, correct
    // types, enum values).
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }

  // Retry on transient "model overloaded" (503) or rate-limit (429) errors.
  // These are momentary capacity spikes on Google's side, not real failures —
  // retrying with a short backoff usually succeeds within a few seconds
  // instead of surfacing an error to the user for something that self-resolves.
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1500; // 1.5s, 3s, 6s

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Phase 4, item #14: extraParts lets a caller (currently just the
          // OCR fallback) attach non-text content — e.g. an inlineData PDF
          // part — alongside the text prompt in the same turn.
          contents: [{ parts: [{ text: prompt }, ...(extraParts || [])] }],
          generationConfig
        })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        let msg = `Gemini API error (HTTP ${resp.status})`;
        try {
          const j = JSON.parse(errText);
          msg = j.error?.message || msg;
        } catch (e) { /* ignore parse failure, use default msg */ }

        const isTransient = resp.status === 503 || resp.status === 429;
        if (isTransient && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[WARN] Gemini (${useModel}) transient error (HTTP ${resp.status}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(msg);
      }

      const json = await resp.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error(`Empty response from Gemini (${useModel}). Try again.`);
      }
      return text;
    } catch (err) {
      lastErr = err;
      // Non-transient errors (empty response, network failure) still get one
      // retry each since these can also be momentary, but don't loop forever
      // on a genuinely broken request.
      if (attempt < MAX_RETRIES && /overloaded|UNAVAILABLE|fetch failed/i.test(err.message || '')) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[WARN] Gemini (${useModel}) call failed (${err.message}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function stripJsonFences(text) {
  return text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
}

// Main analysis call: main model, main schema, then Layer-2-normalized.
async function callGemini(prompt) {
  const text = await callGeminiAPI(prompt, { schema: RFP_RESULT_SCHEMA });
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch (e) {
    throw new Error('Gemini returned malformed JSON. Try analyzing again.');
  }
  // Layer 2 safety net (see comment above RFP_RESULT_SCHEMA): even though
  // responseSchema constrains generation, coerce the parsed object into a
  // guaranteed-safe shape before it ever reaches applyDeterministicChecks
  // or the database, so a schema edge case can degrade gracefully instead
  // of throwing a TypeError deep in downstream code.
  return normalizeAnalysisResult(parsed);
}

// Generic "give me JSON back" helper for any model/schema — used by the
// item #7 cross-check call and the item #8 compliance/reviewer agents.
// Deliberately does NOT run normalizeAnalysisResult (that shape is specific
// to the main RFP_RESULT_SCHEMA) — callers here use small, purpose-built
// schemas and read exactly the fields they asked for.
async function callGeminiJSON(prompt, model, schema) {
  const text = await callGeminiAPI(prompt, { model, schema });
  try {
    return JSON.parse(stripJsonFences(text));
  } catch (e) {
    throw new Error(`Model (${model}) returned malformed JSON.`);
  }
}

// Generic "give me free text back" helper — used by the item #8 proposal
// writer agent, which produces prose, not structured data.
async function callGeminiText(prompt, model) {
  const text = await callGeminiAPI(prompt, { model });
  return text.trim();
}

// Phase 4, item #13: embedding call for the RAG library. This hits a
// DIFFERENT Gemini endpoint (embedContent, not generateContent) since
// embedding models return a vector, not generated text/JSON — so it can't
// reuse callGeminiAPI above. Shares the same retry-on-transient-error logic
// since embedding calls can hit the same momentary 503/429s.
async function callGeminiEmbedding(text, model) {
  const useModel = model || GEMINI_EMBEDDING_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:embedContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1500;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${useModel}`,
          content: { parts: [{ text }] }
        })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        let msg = `Gemini embedding error (HTTP ${resp.status})`;
        try {
          msg = JSON.parse(errText).error?.message || msg;
        } catch (e) { /* ignore */ }
        const isTransient = resp.status === 503 || resp.status === 429;
        if (isTransient && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(msg);
      }

      const json = await resp.json();
      const values = json.embedding?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(`Empty embedding response from Gemini (${useModel}).`);
      }
      return values;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && /overloaded|UNAVAILABLE|fetch failed/i.test(err.message || '')) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Splits a document into overlapping, retrieval-sized chunks. Sliding-window
// on RAW CHARACTERS (not paragraphs, unlike chunkRfpText used for addendum
// diffing) — proposal documents don't need exact-match diffing, they need
// chunks small enough for precise semantic search but with enough overlap
// that a requirement's answer doesn't get split across two chunks and lose
// meaning in both halves.
function chunkForEmbedding(text, maxChars = RAG_CHUNK_MAX_CHARS, overlapChars = RAG_CHUNK_OVERLAP_CHARS) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) {
    return [];
  }
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + maxChars, clean.length);
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) {
      break;
    }
    const nextStart = end - overlapChars; // step forward, but overlap with the previous chunk
    start = nextStart > start ? nextStart : end; // guard: always make forward progress even if overlapChars >= maxChars
  }
  return chunks.filter(c => c.length > 0);
}

// Standard cosine similarity between two equal-length embedding vectors —
// this IS the "search" in semantic search: closer to 1 means more similar
// in meaning, independent of chunk length.
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Orchestrator for a single proposal-ingest job: chunk the extracted text,
// embed every chunk (sequentially — embedding one call at a time is simpler
// and more robust than batching, and ingest is a one-off background action,
// not something on a user-facing request path), then save chunks +
// embeddings and flip the document to 'ready'. Mirrors the shape of
// processProposalPipeline / processAddendumDiffJob: same background-job
// pattern as everything else in this app.
async function processProposalIngestJob(payload) {
  const { id, documentId, fileName, text } = payload;
  db.setStatus(id, 'active');
  db.setProposalDocumentStatus(documentId, 'active');
  try {
    let pieces = chunkForEmbedding(text);
    if (pieces.length > RAG_MAX_CHUNKS_PER_DOCUMENT) {
      pieces = pieces.slice(0, RAG_MAX_CHUNKS_PER_DOCUMENT);
    }
    if (pieces.length === 0) {
      throw new Error('No usable text to index in this document.');
    }

    const chunks = [];
    for (let i = 0; i < pieces.length; i++) {
      const embedding = await callGeminiEmbedding(pieces[i], GEMINI_EMBEDDING_MODEL);
      chunks.push({ index: i, text: pieces[i], embedding });
    }

    db.saveProposalChunks(documentId, chunks);

    const finalResult = {
      kind: 'proposal_ingest',
      documentId,
      fileName,
      chunkCount: chunks.length
    };
    db.saveResult(id, finalResult);
    return finalResult;
  } catch (err) {
    db.markFailed(id, err.message || 'Proposal ingest failed.');
    db.setProposalDocumentStatus(documentId, 'failed', err.message || 'Proposal ingest failed.');
    throw err;
  }
}

// ===========================================================================
// PHASE 3, item #8 — Multi-agent proposal pipeline.
//
// Purpose: once an RFP has been analyzed (GO/CAUTION/NO-GO decided), the
// next real task is writing the actual proposal response. Asking one model
// to "extract compliance requirements AND write persuasive prose AND check
// its own work" in a single call reliably produces a document that's decent
// at all three and excellent at none — and a model has no real way to catch
// its own compliance-checking blind spots by re-reading its own writing.
//
// So this splits the work into three agents that each do exactly one job
// and hand off to the next, each as its OWN separate Gemini call:
//   1. Compliance Agent   — reads the RFP + SPS checklist + the completed
//                           Go/No-Go analysis, and lists every mandatory
//                           form/certification/eligibility item the
//                           proposal MUST satisfy. No prose, no judgment.
//   2. Proposal Writer Agent — writes a persuasive draft proposal that
//                           addresses every item in the compliance brief.
//                           Doesn't audit compliance itself, doesn't review
//                           its own writing.
//   3. Reviewer Agent     — checks the draft against the compliance brief
//                           and the RFP, flags anything missing/wrong, and
//                           returns a corrected final version.
// ===========================================================================

const COMPLIANCE_BRIEF_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mandatory_forms: { type: 'ARRAY', items: { type: 'STRING' } },
    mandatory_certifications: { type: 'ARRAY', items: { type: 'STRING' } },
    eligibility_requirements: { type: 'ARRAY', items: { type: 'STRING' } },
    compliance_risks: { type: 'ARRAY', items: { type: 'STRING' } },
    compliance_summary: { type: 'STRING' }
  },
  required: ['mandatory_forms', 'mandatory_certifications', 'eligibility_requirements', 'compliance_risks', 'compliance_summary']
};

const REVIEWER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    approved: { type: 'BOOLEAN' },
    issues_found: { type: 'ARRAY', items: { type: 'STRING' } },
    edits_made: { type: 'ARRAY', items: { type: 'STRING' } },
    final_proposal_text: { type: 'STRING' }
  },
  required: ['approved', 'issues_found', 'edits_made', 'final_proposal_text']
};

// --- Agent 1: Compliance Agent -------------------------------------------
// One job: extract, don't write, don't decide. Reuses the same
// SPS_RFP_CHECKLIST_FULL_TEXT constant the main analysis prompt uses, so
// "mandatory" means the same thing here as it did in the Go/No-Go pass.
function buildComplianceAgentPrompt(sourceText, analysisData) {
  const disqualifiers = (analysisData && analysisData.disqualifiers) || [];
  return `You are the COMPLIANCE AGENT in a 3-agent RFP proposal pipeline. Your ONLY job is to read the RFP and list every mandatory compliance item the eventual proposal must satisfy. Do NOT write proposal prose. Do NOT judge whether to bid — that decision has already been made.

SPS's internal RFP checklist (reference, so you recognize what "mandatory" means here):
"""${SPS_RFP_CHECKLIST_FULL_TEXT.slice(0, 6000)}"""

Hard disqualifiers already identified for this RFP: ${JSON.stringify(disqualifiers)}

RFP TEXT:
"""${sourceText.slice(0, 100000)}"""

Return ONLY JSON with:
- mandatory_forms: required forms/certifications by name
- mandatory_certifications: licenses/registrations/insurance certificates required
- eligibility_requirements: who is allowed to bid
- compliance_risks: anything that could get the bid rejected on a technicality
- compliance_summary: a 2-3 sentence plain-language summary`;
}

// --- Agent 2: Proposal Writer Agent ---------------------------------------
// One job: write persuasive, RFP-specific prose that addresses everything
// the Compliance Agent flagged. Does not re-derive compliance facts and
// does not review/fact-check its own output.
// Phase 4, item #16: retrieval hook for the proposal generation engine.
// Re-uses the exact same embed + cosine-similarity ranking as the item #13
// library /search endpoint — just called in-process instead of over HTTP.
// Non-fatal by design: an empty/unseeded library, or a transient embedding
// error, should never block proposal generation — it just means no past
// examples get pulled in.
async function retrievePastProposalLanguage(queryText, k = 4) {
  try {
    const chunks = db.getAllProposalChunks();
    if (!chunks.length) {
      return [];
    }
    const queryEmbedding = await callGeminiEmbedding(queryText.slice(0, 2000), GEMINI_EMBEDDING_MODEL);
    return chunks
      .map(c => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  } catch (err) {
    console.error('Past-proposal retrieval error (non-fatal):', err.message);
    return [];
  }
}

function buildProposalWriterPrompt(sourceText, complianceBrief, strengths, gaps, pastExamples) {
  const pastExamplesText = (pastExamples && pastExamples.length)
    ? `PAST WINNING PROPOSAL LANGUAGE (pulled from your own previously-won proposals via semantic search — reuse the style/substance where it genuinely fits this RFP, but never state facts from these excerpts as if they were true of THIS project):\n${pastExamples.map((c, i) => `[Excerpt ${i + 1}, from "${c.fileName}"]\n"""${c.text}"""`).join('\n\n')}\n`
    : '';

  return `You are the PROPOSAL WRITER AGENT in a 3-agent RFP proposal pipeline. Your ONLY job is to write a strong, persuasive draft proposal responding to this RFP. Compliance has already been audited by the Compliance Agent below — you must address every item it lists, but you do not need to re-verify it yourself. You do not review or fact-check your own writing; a separate Reviewer Agent will do that after you.

COMPLIANCE BRIEF (must be addressed somewhere in the proposal):
${JSON.stringify(complianceBrief, null, 2)}

COMPANY STRENGTHS to emphasize:
${strengths}

COMPANY GAPS to address honestly and constructively (don't hide them):
${gaps}

${pastExamplesText}
RFP TEXT:
"""${sourceText.slice(0, 100000)}"""

Write a complete draft proposal in plain text with clear section headings: Executive Summary, Understanding of Requirements, Technical/Management Approach, Compliance & Required Forms Response, Why SPS. Be concrete and specific to this RFP — no generic boilerplate.`;
}

// --- Agent 3: Reviewer Agent -----------------------------------------------
// One job: check, don't write from scratch, don't re-derive compliance
// facts. Only verifies the draft actually satisfies the compliance brief
// and returns a corrected version.
function buildReviewerAgentPrompt(sourceText, complianceBrief, draftProposal) {
  return `You are the REVIEWER AGENT in a 3-agent RFP proposal pipeline. Your ONLY job is to check the draft proposal below against the compliance brief and the RFP, then return a corrected final version. You did not write the draft and you do not re-derive compliance facts from scratch — you only verify the draft satisfies them and fix anything missing or wrong.

COMPLIANCE BRIEF:
${JSON.stringify(complianceBrief, null, 2)}

DRAFT PROPOSAL:
"""${draftProposal.slice(0, 60000)}"""

RFP TEXT (for verification only):
"""${sourceText.slice(0, 60000)}"""

Return ONLY JSON with:
- approved: true if the draft already satisfied every compliance item and needed no changes
- issues_found: problems you found (empty array if none)
- edits_made: edits you applied (empty array if none)
- final_proposal_text: the complete corrected proposal text — if no edits were needed, return the draft unchanged`;
}

// Orchestrator — runs the three agents strictly in sequence, since each
// agent's input is the previous agent's output. This is a background job
// just like an analysis job (see processAnalysisJob dispatch below) because
// three sequential Gemini calls take even longer than the single-call
// analysis path.
async function processProposalPipeline(payload) {
  const { id, sourceText, analysisData, strengths, gaps } = payload;
  const agentModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  db.setStatus(id, 'active');
  try {
    const complianceBrief = await callGeminiJSON(
      buildComplianceAgentPrompt(sourceText, analysisData),
      agentModel,
      COMPLIANCE_BRIEF_SCHEMA
    );

    // Phase 4, item #16: pull relevant past-won language from the RAG
    // library (item #13) before drafting, keyed on the compliance summary +
    // start of the RFP text (a good proxy for "what is this project about").
    const pastExamples = await retrievePastProposalLanguage(
      `${complianceBrief.compliance_summary || ''}\n${sourceText.slice(0, 1500)}`
    );

    const draftProposal = await callGeminiText(
      buildProposalWriterPrompt(sourceText, complianceBrief, strengths, gaps, pastExamples),
      agentModel
    );

    const review = await callGeminiJSON(
      buildReviewerAgentPrompt(sourceText, complianceBrief, draftProposal),
      agentModel,
      REVIEWER_SCHEMA
    );

    const finalResult = {
      kind: 'proposal',
      analysisId: payload.analysisId,
      pipeline: ['compliance_agent', 'proposal_writer_agent', 'reviewer_agent'],
      compliance_brief: complianceBrief,
      draft_proposal: draftProposal,
      review,
      final_proposal_text: review.final_proposal_text || draftProposal,
      past_examples_used: pastExamples.map(c => ({ fileName: c.fileName, score: Math.round(c.score * 1000) / 1000 }))
    };
    db.saveResult(id, finalResult);
    return finalResult;
  } catch (err) {
    db.markFailed(id, err.message || 'Proposal pipeline failed.');
    throw err;
  }
}

// ===========================================================================
// PHASE 3, item #12 — Addendum diff tracking.
//
// Purpose: an RFP is sometimes amended after the original was analyzed (a
// new deadline, a changed insurance figure, a new requirement). Instead of
// asking a person to re-read the whole amended document and spot what's
// different by eye, this re-uses the ORIGINAL text already saved for that
// analysis (same source_text column item #8 added) and compares it against
// the freshly re-uploaded text.
//
// Same deterministic + AI split as everywhere else in this app:
//   - CODE decides exactly which paragraphs are new/removed (a plain text
//     comparison — no AI involved, so it can never "miss" or "imagine" a
//     change, and it costs nothing to run).
//   - AI's ONLY job is to read those specific added/removed paragraphs and
//     explain, in plain English, what they actually mean for the bid
//     (did the deadline move? did a price change? is this a brand-new
//     requirement?). It never re-scans the whole document from scratch.
// ===========================================================================

// Splits RFP text into paragraph-sized "chunks" and normalizes whitespace,
// so two texts that are substantively identical but were extracted from
// slightly different PDF line-wrapping still compare as equal. Chunks
// shorter than ADDENDUM_DIFF_MIN_CHUNK_CHARS (page numbers, footers, stray
// headers) are dropped — they're noise, not real content.
function chunkRfpText(text) {
  return String(text || '')
    .split(/\n\s*\n+/)                         // split on blank lines (paragraph breaks)
    .map(chunk => chunk.replace(/\s+/g, ' ').trim())
    .filter(chunk => chunk.length >= ADDENDUM_DIFF_MIN_CHUNK_CHARS);
}

// Deterministic set comparison: any chunk in the OLD text that does not
// appear (exact match, after normalization) anywhere in the NEW text is
// "removed"; any chunk in the NEW text not present in the OLD text is
// "added". Order-independent on purpose — RFPs get renumbered/reordered in
// addenda constantly, and that alone is not a meaningful change worth
// flagging.
function computeChunkDiff(oldText, newText) {
  const oldChunks = chunkRfpText(oldText);
  const newChunks = chunkRfpText(newText);
  const oldSet = new Set(oldChunks);
  const newSet = new Set(newChunks);

  const removedChunks = oldChunks.filter(c => !newSet.has(c));
  const addedChunks = newChunks.filter(c => !oldSet.has(c));

  return {
    addedChunks,
    removedChunks,
    totalOldChunks: oldChunks.length,
    totalNewChunks: newChunks.length
  };
}

const ADDENDUM_SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    deadline_changed: { type: 'BOOLEAN' },
    pricing_changed: { type: 'BOOLEAN' },
    insurance_changed: { type: 'BOOLEAN' },
    new_requirement_added: { type: 'BOOLEAN' },
    key_changes: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['summary', 'deadline_changed', 'pricing_changed', 'insurance_changed', 'new_requirement_added', 'key_changes']
};

function buildAddendumSummaryPrompt(addedChunks, removedChunks) {
  return `You are comparing an original RFP against an amended/addendum version of the SAME RFP. Below are the EXACT paragraphs that were REMOVED (present in the original, gone in the amended version) and the EXACT paragraphs that were ADDED (new in the amended version, not in the original). This is already a verified, code-computed diff — do not second-guess whether something changed, only explain what the changes MEAN.

Your job:
1. Write "summary": 2-4 plain-English sentences describing what actually changed and why it matters to someone deciding whether to bid.
2. Set these booleans based ONLY on what you see in the paragraphs below: deadline_changed, pricing_changed, insurance_changed, new_requirement_added.
3. "key_changes": a short bullet list (plain strings) of the specific, concrete changes — e.g. "Submission deadline moved from March 3 to March 17" or "Cyber Liability minimum raised from $2M to $5M". Only include changes you can actually support from the text below; do not invent old/new values that aren't shown.
4. If the removed/added paragraphs below look like formatting noise (reordering, renumbering, no real content change), say so plainly in the summary instead of forcing a dramatic-sounding change.

REMOVED PARAGRAPHS (in original, not in amended version):
"""
${removedChunks.length ? removedChunks.join('\n---\n') : '(none)'}
"""

ADDED PARAGRAPHS (new in the amended version):
"""
${addedChunks.length ? addedChunks.join('\n---\n') : '(none)'}
"""

Return ONLY the JSON object matching the schema — no preamble, no commentary.`;
}

// Orchestrator for a single addendum-diff job. Mirrors the shape of
// processProposalPipeline above: runs as a background job (queued through
// the same BullMQ worker as everything else) since the diff can involve a
// large document plus a Gemini call.
async function processAddendumDiffJob(payload) {
  const { id, originalAnalysisId, oldFileName, newFileName, oldText, newText } = payload;
  db.setStatus(id, 'active');
  try {
    const diff = computeChunkDiff(oldText, newText);
    const hasChanges = diff.addedChunks.length > 0 || diff.removedChunks.length > 0;

    // Deterministic-first: if the code-computed diff found literally nothing
    // different, don't spend a Gemini call summarizing "no changes" — just
    // say so. AI is only invoked when there's actually something to explain.
    let aiSummary = null;
    if (hasChanges) {
      const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
      aiSummary = await callGeminiJSON(
        buildAddendumSummaryPrompt(diff.addedChunks, diff.removedChunks),
        model,
        ADDENDUM_SUMMARY_SCHEMA
      );
    }

    const finalResult = {
      kind: 'addendum_diff',
      original_analysis_id: originalAnalysisId,
      old_file_name: oldFileName,
      new_file_name: newFileName,
      has_changes: hasChanges,
      added_count: diff.addedChunks.length,
      removed_count: diff.removedChunks.length,
      added_chunks: diff.addedChunks,
      removed_chunks: diff.removedChunks,
      ai_summary: aiSummary,
      generated_at: new Date().toISOString()
    };
    db.saveResult(id, finalResult);
    return finalResult;
  } catch (err) {
    db.markFailed(id, err.message || 'Addendum comparison failed.');
    throw err;
  }
}

// ===========================================================================
// PHASE 5, item #18 — Server-side PDF report generation (Puppeteer).
//
// This is a SEPARATE report from the existing /export.pdf (pdfkit,
// hand-drawn layout) — kept side-by-side rather than replacing it, since
// that one already works and other things may depend on it. This version
// renders the exact same HTML/CSS structure the results page uses, via a
// real headless browser, so it visually matches what's on screen more
// closely — at the cost of a much heavier dependency (ships headless
// Chromium). Auto-generated once, right when an analysis completes (see
// the hook in processAnalysisJob below), and cached to disk so repeat
// downloads don't re-launch a browser every time.
// ===========================================================================

function escapeHtmlServer(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Same citation-parsing logic as the frontend's parseCitation() — kept as
// its own copy here since this runs server-side with no access to the
// browser JS file.
function parseCitationServer(reason) {
  const text = reason || 'Not explicitly stated in RFP — verify manually.';
  let m = text.match(/^Page\s+([^,]+),\s*([^:]{1,50}):\s*(.*)$/i);
  if (m) {
    return { page: m[1].trim(), section: m[2].trim(), rest: m[3].trim() };
  }
  m = text.match(/^Page\s+([^:]{1,20}):\s*(.*)$/i);
  if (m) {
    return { page: m[1].trim(), section: null, rest: m[2].trim() };
  }
  m = text.match(/^([^:]{1,50}):\s*(.*)$/);
  if (m) {
    return { page: null, section: m[1].trim(), rest: m[2].trim() };
  }
  return { page: null, section: null, rest: text };
}

// Builds the full standalone HTML document Puppeteer will render. Deliberately
// self-contained (inline <style>, no external fonts/CDN calls) so rendering
// never depends on network access and stays fast/reliable.
function buildServerReportHtml(data, fileName) {
  const e = escapeHtmlServer;
  const rec = (data.recommendation || 'CAUTION').toUpperCase();
  const recColor = rec === 'GO' ? '#1f9d6b' : rec === 'NO-GO' ? '#d6453d' : '#b8860b';
  const score = typeof data.fit_score === 'number' ? data.fit_score : '—';
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  const deadlineBannerHtml = data.deadline_passed === true
    ? `<div class="banner nogo">⚠ Submission deadline (${e(data.deadline_date_iso || 'unknown date')}) has already passed as of the generation date below. Confirm whether an addendum extended it.</div>`
    : (data.deadline_passed === null || data.deadline_passed === undefined)
      ? '<div class="banner caution">? Could not confidently locate a submission deadline — verify manually.</div>'
      : (data.deadline_urgent === true)
        ? `<div class="banner caution">⏰ Only ${e(String(data.deadline_days_remaining))} day(s) left to submit (deadline ${e(data.deadline_date_iso || 'unknown date')}).</div>`
        : '';

  const confidenceBannerHtml = (data.confidence_summary && data.confidence_summary.total_items_scored)
    ? (() => {
      const cs = data.confidence_summary;
      const needsReview = cs.low_confidence_count > 0;
      const text = needsReview
        ? `${cs.low_confidence_count} of ${cs.total_items_scored} extracted items scored below the ${cs.review_threshold}% confidence threshold and are flagged NEEDS REVIEW.`
        : `All ${cs.total_items_scored} extracted items met the ${cs.review_threshold}% confidence threshold.`;
      return `<div class="banner ${needsReview ? 'caution' : 'go'}">${needsReview ? '🔎' : '✅'} ${text} Average confidence: ${cs.average_confidence ?? '—'}%.</div>`;
    })()
    : '';

  const disqHtml = (Array.isArray(data.disqualifiers) && data.disqualifiers.length)
    ? `<div class="disq"><strong>⚠️ Disqualifiers</strong><ul>${data.disqualifiers.map(d => `<li>${e(d)}</li>`).join('')}</ul></div>`
    : '';

  function badgeRow(item) {
    const { page, section } = parseCitationServer(item.reason);
    const parts = [];
    if (page) {
      parts.push(`<span class="badge page">📄 Page ${e(page)}</span>`);
    }
    if (section) {
      parts.push(`<span class="badge section">§ ${e(section)}</span>`);
    }
    if (item.source_document) {
      parts.push(`<span class="badge doc">📁 ${e(item.source_document)}</span>`);
    }
    if (typeof item.confidence === 'number') {
      const low = item.needs_human_review === true;
      parts.push(`<span class="badge ${low ? 'low' : 'conf'}">${low ? '🔎' : '✓'} ${item.confidence}% confidence</span>`);
    }
    return parts.length ? `<div class="badges">${parts.join(' ')}</div>` : '';
  }

  function deliverablesHtml(categories) {
    if (!Array.isArray(categories) || !categories.length) {
      return '';
    }
    const total = categories.reduce((s, c) => s + ((c.items || []).length), 0);
    let out = `<h2>📦 Deliverables Required by RFP <span class="muted">(${total} items across ${categories.length} sections)</span></h2>`;
    categories.forEach(cat => {
      out += `<div class="cat"><div class="cat-head"><strong>${e(cat.category || '')}</strong> <span class="pill">${(cat.items || []).length} item(s)</span>${cat.due_date && cat.due_date !== 'N/A' ? ` <span class="muted">📅 ${e(cat.due_date)}</span>` : ''}</div>`;
      (cat.items || []).forEach(item => {
        const { rest } = parseCitationServer(item.reason);
        out += `<div class="item">
          <div class="item-top"><span>${e(item.item || '')}</span><span class="pill">${e(item.mandatory || 'N/A')} · ${e(item.decision || '—')}</span></div>
          ${badgeRow(item)}
          <div class="muted">${e(rest)}</div>
        </div>`;
      });
      out += '</div>';
    });
    return out;
  }

  function insuranceHtml(figures) {
    if (!Array.isArray(figures) || !figures.length) {
      return '';
    }
    return `<h2>🛡️ Insurance Figures Extracted</h2>
      <table><thead><tr><th>Coverage Type</th><th>Amount</th><th>Basis</th><th>Applies?</th></tr></thead><tbody>
      ${figures.map(f => {
    const isStatutory = f.is_statutory === true;
    const applies = f.applies_to_this_contract !== false;
    const amt = Number(f.amount);
    const hasAmount = !isNaN(amt) && amt > 0;
    const amountDisplay = isStatutory ? 'Statutory' : (hasAmount ? `$${amt.toLocaleString()}` : '—');
    return `<tr style="opacity:${applies ? 1 : 0.5}">
          <td><strong>${e(f.coverage_type || '')}</strong></td>
          <td>${amountDisplay}</td>
          <td>${e(f.basis || 'not specified')}</td>
          <td>${applies ? 'APPLIES' : 'NOT APPLICABLE'}</td>
        </tr>`;
  }).join('')}
      </tbody></table>`;
  }

  function checklistHtml(title, icon, items) {
    if (!Array.isArray(items) || !items.length) {
      return '';
    }
    return `<h2>${icon} ${title}</h2>
      <table><thead><tr><th>Item</th><th>Question</th><th>Y/N</th><th>Decision</th><th>Reason</th></tr></thead><tbody>
      ${items.map(item => {
    const { rest } = parseCitationServer(item.reason);
    return `<tr>
          <td><strong>${e(item.item || '')}</strong></td>
          <td class="muted">${e(item.question || '')}</td>
          <td>${e(item.answer || 'N/A')}</td>
          <td>${e(item.decision || '—')}</td>
          <td>${badgeRow(item)}<div class="muted">${e(rest)}</div></td>
        </tr>`;
  }).join('')}
      </tbody></table>`;
  }

  function riskFlagsHtml(flags) {
    if (!Array.isArray(flags) || !flags.length) {
      return '';
    }
    return `<h2>🚩 Risk & Legal Flags</h2>
      ${flags.map(r => {
    const { rest } = parseCitationServer(r.reason);
    return `<div class="item">
          <div class="item-top"><span>${e(r.risk_type || 'Other')}</span><span class="pill">${e((r.severity || 'MEDIUM').toUpperCase())}</span></div>
          <div>${e(r.description || '')}</div>
          <div class="muted">${e(rest)}</div>
        </div>`;
  }).join('')}`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#1a1a2e;margin:0;padding:0 8px;line-height:1.5;font-size:12px;}
  h1{font-size:20px;margin-bottom:2px;}
  .meta{color:#777;font-size:11px;margin-bottom:20px;}
  h2{font-size:13px;font-weight:700;border-bottom:2px solid #eee;padding-bottom:5px;margin:24px 0 10px;}
  .verdict{display:flex;align-items:center;gap:16px;border:1px solid #ddd;border-radius:8px;padding:14px 16px;margin-bottom:16px;}
  .verdict .score{font-size:26px;font-weight:700;color:${recColor};min-width:50px;text-align:center;}
  .verdict .tag{display:inline-block;font-size:10px;font-weight:700;color:${recColor};background:${recColor}1A;padding:2px 8px;border-radius:5px;margin-bottom:4px;}
  .banner{border-radius:6px;padding:10px 14px;margin-bottom:12px;font-size:12px;font-weight:600;}
  .banner.nogo{background:#fdecea;color:#c0392b;border:1px solid #f3c1bd;}
  .banner.caution{background:#fff8e6;color:#8a6d1a;border:1px solid #f0d98c;}
  .banner.go{background:#e8f9f1;color:#1f9d6b;border:1px solid #bdeed7;}
  table{width:100%;border-collapse:collapse;margin-bottom:8px;font-size:11px;}
  th{background:#f5f5f7;padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e3e3e3;}
  td{padding:7px 8px;border-bottom:1px solid #eee;vertical-align:top;}
  .disq{background:#fdecea;border:1px solid #f3c1bd;border-radius:6px;padding:10px 14px;margin:10px 0;}
  .disq li{color:#c0392b;}
  .cat{border:1px solid #ddd;border-radius:6px;margin-bottom:10px;overflow:hidden;}
  .cat-head{background:#f0f4ff;padding:8px 12px;}
  .item{background:#fafbfe;border:1px solid #eee;border-radius:6px;padding:8px 10px;margin:6px;}
  .item-top{display:flex;justify-content:space-between;margin-bottom:4px;font-weight:600;}
  .pill{font-size:10px;background:#eee;padding:1px 7px;border-radius:9px;}
  .badge{font-size:9px;font-weight:700;padding:1px 6px;border-radius:4px;margin-right:4px;display:inline-block;}
  .badge.page{background:#f2b54426;color:#b8860b;}
  .badge.section{background:#35b8c926;color:#35b8c9;}
  .badge.doc{background:#b28cff26;color:#8a5fe0;}
  .badge.conf{background:#8881A;color:#666;}
  .badge.low{background:#f2b54426;color:#b8860b;}
  .badges{margin-bottom:3px;}
  .muted{color:#666;font-size:11px;}
  .footer{margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:8px;}
</style></head>
<body>
  <h1>RFP Analysis Report</h1>
  <div class="meta">Source: ${e(fileName || 'RFP Document')} &nbsp;·&nbsp; Generated ${today}</div>
  ${deadlineBannerHtml}
  ${confidenceBannerHtml}
  <div class="verdict">
    <div class="score">${score}</div>
    <div><div class="tag">${e(rec)}</div><div>${e(data.recommendation_summary || '')}</div></div>
  </div>
  ${disqHtml}
  ${riskFlagsHtml(data.risk_flags)}
  ${deliverablesHtml(data.deliverables_checklist)}
  ${insuranceHtml(data.insurance_figures)}
  ${checklistHtml('Financial / Accounting Checklist', '💰', data.financial_checklist)}
  ${checklistHtml('Legal Checklist', '⚖️', data.legal_checklist)}
  ${checklistHtml('Operations Checklist', '🗂️', data.operations_checklist)}
  ${checklistHtml('Technical Checklist', '🛠️', data.technical_checklist)}
  <div class="footer">Generated by RFP Intelligence Portal · Puppeteer-rendered report · Verify all terms against the original RFP before submission.</div>
</body></html>`;
}

async function generatePdfFromHtml(html, outputPath) {
  // Phase 6 fix: puppeteer v25+ ships ESM-only, so require() no longer works
  // for it. Loading it here with a dynamic import() (instead of the old
  // top-of-file require) works fine from inside this CommonJS file.
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' }
    });
  } finally {
    await browser.close();
  }
}

async function generateAndSaveReportPdf(analysisId, data, fileName) {
  const html = buildServerReportHtml(data, fileName);
  const outputPath = path.join(PDF_REPORTS_DIR, `${analysisId}.pdf`);
  await generatePdfFromHtml(html, outputPath);
  db.setPdfPath(analysisId, outputPath);
  return outputPath;
}

// GET /api/analyses/:id/report.pdf — serves the auto-generated report,
// falling back to generating it on-demand if it wasn't created yet
// (e.g. this analysis predates item #18, or generation failed earlier).
app.get('/api/analyses/:id/report.pdf', async (req, res) => {
  const job = db.getById(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Analysis not found.' });
  }
  if (job.status !== 'completed' || !job.data) {
    return res.status(409).json({ error: `Analysis is not ready yet (status: ${job.status}).` });
  }

  const base = safeExportFileBase(job.fileName);

  if (job.pdfPath && fs.existsSync(job.pdfPath)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${base}-report.pdf"`);
    return fs.createReadStream(job.pdfPath).pipe(res);
  }

  try {
    const outputPath = await generateAndSaveReportPdf(job.id, job.data, job.fileName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${base}-report.pdf"`);
    fs.createReadStream(outputPath).pipe(res);
  } catch (err) {
    console.error('Puppeteer PDF generation error:', err.message);
    res.status(500).json({ error: 'Could not generate PDF report.' });
  }
});


// --- Background worker (Phase 1 item #2) ---
// This is the actual "do the slow Gemini work" step. It runs in this same
// Node process (started right below via startWorker), listening on the
// same BullMQ queue that /api/analyze and /api/analyze-merged push jobs
// onto. Splitting it out like this means the HTTP handlers above only ever
// do fast, synchronous work (validate + enqueue + respond) — the part that
// can take a long time and occasionally fail (calling Gemini) happens here,
// off the request/response cycle entirely.
async function processAnalysisJob(payload) {
  const { kind, id, fileName } = payload;

  // Phase 3, item #8: proposal-generation jobs go through a completely
  // different pipeline (three sequential agents, no Go/No-Go scoring), so
  // route them there instead of the analysis logic below.
  if (kind === 'proposal') {
    return processProposalPipeline(payload);
  }

  // Phase 3, item #12: addendum-diff jobs are pure text comparison (+ an
  // optional summary call), not a Go/No-Go analysis — separate pipeline.
  if (kind === 'addendum-diff') {
    return processAddendumDiffJob(payload);
  }

  // Phase 4, item #13: proposal-library ingest jobs chunk + embed a past
  // proposal document — no Go/No-Go analysis, separate pipeline.
  if (kind === 'proposal-ingest') {
    return processProposalIngestJob(payload);
  }

  db.setStatus(id, 'active');
  try {
    const sourceText = kind === 'merged'
      ? payload.documents.map(d => `--- ${d.filename} ---\n${d.text}`).join('\n\n')
      : payload.rfpText;

    const prompt = kind === 'merged'
      ? buildMergedPrompt(payload.documents, payload.strengths, payload.gaps)
      : buildPrompt(payload.rfpText, payload.strengths, payload.gaps);

    const result = await callGemini(prompt);
    let finalResult = applyDeterministicChecks(result);
    // Phase 3, item #7: independent second-model re-check of the handful of
    // facts that actually drive the GO/NO-GO decision.
    finalResult = await crossCheckHighRiskFields(sourceText, finalResult);
    db.saveResult(id, finalResult);

    // Phase 5, item #19: fire alerts (no-op unless enabled in .env).
    await fireAnalysisAlerts(finalResult, fileName);

    // Phase 5, item #18: auto-generate the Puppeteer PDF report right away.
    // Non-fatal — a PDF-generation hiccup should never fail an otherwise
    // successful analysis; the on-demand fallback in /report.pdf covers it.
    try {
      await generateAndSaveReportPdf(id, finalResult, fileName);
    } catch (pdfErr) {
      console.warn('[Phase 5, item #18] Auto PDF generation failed (non-fatal):', pdfErr.message);
    }

    return finalResult;
  } catch (err) {
    db.markFailed(id, err.message || 'Analysis failed.');
    throw err; // let BullMQ record it as a failed job too
  }
}

startWorker(processAnalysisJob);

app.listen(PORT, () => {
  console.log(`RFP Intelligence backend running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Gemini model: ${process.env.GEMINI_MODEL || 'gemini-3.5-flash'} (set GEMINI_MODEL in .env to change)`);
  console.log(`Insurance threshold: $${INSURANCE_THRESHOLD.toLocaleString()} (set INSURANCE_THRESHOLD in .env to change)`);
  console.log(`Confidence review threshold: ${CONFIDENCE_REVIEW_THRESHOLD}% (set CONFIDENCE_REVIEW_THRESHOLD in .env to change)`);
  console.log(`Fit score thresholds: GO >= ${FIT_GO_THRESHOLD}, NO-GO < ${FIT_NOGO_THRESHOLD} (set FIT_GO_THRESHOLD / FIT_NOGO_THRESHOLD in .env to change)`);
  console.log(`Deadline urgency window: ${DEADLINE_URGENT_DAYS} day(s) (set DEADLINE_URGENT_DAYS in .env to change)`);
  console.log(`Cross-check: ${CROSS_CHECK_ENABLED ? `ON, model ${GEMINI_CROSS_CHECK_MODEL}` : 'OFF'} (set CROSS_CHECK_ENABLED / GEMINI_CROSS_CHECK_MODEL in .env to change)`);
  console.log(`Proposal library embedding model: ${GEMINI_EMBEDDING_MODEL} (set GEMINI_EMBEDDING_MODEL in .env to change)`);
  console.log(`OCR fallback: ${OCR_FALLBACK_ENABLED ? `ON, vision model ${GEMINI_VISION_MODEL}, triggers below ${OCR_FALLBACK_MIN_CHARS} extracted chars` : 'OFF'} (set OCR_FALLBACK_ENABLED / GEMINI_VISION_MODEL / OCR_FALLBACK_MIN_CHARS in .env to change)`);
  console.log(`Chat with this RFP: source text capped at ${CHAT_SOURCE_TEXT_MAX_CHARS.toLocaleString()} chars/turn, ${CHAT_MAX_HISTORY_TURNS} prior turn(s) replayed (set CHAT_SOURCE_TEXT_MAX_CHARS / CHAT_MAX_HISTORY_TURNS in .env to change)`);
  console.log('Database: backend/data/rfp.db (SQLite)');
  console.log(`Background worker started, listening on Redis at ${process.env.REDIS_URL || 'redis://127.0.0.1:6379'}`);
});