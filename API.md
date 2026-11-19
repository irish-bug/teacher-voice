# Teacher Voice Library — Audio & Captions REST API

Base URL (Published):
`https://ais-pre-nil6nx6ozkhmmqmcd5zobg-920601229310.us-east1.run.app`

Base URL (Local / Development):
`http://localhost:3000`

---

## Authentication (`x-api-key`)

Every `/api/tts` and `/api/tts/*` endpoint requires an `x-api-key` header matching the `STUDIO_ACCESS_KEY` secret configured in the server environment (checked with a constant-time comparison).

- Missing or invalid `x-api-key` returns **`401 Unauthorized`** and makes **0 Gemini API calls**.
- Browser requests originating from the Studio UI authenticate via a signed, `HttpOnly` session cookie issued by the server.
- `GET /api/health` remains public (`200 OK`) without an access key.

```bash
curl -sS https://ais-pre-nil6nx6ozkhmmqmcd5zobg-920601229310.us-east1.run.app/api/tts/voices \
  -H "x-api-key: YOUR_STUDIO_ACCESS_KEY"
```

---

## Endpoints

### 1. `GET /api/tts`
Returns service metadata, active rate/chunking limits, default speaker slots (`1–5`), and endpoint summaries.

### 2. `GET /api/tts/voices`
Lists all 30 available TTS voices with gender, pitch, and characteristics, plus `defaultVoiceSlots`.

### 3. `POST /api/tts/generate`
Synthesizes single-voice or multi-voice `[1]`–`[5]` WAV speech and synchronized captions (`.srt`, `.vtt`, and JSON cues).

- **Synchronous (`200 OK`)**: Used when the job requires **1 TTS call** and is estimated at **<= 45 seconds** (or on an immediate SHA-256 cache hit).
- **Asynchronous (`202 Accepted`)**: Used automatically when a script splits into **> 1 chunk** (over `MAX_CHARS_PER_CALL`, default `3000`) or estimated runtime exceeds **45 seconds**. Returns `{ jobId, statusUrl }`.
- **Rate Limited (`429 Too Many Requests`)**: Returned immediately with `Retry-After` header and `{ error, retryAfterSec }` if the daily quota (`RPD_LIMIT`) is reached. Within the minute window, the server automatically paces requests cleanly below `RPM_LIMIT` / `TPM_LIMIT`.

#### Request Parameters (JSON Body or Query Params)

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `transcript` | `string` | *(required unless `brief`)* | Spoken script text. Prefix sections with `[1]`, `[2]`, `[3]`, `[4]`, `[5]` for multi-voice dialogue. |
| `brief` / `markdown` | `string` | `""` | Optional Markdown brief (`## Audio Profile`, `## Scene`, `## Director's Notes`, `## Transcript`). Also accepted as `text/markdown` body. |
| `voiceName` | `string` | `"Achernar"` | Single-speaker voice name (or fallback for slot `1`). |
| `voiceMap` | `object \| string[]` | Slots `1–5` presets | Slot-to-voice map, e.g. `{"1": "Achernar", "2": "Sadaltager"}`. Also supports `?voices=A,B` or `?voice1=A&voice2=B`. |
| `model` | `string` | `"gemini-3.8-flash-tts"` | `"gemini-3.8-flash-tts"` or `"gemini-3.8-flash-lite-tts"`. Scripts with 2 distinct voices automatically route through `"gemini-3.8-flash-tts"` for native dual-speaker synthesis. |
| `audioProfile`, `scene`, `directorsNotes`, `sampleContext` | `string` | `""` | Performance direction passed to speech metadata. |
| `captionMode` | `"acoustic" \| "ai" \| "auto"` | `"acoustic"` (1 voice) / `"ai"` (2+ voices) | `"acoustic"`: 0 extra API calls via RMS silence detection; `"ai"`: 1 alignment call per chunk preserving exact script words & speakers; `"auto"`: acoustic first, AI fallback only for chunks failing `captionCheck`. |
| `alignModel` | `"gemini-4-hydrogen" \| "gemini-3.1-flash-lite" \| "auto"` | `"gemini-4-hydrogen"` | Model used for AI caption alignment (`captionMode` `"ai"` or `"auto"`). `"3.1-flash-lite"` uses a separate RPM/RPD quota bucket; `"auto"` tries `gemini-4-hydrogen` first and falls back to `gemini-3.1-flash-lite` on `429`. |
| `includeCaptions` | `boolean` | `true` | Set `false` to skip caption alignment completely. |
| `noCache` | `boolean` | `false` | Set `true` to bypass the SHA-256 response cache and force a fresh take. |
| `async` | `boolean` | *(auto)* | Force `202` async job (`true`) or force sync (`false` — returns `400` if job requires > 1 TTS call or > 45s). |
| `format` | `"json" \| "wav" \| "srt" \| "vtt"` | `"json"` | Direct file download on sync response (`200`). |
| `omitBase64` | `boolean` | `false` | Omit `audioBase64` from JSON and rely on `downloads.wav`. |
| `gapSec` | `number` | `0.22` | Silence gap in seconds (`0`–`3`) between stitched chunks or 3–5 voice turns. |

