# Quota-Optimized Audio & Captions Redesign (revised 2026-11-17)

Redesigns speech synthesis and caption alignment so normal single-voice and short dual-voice runs consume **1 Gemini API call** (down from 2 to 14+), eliminates automatic page-load requests, splits long scripts into safe chunks, and paces every job within the Tier 1 limits: **10 requests per minute (RPM)**, plus the per-day and tokens-per-minute limits.

## Changes in this revision

These are edits to the first draft of this plan. Everything not listed here is unchanged.

1. **Long scripts are chunked.** The "1 call" guarantee applies to scripts under a size limit. A full two-voice podcast script (1,700 to 2,200 words, 10 to 15 minutes of audio) is split at speaker turns into several calls. One call for 15 minutes of audio risks truncation and host timeouts.
2. **Two-voice scripts default to AI caption alignment.** A single multi-speaker call returns one audio file with no turn boundaries, so acoustic timing can only guess which speaker said which caption.
3. **The transcript is always the caption text.** No mode ever replaces the caller's words with recognized speech.
4. **Acoustic captions get a quality check, and a new `auto` mode** falls back to AI alignment only for audio that fails the check.
5. **Daily and token limits are tracked too,** not only RPM.
6. **Long jobs run asynchronously** (job ID and status endpoint), so no HTTP request is held open for minutes.
7. **The REST API requires an access key.** Today anyone with the address can spend the quota.
8. **The cache can be bypassed** to force a new take, and the plan says what happens to the cache and the rate ledger on restart.
9. **Existing response fields are kept** so current REST clients keep working, and acceptance tests are added.

## User Review & Critical Decisions

> [!IMPORTANT]
> The first three choices were already confirmed. Items 4 to 8 are new and need a yes before building.

- **On-Demand Generation Only (Confirmed)**: Removed automatic TTS synthesis when the Studio opens. Opening or refreshing the app consumes **0** API requests. Audio is generated only on **Generate** or a REST call.
- **Zero-API Acoustic Captions by Default for single-voice audio (Confirmed, narrowed)**: Synchronized `.srt`, `.vtt`, and interactive cues are generated locally from WAV energy and silence midpoints (**0** Gemini calls). This is the default for **single-voice** scripts only.
- **1-Call Dual-Speaker + Paced 3 to 5 Voice Pipeline (Confirmed, with a size limit)**: Scripts with 1 or 2 distinct voices that fit in one chunk synthesize in **1 call**. Scripts with 3 to 5 voices use the server-side rate pacer with `429 Retry-After` backoff and response caching.
- **4. Chunking for long scripts (New)**: Any script over `MAX_CHARS_PER_CALL` (default 3,000 characters, configurable) is split into chunks. Two-voice scripts split only at speaker turns; single-voice scripts split at sentence ends. Each chunk is one TTS call, the chunks are stitched with the existing gap logic, and the rate pacer applies.
- **5. Caption mode defaults (New)**: `acoustic` for single-voice, `ai` for two or more voices. Callers can override with `captionMode: "acoustic" | "ai" | "auto"`.
- **6. Asynchronous long jobs (New)**: Any job that needs more than one TTS call, or whose estimated time exceeds 45 seconds, returns `202 Accepted` with a job ID.
- **7. Access key on the REST API (New)**: Every `/api/tts/*` route except `/api/health` requires `x-api-key`, checked against `STUDIO_ACCESS_KEY` in the server environment.
- **8. Cache bypass (New)**: `noCache: true` forces a new take.

---

## 1. Overview & Core Concept

- **What It Does**: Turns the Audio & Captions Studio and REST API from a high-fan-out per-segment caller into a quota-aware pipeline: 1 request for single-voice and short dual-voice recordings, safe chunking for long scripts, and automatic protection against the per-minute and per-day limits.
- **Target Audience / Persona**: Educators and script authors on Tier 1 Gemini API quotas, using either the Studio UI or headless REST calls. The main REST caller is a batch script that generates one clip per lesson slide (20 to 60 clips per run) and, later, two-voice podcasts.
- **Key Value**: Prevents `429 RESOURCE_EXHAUSTED` failures, keeps captions word-for-word faithful to the script, and shows the request cost before generating.

