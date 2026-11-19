# Teacher Voice Library — Audio & Captions Studio

An educational Voice Casting Library and Audio & Captions Studio with both an interactive web studio and a quota-aware headless REST API.

## Key Features

- **On-Demand Generation**: Opening or refreshing the Studio consumes **0** Gemini API calls until you click **Generate Audio & Captions** or send a REST request.
- **1-Call Single & Short Dual-Voice Synthesis**:
  - Single-voice scripts (`<= MAX_CHARS_PER_CALL`, default `3,000` chars) synthesize in **1 TTS call** with **0-call** local acoustic captions by default.
  - Two-voice `[1]` / `[2]` scripts synthesize each chunk natively in **1 `multiSpeakerVoiceConfig` call** on `gemini-3.8-flash-tts`, defaulting to pre-split AI caption alignment (`captionMode: "ai"`) that preserves exact transcript wording and speaker slots.
  - 3–5 voice `[1]`–`[5]` scripts coalesce consecutive same-speaker sections and synthesize sequentially through the rate gate.
- **Chunking & Truncation Recovery**: Scripts over `MAX_CHARS_PER_CALL` split safely at sentence boundaries (1 voice) or speaker turns (2 voices), check returned audio duration against word count, automatically split and retry any truncated chunk, and stitch WAV audio seamlessly.
- **Per-Model Rate Gate & Caching**: Tracks sliding-window RPM (`RPM_LIMIT=10`), TPM (`TPM_LIMIT=100000`), and UTC-day RPD (`RPD_LIMIT=500`), respects Gemini `429 RetryInfo.retryDelay`, and deduplicates identical requests with a SHA-256 response cache (`noCache: true` to force a new take).
- **Async Job Queue (`202 Accepted`)**: Multi-chunk or `> 45s` jobs automatically return `202` with `/api/tts/jobs/:id` so long podcasts never hit HTTP gateway timeouts.
- **Access Key Protection**: All `/api/tts` and `/api/tts/*` routes require `x-api-key` matching `STUDIO_ACCESS_KEY` (constant-time SHA-256 check) or a signed server-issued browser session cookie.

## Environment Variables

Configure secrets in Settings > Secrets (or `.env` for local runs):

- `GEMINI_API_KEY`: Google Gemini API key (server-side only).
- `STUDIO_ACCESS_KEY`: Secret access key required in `x-api-key` for REST calls to `/api/tts/*`.
- `MAX_CHARS_PER_CALL`: Max characters per TTS call before chunking (default `3000`).
- `RPM_LIMIT`: Per-minute request cap per model (default `10`).
- `RPD_LIMIT`: Per-day request cap per model (default `500`).
- `TPM_LIMIT`: Estimated tokens-per-minute cap per model (default `100000`).

## Single-Instance & Restart Note

The sliding-window rate ledger and SHA-256 response cache are stored **in memory** inside the Express backend:

1. Deploy with **a single server instance** (or migrate the rate ledger to shared Redis/DB storage if running multiple replicas).
2. On startup/restart, the rate gate initializes each model's 60-second window as full so a rapid restart can never cause an upstream `429` burst.

## REST API Documentation

See [`API.md`](./API.md) for complete endpoint specifications, request/response schemas, `x-api-key` examples, and chunked two-voice podcast polling examples.
