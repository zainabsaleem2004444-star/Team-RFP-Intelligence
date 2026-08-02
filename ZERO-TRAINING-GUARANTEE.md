# Zero-Training Guarantee

**Policy statement:** No RFP document, proposal content, chat message, or any
other data a user submits to this system is used to train, fine-tune, or
otherwise improve any public/general-purpose AI model.

This is a documentation/policy commitment, not a code change — there is no
"training toggle" to flip because this system never sends data anywhere that
would train a public model in the first place. This file exists so the policy
is written down and can be pointed to (in onboarding, client agreements, or an
SPS compliance review) rather than left as a verbal assurance.

## What this system does with your data

- Uploaded RFPs, extracted text, chat questions, and generated
  proposals/analysis are stored **only** in this system's own database
  (SQLite) for the purpose of serving the feature back to you (chat history,
  RAG retrieval, dashboards, reports).
- That data is sent to the **Gemini API** solely to generate a response for
  the request that triggered it (analysis, chat answer, embeddings, proposal
  draft) — the same way it's sent to any LLM API to get an answer back.

## Why this doesn't train a public model

- Google's Gemini API (the paid/API tier used here, not the free consumer
  Gemini app) is covered by Google's API terms, which state that content sent
  through the API is not used to train Google's models unless you explicitly
  opt in. This system does not opt in to any such data-sharing program.
- No fine-tuning jobs, no model-training pipelines, and no export of
  user/proposal data to any third-party model-training service exist
  anywhere in this codebase.

## Data retention / control

- All persisted data lives in this system's own database, under this
  system's/company's control — not a third-party AI vendor's training set.
- Deleting a record from this system's database removes it from this
  system; it was never queued for model training in the first place.

## Scope / limits of this guarantee

- This guarantee covers the AI provider used by this system (Gemini API).
  If the provider is changed in the future, this document should be
  reviewed and updated to reflect that provider's data-use terms.
- This is an internal/product-level policy statement. For a legally binding
  version (e.g. in a client contract or DPA with SPS), have this reviewed
  and formalized by whoever handles legal/compliance — this document is the
  plain-language basis for that, not a substitute for it.

_Last updated: 2026-08-02_