### Quota Savings Comparison

| Scenario | Before Redesign | After Redesign |
| :--- | :--- | :--- |
| Opening the app | 2 calls (auto-run) | **0 calls** |
| Single-voice recording + captions (under 3,000 characters) | 2 calls | **1 call** |
| Single-voice recording, 6,000 characters | 2 calls (may truncate) | **2 calls** (chunked) |
| 2-voice script with 4 alternating turns (short) | 8 calls | **2 calls** (1 TTS + 1 AI alignment), or 1 with `captionMode: "acoustic"` |
| 2-voice podcast, about 2,000 words | 40+ calls | **about 10 to 12 calls**, paced (5 to 6 TTS chunks, each with 1 alignment call) |
| 3-voice script + captions | 6 calls | **3 TTS calls** (paced) + alignment per the caption mode |
| Repeat click / identical REST payload | Re-runs full pipeline | **0 calls** (cached), unless `noCache: true` |

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Zero-State Studio Ready**: Opening the Studio shows the pre-loaded lesson brief, the voice selector, and an empty player stage that prompts *"Click Generate Audio & Captions to synthesize this brief."* This spends **0** API calls until triggered.
  2. **Pre-Flight Call Budget Readout**: Next to **Generate**, unboxed monospace metadata shows the exact request cost before clicking (for example `1 API call · Instant acoustic captions`, or `5 TTS calls · +5 AI alignment · about 70s`). For chunked jobs it also shows the chunk count.
  3. **Captions Mode Control**: Under Synthesis Options, a compact control offers **Acoustic Timing (0 calls)**, **AI Precision Alignment (+1 call per chunk)**, and **Auto (AI only if the check fails)**. The default follows decision 5.
  4. **Pacing & Cooldown Feedback**: When a job has to wait for the quota window, the player stage shows a clear status message (for example *"Pacing chunk 3 of 5 to stay within 10 RPM..."* or *"Quota cooldown: retrying automatically in 18s..."*) instead of failing.
  5. **Caption Check Readout (New)**: After generation, the same metadata line shows the caption check result (for example `Captions: acoustic · 6 of 6 sentence ends in pauses`). A failed check offers a one-click **Align with AI**.
  6. **New Take (New)**: A **New take** action regenerates with `noCache: true`.
- **Visual Identity & Theme**: unchanged from the first draft (existing Studio look, unboxed monospace metadata, single-line controls, 4.5:1 contrast).

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Native Dual-Speaker Synthesis (`multiSpeakerVoiceConfig`), one call per chunk**
  - *Chosen Approach*: When a parsed script contains exactly 2 distinct voices, route each chunk in **1** call to `gemini-3.8-flash-tts` using native `multiSpeakerVoiceConfig`.
  - *Why*: Cuts a 4 to 8 turn conversation from 8 to 16 calls to 1, and keeps natural turn-taking.
  - *Trade-Off*: Native multi-speaker needs `gemini-3.8-flash-tts` and supports exactly 2 speakers, so a 2-voice script sent with the Lite model is routed through `gemini-3.8-flash-tts`.
  - *Limit (New)*: One call must not be asked for more than `MAX_CHARS_PER_CALL`. Confirm the model's real output limit by test (acceptance test 3) and set the default below it. After each call, compare the returned audio length with the length expected from the word count; if it is more than 25% short, treat the chunk as truncated, split it in half, and retry.