#### Response Fields (`200 OK` JSON / `job.result`)

All existing fields are preserved:
- `id`, `audioBase64` (unless `omitBase64: true`), `mimeType`, `durationSec`, `sampleRate`, `voiceName`, `voicesUsed`, `voiceMap`, `segments`, `model`, `downloads` (`wav`, `srt`, `vtt`), `cues` (`index`, `startSec`, `endSec`, `text`, `speakerSlot`, `voiceName`, plus optional `speakerEstimated: true`), `srt`, `vtt`.

New quota & diagnostic fields:
- `apiCallsUsed` (`number`): Total Gemini API calls consumed (`0` on cache hit).
- `cached` (`boolean`): Whether served from cache.
- `captionMode` (`"acoustic" | "ai"`): Effective caption mode used.
- `alignModel` (`string`, optional): Multimodal alignment model used when AI caption alignment ran (`"gemini-4-hydrogen"` or `"gemini-3.1-flash-lite"`).
- `captionCheck` (`{ sentenceEnds, inPauses, passed }`): Percentage of sentence-ending cues landing in detected pauses `>= 0.25s` (`passed` when `>= 90%`).
- `chunks` (`Array<{ index, chars, durationSec, apiCalls }>`): Per-chunk synthesis breakdown.

### 4. `GET /api/tts/jobs/:id`
Polls an asynchronous generation job returned with `202 Accepted`.

Query optional: `?format=wav|srt|vtt` when `status === "done"` to download the artifact directly.

```json
{
  "jobId": "job_...",
  "status": "running",
  "progress": {
    "chunk": 2,
    "of": 4,
    "phase": "pacing",
    "message": "Pacing chunk 2 of 4 (18s cooldown for gemini-3.8-flash-tts RPM/TPM)..."
  }
}
```

When `status === "done"`, `result` contains the complete response object identical to synchronous `POST /api/tts/generate`.

### 5. `GET /api/tts/artifacts/:id.(wav|srt|vtt)`
Downloads cached `.wav`, `.srt`, or `.vtt` artifacts from a previous request (`x-api-key` required).

---

## Examples

### Single-Voice Quick Clip (`1` Gemini API Call, `0` Caption Calls)

```bash
curl -sS -X POST "https://ais-pre-nil6nx6ozkhmmqmcd5zobg-920601229310.us-east1.run.app/api/tts/generate" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_STUDIO_ACCESS_KEY" \
  -d '{
    "voiceName": "Achernar",
    "model": "gemini-3.8-flash-lite-tts",
    "captionMode": "acoustic",
    "omitBase64": true,
    "transcript": "Welcome to module one. Today we cover zero-trust network architecture and least-privilege access."
  }'
```

### Chunked Two-Voice Podcast (`202` Async + Job Polling)

Scripts longer than `MAX_CHARS_PER_CALL` (`3000` chars) with `[1]` / `[2]` speaker turns split cleanly at speaker turn boundaries, synthesize 1 native dual-speaker call per chunk via `gemini-3.8-flash-tts`, apply `ai` caption alignment (preserving exact transcript wording and `speakerSlot`s), and run asynchronously via `/api/tts/jobs/:id`:

```bash
# 1. Start the async two-voice job (returns 202 Accepted)
JOB=$(curl -sS -X POST "https://ais-pre-nil6nx6ozkhmmqmcd5zobg-920601229310.us-east1.run.app/api/tts/generate" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_STUDIO_ACCESS_KEY" \
  -d '{
    "voiceMap": { "1": "Achernar", "2": "Sadaltager" },
    "captionMode": "ai",
    "omitBase64": true,
    "directorsNotes": "Warm, articulate educational podcast pacing.",
    "transcript": "[1] Welcome back to Security Foundations! Today we are breaking down encryption at rest versus encryption in transit.\n\n[2] Great topic. When data travels across a network, TLS protects the channel, whereas AES-256 storage encryption protects disks if hardware is stolen.\n\n[1] Exactly right—and let us walk through a real-world key rotation example next..."
  }')

JOB_ID=$(echo "$JOB" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.jobId)")

# 2. Poll until status is "done"
curl -sS "https://ais-pre-nil6nx6ozkhmmqmcd5zobg-920601229310.us-east1.run.app/api/tts/jobs/${JOB_ID}" \
  -H "x-api-key: YOUR_STUDIO_ACCESS_KEY"
```

---

## Single-Instance Quota & Restart Behavior

- Rate tracking (`RPM_LIMIT=10`, `RPD_LIMIT=500`, `TPM_LIMIT=100000`) and response caching live in process memory. Keep Cloud Run / hosting scaled to **1 instance** (or back the ledger with shared Redis storage if scaling horizontally).
- Immediately after server startup/restart, the rate gate treats the first 60-second window as full so a server restart can never trigger a burst past Tier 1 `RPM_LIMIT`.