- **Decision 2: Caption alignment by voice count, with a check**
  - *Chosen Approach*: Caption **text** always comes from the caller's transcript, split into cues. Only the **timings** are computed.
    - **Single voice:** local RMS silence-midpoint detection with duration-weighted splitting inside sentences (**0** calls).
    - **Two or more voices:** one AI alignment request per synthesized chunk, because the audio has no turn boundaries and speaker labels must be right.
    - **`auto`:** run acoustic first, run the check below, and call AI alignment only for chunks that fail.
  - *Caption check (New)*: Sentence ends are matched to detected pauses in order, not assumed to be one-to-one (commas create extra pauses, and some sentences run together). The response reports how many sentence-ending cues end inside a detected pause of at least 0.25 seconds. Below 90% is a fail.
  - *Trade-Off*: Acoustic timing inside a long sentence is proportional, so it can drift by a second or so within that sentence. It re-anchors at every matched sentence end.

- **Decision 3: Server-Side Rate Gate, Backoff, and Cache**
  - *Chosen Approach*: Keep a sliding request ledger per model for the **per-minute** limit and a counter for the **per-day** limit, and estimate tokens for the **tokens-per-minute** limit. Limits are read from environment settings (`RPM_LIMIT`, `RPD_LIMIT`, `TPM_LIMIT`) so they can follow the account's tier. Deduplicate identical requests with a SHA-256 response cache, merge consecutive same-speaker sections, and honor Google's `429 RetryInfo.retryDelay`.
  - *Restart behavior (New)*: The ledger and cache are in memory. After a restart the gate assumes the minute window is **full** for 60 seconds, so a restart can never cause a burst. If the host runs more than one instance, state this limit in the README and keep to one instance, or move the ledger to shared storage.
  - *Daily limit (New)*: When the daily limit is reached, return `429` with `retryAfterSec` set to the time until reset. Do not hold the request.
  - *Cache bypass (New)*: `noCache: true` skips the cache read and replaces the cached entry.

- **Decision 4: Asynchronous jobs for long work (New)**
  - *Chosen Approach*: `POST /api/tts/generate` stays synchronous for a job that needs exactly one TTS call and no more than 45 seconds. Otherwise it returns `202` with `{ jobId, statusUrl }`. `GET /api/tts/jobs/:id` returns `{ status: "queued" | "running" | "done" | "failed", progress: { chunk, of }, result }`, where `result` is the same body the synchronous call returns. Callers can force either behavior with `async: true | false`; `async: false` on a long job returns `400` with the reason.
  - *Why*: A 3-minute clip already takes about a minute to return. A paced 10-call podcast would hold a request open for several minutes and fail at the host's timeout.

- **Decision 5: Access key (New)**
  - *Chosen Approach*: Require `x-api-key` on all `/api/tts/*` routes. Compare with `STUDIO_ACCESS_KEY` from the server environment using a constant-time comparison. Missing or wrong key returns `401`. The Studio UI sends the key from its own server-side session, never from client code. Never log the key.
  - *Why*: The published address is reachable by anyone. Without a key, strangers consume the 10 RPM window and the spend.

---

## 4. Technical Architecture & Data Strategy

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                              Studio UI & REST                              │
│  ┌──────────────────────┐  ┌─────────────────────┐  ┌───────────────────┐  │
│  │ Voice & Script Panel │  │  Pre-Flight Cost &  │  │  REST API Client  │  │
│  │ (Single / [1]–[5])   │  │  Caption Mode       │  │  (x-api-key)      │  │
│  └──────────┬───────────┘  └──────────┬──────────┘  └─────────┬─────────┘  │
└─────────────┼─────────────────────────┼───────────────────────┼────────────┘
              │ Manual "Generate" Click │                       │
              ▼                         ▼                       ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        Synthesis & Quota Router                            │
│                                                                            │
│   0. Check access key (401 if missing or wrong)                            │
│   1. Normalize Brief + Merge Adjacent Same-Speaker Segments                │
│   2. Check Content-Addressed Cache (0 calls on hit, unless noCache)        │
│   3. Split into chunks of at most MAX_CHARS_PER_CALL                       │
│      (at speaker turns for 2 voices, at sentence ends for 1 voice)         │
│   4. Sync or async? (1 call and under 45 s = sync, otherwise job ID)       │
│   5. Route each chunk by Distinct Voice Count, through the rate gate       │
│      (RPM + RPD + TPM, 429 RetryInfo backoff):                             │
│      ├── 1 Voice  ──────────────────► 1 TTS Call (Selected Model)          │
│      ├── 2 Voices ──────────────────► 1 Native Multi-Speaker TTS Call      │
│      └── 3–5 Voices ────────────────► 1 TTS Call per voice segment         │
│   6. Truncation check per chunk (split and retry if audio is too short)    │
│   7. Stitch WAV (existing gap logic)                                       │
│   8. Align Captions (text is always the transcript):                       │
│      ├── acoustic ─► Local silence detection + caption check (0 calls)     │
│      ├── ai ───────► 1 Gemini alignment call per chunk                     │
│      └── auto ─────► acoustic, then ai only for chunks that fail the check │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Request Normalization & Segment Coalescing**: Consecutive `[1]` segments (or empty turns) are merged before synthesis so only true speaker switches create separate turns.
- **Speaker labels**: In `ai` mode each cue's `speakerSlot` and `voiceName` come from the alignment. In `acoustic` mode on multi-voice audio, labels are estimates; mark them with `speakerEstimated: true`.
- **REST API compatibility (must not break existing clients)**:
  - Keep these response fields exactly as they are today: `id`, `mimeType`, `durationSec`, `sampleRate`, `voiceName`, `voicesUsed`, `voiceMap`, `segments`, `model`, `downloads.wav`, `downloads.srt`, `downloads.vtt`, `srt`, `vtt`, and `cues[]` with `index`, `startSec`, `endSec`, `text`, `speakerSlot`, `voiceName`.
  - Keep the request fields `transcript`, `brief`, `voiceName`, `voiceMap`, `directorsNotes`, `omitBase64`, `format`, `gapSec`, `includeCaptions`.
  - New request fields: `captionMode`, `noCache`, `async`.
  - New response fields: `apiCallsUsed`, `cached`, `captionMode` (the mode actually used), `captionCheck: { sentenceEnds, inPauses, passed }`, `chunks: [{ index, chars, durationSec, apiCalls }]`.
  - New status codes: `401` (no or wrong key), `202` (job accepted), `429` with a `Retry-After` header and `{ error, retryAfterSec }`.
- **Documentation**: Update the REST API document with the published base URL, the `x-api-key` header, the job endpoints, the new fields, and one example of a chunked two-voice request.

---

## 5. Acceptance Tests (New)

The redesign is done when all of these pass against the published app.

1. **Short single voice.** A 660-character transcript returns synchronously with `apiCallsUsed: 1`. The joined cue text equals the transcript word for word, and `captionCheck.passed` is true.
2. **Long single voice.** A 2,900-character transcript returns one chunk, full length. A 6,000-character transcript returns two chunks, and the stitched audio has no missing sentence.
3. **Two-voice podcast.** A 2,000-word script with `[1]` and `[2]` turns returns `202`, finishes as `done`, the audio length is within 15% of the length expected from the word count, the joined cue text equals the script, and every cue's `speakerSlot` matches the script's speaker for that text.
4. **Rate limit.** Twelve different single-voice requests sent within 10 seconds all succeed, with none failing on a `429` from Google, and the server never sends more than `RPM_LIMIT` calls in any 60 seconds.
5. **Cache.** Sending the same payload twice returns `cached: true` and `apiCallsUsed: 0` the second time. Adding `noCache: true` returns new audio and `cached: false`.
6. **Access key.** A request with no `x-api-key` returns `401` and makes no Gemini call. `/api/health` still returns `200` without a key.
7. **Restart.** Immediately after a restart, a burst of requests is paced and does not exceed the per-minute limit.
8. **Old client.** A request that uses only today's fields still returns today's fields with the same names and types.
