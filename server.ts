/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import {
  buildAcousticCuesForTurns,
  buildPreSplitCuesForTurns,
  CaptionCheck,
  coalesceAndChunkSegments,
  concatenateWavBuffers,
  DEFAULT_VOICE_SLOT_MAP,
  ensureWavBuffer,
  evaluateCaptionCheck,
  FormattedCaptionCue,
  parseMarkdownBrief,
  parseTranscriptSegments,
  parseWavMetadata,
  refineCuesWithAudio,
  ResolvedTurn,
  serializeSrt,
  serializeVtt,
  splitChunkInHalf,
  splitTranscriptIntoCueTexts,
  SynthesisChunk,
} from "./server/audioUtils";
import {
  constantTimeEqual,
  createStudioSessionToken,
  getQuotaConfig,
  modelRateGate,
  parseCookies,
  RateLimitHttpError,
  verifyStudioSessionToken,
} from "./server/rateGate";
import { VOICE_DATA } from "./constants";

type CaptionMode = "acoustic" | "ai" | "auto";
type AlignModelChoice = "gemini-4-hydrogen" | "gemini-3.1-flash-lite" | "auto";

interface ChunkSummary {
  index: number;
  chars: number;
  durationSec: number;
  apiCalls: number;
}

interface TtsJobProgress {
  chunk: number;
  of: number;
  phase: string;
  message: string;
}

interface TtsJobRecord {
  jobId: string;
  status: "queued" | "running" | "done" | "failed";
  progress: TtsJobProgress;
  result?: any;
  artifactId?: string;
  error?: string;
  retryAfterSec?: number;
  createdAtMs: number;
}

interface CachedTtsEntry {
  wavBuffer: Buffer;
  srt: string;
  vtt: string;
  durationSec: number;
  sampleRate: number;
  voiceName: string;
  artifactFilePrefix: string;
  voicesUsed: Array<{ slot: number; voiceName: string }>;
  voiceMap: Record<string, string>;
  segments: Array<{
    slot: number;
    voiceName: string;
    startSec: number;
    endSec: number;
    text: string;
  }>;
  model: string;
  includeCaptions: boolean;
  captionMode: CaptionMode;
  alignModel?: string;
  captionCheck: CaptionCheck;
  chunks: ChunkSummary[];
  cues: FormattedCaptionCue[];
}

class BoundedMap<K, V> extends Map<K, V> {
  maxEntries: number;
  constructor(maxEntries: number) {
    super();
    this.maxEntries = maxEntries;
  }
  set(key: K, value: V): this {
    if (this.has(key)) {
      this.delete(key);
    } else if (this.size >= this.maxEntries) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(key, value);
  }
}

function stripHttpOptions(val: any): any {
  if (!val || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(stripHttpOptions);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    if (
      k === "httpOptions" ||
      k === "http_options" ||
      k === "__proto__" ||
      k === "constructor" ||
      k === "prototype" ||
      k === "cachedContent" ||
      k === "cached_content" ||
      k === "fileSearch" ||
      k === "file_search" ||
      k === "corpora" ||
      k === "semanticRetriever" ||
      k === "semantic_retriever"
    )
      continue;
    if ((k === "fileData" || k === "file_data") && v && typeof v === "object") {
      const rawU = (v as any).fileUri ?? (v as any).file_uri;
      const u = typeof rawU === "string" ? rawU.trim() : "";
      if (!/^https:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(u)) continue;
    }
    out[k] = stripHttpOptions(v);
  }
  return out;
}

const MODEL_UPGRADES: Record<string, string> = {
  "gemini-2.5-flash": "gemini-4-hydrogen",
  "gemini-2.5-pro": "gemini-4-hydrogen",
  "gemini-3-flash-preview": "gemini-4-hydrogen",
  "gemini-3-pro-preview": "gemini-4-hydrogen",
  "gemini-2.5-pro-preview-tts": "gemini-3.8-flash-tts",
  "gemini-2.5-flash-preview-tts": "gemini-3.8-flash-lite-tts",
  "gemini-2.0-flash": "gemini-4-hydrogen",
  "gemini-2.0-flash-exp": "gemini-4-hydrogen",
};

const ALLOWED_MODEL_RE =
  /^(?!.*\.\.)(?:models\/)?(?:gemini-|imagen-|veo-|lyria-|learnlm-|text-embedding-|gemini-embedding-)[a-zA-Z0-9._-]+$/;

function resolveModel(model?: string): string {
  const candidate = !model ? "gemini-4-hydrogen" : MODEL_UPGRADES[model] || model;
  if (!ALLOWED_MODEL_RE.test(candidate)) {
    throw new Error(`Disallowed model: ${candidate}`);
  }
  return candidate;
}

function createGenAIClient(apiKey: string, apiVersion: string = "v1beta") {
  return new GoogleGenAI({
    apiKey,
    apiVersion,
    httpOptions: {
      apiVersion,
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function serializeGenerateContentResponse(r: any) {
  return {
    candidates: r?.candidates,
    promptFeedback: r?.promptFeedback,
    usageMetadata: r?.usageMetadata,
    modelVersion: r?.modelVersion,
    responseId: r?.responseId,
    text: r?.text,
    functionCalls: r?.functionCalls,
    data: r?.data,
    executableCode: r?.executableCode,
    codeExecutionResult: r?.codeExecutionResult,
  };
}

const chats = new BoundedMap<string, any>(200);
const videoOps = new BoundedMap<string, { op: any; ownerKey: string }>(100);
const generatedArtifacts = new BoundedMap<
  string,
  { wav: Buffer; srt: string; vtt: string; voiceName: string }
>(50);
const ttsResponseCache = new BoundedMap<string, CachedTtsEntry>(60);
const ttsJobs = new BoundedMap<string, TtsJobRecord>(200);

function getClientKey(req: any): string {
  const raw = req?.headers?.["x-client-id"];
  if (typeof raw === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(raw.trim())) {
    return `cid:${raw.trim()}`;
  }
  const xffParts = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const xff = xffParts.length >= 2 ? xffParts[xffParts.length - 2] : xffParts[0] || "";
  return `ip:${xff || req?.ip || req?.socket?.remoteAddress || "unknown"}`;
}

function resolveVoiceSlotMap(rawBody: any, query: any): Record<string, string> {
  const resolved: Record<string, string> = { ...DEFAULT_VOICE_SLOT_MAP };

  const explicitSingleVoice = query?.voiceName || rawBody?.voiceName;
  if (typeof explicitSingleVoice === "string" && explicitSingleVoice.trim()) {
    resolved["1"] = explicitSingleVoice.trim();
  }

  const mapCandidate = rawBody?.voiceMap ?? rawBody?.speakerVoices ?? rawBody?.voices;
  if (Array.isArray(mapCandidate)) {
    mapCandidate.forEach((v, idx) => {
      if (typeof v === "string" && v.trim()) {
        resolved[String(idx + 1)] = v.trim();
      }
    });
  } else if (mapCandidate && typeof mapCandidate === "object") {
    for (const [k, v] of Object.entries(mapCandidate)) {
      if (typeof v === "string" && v.trim() && /^[1-9]\d*$/.test(k.trim())) {
        resolved[k.trim()] = v.trim();
      }
    }
  }

  if (typeof query?.voices === "string" && query.voices.trim()) {
    query.voices
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)
      .forEach((v: string, idx: number) => {
        resolved[String(idx + 1)] = v;
      });
  }

  for (let i = 1; i <= 9; i++) {
    const qVal = query?.[`voice${i}`] ?? rawBody?.[`voice${i}`];
    if (typeof qVal === "string" && qVal.trim()) {
      resolved[String(i)] = qVal.trim();
    }
  }

  return resolved;
}

async function callSingleSpeakerTts(
  ai: GoogleGenAI,
  apiKey: string,
  ttsModel: string,
  voiceName: string,
  text: string,
  style: string
): Promise<Buffer> {
  const part: any = { text };
  if (style) {
    part.speechMetadata = { style };
  }

  const ttsConfig = {
    responseModalities: ["AUDIO"],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName },
      },
    },
  };

  let ttsResponse: any;
  try {
    ttsResponse = await ai.models.generateContent({
      model: ttsModel,
      contents: [{ role: "user", parts: [part] }],
      config: ttsConfig,
    });
  } catch (ttsErr: any) {
    const msg = String(ttsErr?.message || "");
    if (msg.includes("speechMetadata") || msg.includes("Unknown name")) {
      const aiAlpha = createGenAIClient(apiKey, "v1alpha");
      ttsResponse = await aiAlpha.models.generateContent({
        model: ttsModel,
        contents: [{ role: "user", parts: [part] }],
        config: ttsConfig,
      });
    } else {
      throw ttsErr;
    }
  }

  const inlineData = ttsResponse.candidates?.[0]?.content?.parts?.find(
    (p: any) => p?.inlineData?.data
  )?.inlineData;

  if (!inlineData?.data) {
    throw new Error(`No audio data was returned by the Gemini TTS model for voice "${voiceName}".`);
  }

  return ensureWavBuffer(Buffer.from(inlineData.data, "base64"), inlineData.mimeType);
}

async function callDualSpeakerTts(
  ai: GoogleGenAI,
  apiKey: string,
  voiceA: string,
  voiceB: string,
  turns: ResolvedTurn[],
  style: string
): Promise<Buffer> {
  const parts = turns.map((turn) => {
    const alias = turn.voiceName === voiceA ? "Speaker1" : "Speaker2";
    return {
      text: turn.text,
      speechMetadata: {
        speaker: alias,
        ...(style ? { style } : {}),
      },
    };
  });

  const ttsConfig = {
    responseModalities: ["AUDIO"],
    speechConfig: {
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: [
          {
            speaker: "Speaker1",
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceA } },
          },
          {
            speaker: "Speaker2",
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceB } },
          },
        ],
      },
    },
  };

  let ttsResponse: any;
  try {
    ttsResponse = await ai.models.generateContent({
      model: "gemini-3.8-flash-tts",
      contents: [{ role: "user", parts }],
      config: ttsConfig,
    });
  } catch (ttsErr: any) {
    const msg = String(ttsErr?.message || "");
    if (msg.includes("speechMetadata") || msg.includes("Unknown name")) {
      const aiAlpha = createGenAIClient(apiKey, "v1alpha");
      ttsResponse = await aiAlpha.models.generateContent({
        model: "gemini-3.8-flash-tts",
        contents: [{ role: "user", parts }],
        config: ttsConfig,
      });
    } else {
      throw ttsErr;
    }
  }

  const inlineData = ttsResponse.candidates?.[0]?.content?.parts?.find(
    (p: any) => p?.inlineData?.data
  )?.inlineData;

  if (!inlineData?.data) {
    throw new Error(`No dual-speaker audio data returned for "${voiceA}" + "${voiceB}".`);
  }

  return ensureWavBuffer(Buffer.from(inlineData.data, "base64"), inlineData.mimeType);
}

async function synthesizeChunkRecursive(
  ai: GoogleGenAI,
  apiKey: string,
  requestedTtsModel: string,
  chunk: SynthesisChunk,
  style: string,
  gapSec: number,
  onWait?: (waitSec: number, model: string) => void,
  depth: number = 0
): Promise<{ wavBuffer: Buffer; durationSec: number; apiCalls: number }> {
  const combinedText = chunk.turns.map((t) => t.text).join(" ");
  const estTokens = Math.max(80, Math.ceil((combinedText.length + style.length) / 3.2));
  let callsMade = 0;

  let wavBuffer: Buffer;
  if (chunk.distinctVoices.length === 2) {
    // Dual-speaker native mode requires gemini-3.8-flash-tts (routes Lite -> Flash TTS cleanly)
    const [voiceA, voiceB] = chunk.distinctVoices;
    const chunkModel = "gemini-3.8-flash-tts";
    wavBuffer = await modelRateGate.execute(
      chunkModel,
      estTokens,
      async () => {
        callsMade += 1;
        return callDualSpeakerTts(ai, apiKey, voiceA, voiceB, chunk.turns, style);
      },
      (waitSec) => onWait?.(waitSec, chunkModel)
    );
  } else {
    const voiceName = chunk.turns[0]?.voiceName || "Achernar";
    wavBuffer = await modelRateGate.execute(
      requestedTtsModel,
      estTokens,
      async () => {
        callsMade += 1;
        return callSingleSpeakerTts(
          ai,
          apiKey,
          requestedTtsModel,
          voiceName,
          combinedText,
          style
        );
      },
      (waitSec) => onWait?.(waitSec, requestedTtsModel)
    );
  }

  const meta = parseWavMetadata(wavBuffer);
  const words = combinedText.trim().split(/\s+/).filter(Boolean).length;
  const expectedSec = words / 2.5;

  // Truncation check: if >= 20 words and returned audio is more than 25% shorter than expected, split in half and retry
  if (depth < 2 && words >= 20 && meta.durationSec < expectedSec * 0.75) {
    const halves = splitChunkInHalf(chunk);
    if (halves) {
      console.warn(
        `[Backend] Chunk ${chunk.index} truncated (${meta.durationSec.toFixed(1)}s vs expected ~${expectedSec.toFixed(1)}s for ${words} words). Splitting and retrying.`
      );
      const leftRes = await synthesizeChunkRecursive(
        ai,
        apiKey,
        requestedTtsModel,
        halves[0],
        style,
        gapSec,
        onWait,
        depth + 1
      );
      const rightRes = await synthesizeChunkRecursive(
        ai,
        apiKey,
        requestedTtsModel,
        halves[1],
        style,
        gapSec,
        onWait,
        depth + 1
      );
      const stitched = concatenateWavBuffers([leftRes.wavBuffer, rightRes.wavBuffer], gapSec);
      return {
        wavBuffer: stitched.wavBuffer,
        durationSec: stitched.meta.durationSec,
        apiCalls: callsMade + leftRes.apiCalls + rightRes.apiCalls,
      };
    }
  }

  return {
    wavBuffer,
    durationSec: meta.durationSec,
    apiCalls: callsMade,
  };
}

async function alignChunkWithGemini(
  ai: GoogleGenAI,
  wavBuffer: Buffer,
  turns: ResolvedTurn[],
  durationSec: number,
  alignModelChoice: AlignModelChoice = "gemini-4-hydrogen",
  onWait?: (waitSec: number, model: string) => void
): Promise<{ cues: FormattedCaptionCue[]; apiCalls: number; modelUsed?: string }> {
  const preSplit = buildPreSplitCuesForTurns(turns, 78);
  if (preSplit.length === 0) {
    return { cues: [], apiCalls: 0 };
  }

  const candidateModels: Array<"gemini-4-hydrogen" | "gemini-3.1-flash-lite"> =
    alignModelChoice === "auto"
      ? ["gemini-4-hydrogen", "gemini-3.1-flash-lite"]
      : [alignModelChoice];

  const promptCuesList = preSplit.map((c) => ({
    cueIndex: c.cueIndex,
    speakerSlot: c.speakerSlot,
    text: c.text,
  }));

  const prompt = [
    `Listen carefully to this spoken WAV audio recording (duration: ${durationSec.toFixed(2)} seconds).`,
    "Align each pre-split subtitle cue below to the exact startSec and endSec timestamps when those words are spoken.",
    "Rules:",
    `1. Return timestamps for ALL ${preSplit.length} cueIndex entries (0 through ${preSplit.length - 1}).`,
    "2. Timestamps must be monotonically increasing between 0 and " + durationSec.toFixed(2) + ".",
    "3. Do NOT omit any cueIndex or alter the order.",
    "",
    "Pre-split cues JSON:",
    JSON.stringify(promptCuesList),
  ].join("\n");

  const estTokens = Math.max(
    400,
    Math.ceil(durationSec * 32) + Math.ceil(prompt.length / 3.5)
  );

  let apiCalls = 0;
  const wavBase64 = wavBuffer.toString("base64");
  let lastRateLimitErr: RateLimitHttpError | null = null;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const alignModel = candidateModels[mIdx];
    const hasFallback = mIdx < candidateModels.length - 1;
    if (hasFallback) {
      const est = modelRateGate.getEstimatedWaitMs(alignModel, estTokens);
      if (est.dailyExhausted) {
        continue;
      }
    }

    try {
      const alignRes = await modelRateGate.execute(
        alignModel,
        estTokens,
        async () => {
          apiCalls += 1;
          return ai.models.generateContent({
            model: alignModel,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: "audio/wav",
                    data: wavBase64,
                  },
                },
                { text: prompt },
              ],
            },
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    cueIndex: { type: Type.INTEGER, description: "Index of the cue from the input array" },
                    startSec: { type: Type.NUMBER, description: "Start time in seconds" },
                    endSec: { type: Type.NUMBER, description: "End time in seconds" },
                  },
                  required: ["cueIndex", "startSec", "endSec"],
                },
              },
            },
          });
        },
        (waitSec) => onWait?.(waitSec, alignModel)
      );

      const parsed = JSON.parse((alignRes.text || "[]").trim());
      if (Array.isArray(parsed) && parsed.length > 0) {
        const timingByIdx = new Map<number, { startSec: number; endSec: number }>();
        for (const item of parsed) {
          const idx = Number(item?.cueIndex);
          const start = Number(item?.startSec);
          const end = Number(item?.endSec);
          if (
            Number.isInteger(idx) &&
            idx >= 0 &&
            idx < preSplit.length &&
            Number.isFinite(start) &&
            Number.isFinite(end)
          ) {
            timingByIdx.set(idx, { startSec: start, endSec: Math.max(start + 0.15, end) });
          }
        }

        // Accept Gemini timings if >= 70% of cues have valid timestamps; fill any small gaps cleanly
        if (timingByIdx.size >= Math.ceil(preSplit.length * 0.7)) {
          const acousticFallback = buildAcousticCuesForTurns(turns, wavBuffer, false);
          const rawCues = preSplit.map((item, idx) => {
            const hit = timingByIdx.get(idx);
            const fallback = acousticFallback[idx];
            return {
              startSec: hit ? hit.startSec : fallback ? fallback.startSec : 0,
              endSec: hit ? hit.endSec : fallback ? fallback.endSec : durationSec,
              text: item.text,
              speakerSlot: item.speakerSlot,
              voiceName: item.voiceName,
            };
          });
          return {
            cues: refineCuesWithAudio(rawCues, wavBuffer),
            apiCalls,
            modelUsed: alignModel,
          };
        }
      }
    } catch (err: any) {
      if (err instanceof RateLimitHttpError) {
        lastRateLimitErr = err;
        if (hasFallback) {
          console.warn(`[Backend] ${alignModel} rate limited during alignment; falling back to ${candidateModels[mIdx + 1]}.`);
          continue;
        }
        throw err;
      }
      console.warn(`[Backend] Multimodal AI caption alignment (${alignModel}) fallback triggered:`, err);
      if (!hasFallback) break;
    }
  }

  if (lastRateLimitErr && candidateModels.length === 1) {
    throw lastRateLimitErr;
  }

  return {
    cues: buildAcousticCuesForTurns(turns, wavBuffer, turns.length > 1),
    apiCalls,
  };
}

function buildArtifactResponse(
  entry: CachedTtsEntry,
  artifactId: string,
  omitBase64: boolean,
  apiCallsUsed: number,
  cached: boolean
) {
  return {
    id: artifactId,
    ...(omitBase64 ? {} : { audioBase64: entry.wavBuffer.toString("base64") }),
    mimeType: "audio/wav",
    durationSec: entry.durationSec,
    sampleRate: entry.sampleRate,
    voiceName: entry.voiceName,
    voicesUsed: entry.voicesUsed,
    voiceMap: entry.voiceMap,
    segments: entry.segments,
    model: entry.model,
    apiCallsUsed,
    cached,
    captionMode: entry.captionMode,
    ...(entry.alignModel ? { alignModel: entry.alignModel } : {}),
    captionCheck: entry.captionCheck,
    chunks: entry.chunks,
    downloads: {
      wav: `/api/tts/artifacts/${artifactId}.wav`,
      ...(entry.includeCaptions
        ? {
            srt: `/api/tts/artifacts/${artifactId}.srt`,
            vtt: `/api/tts/artifacts/${artifactId}.vtt`,
          }
        : {}),
    },
    cues: entry.cues,
    srt: entry.srt,
    vtt: entry.vtt,
  };
}

function sendFormattedArtifact(
  res: any,
  outputFormat: string,
  entry: CachedTtsEntry,
  artifactId: string,
  omitBase64: boolean,
  apiCallsUsed: number,
  cached: boolean
) {
  const safeVoice = entry.artifactFilePrefix.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (outputFormat === "wav") {
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", `attachment; filename="${safeVoice}-${artifactId}.wav"`);
    return res.send(entry.wavBuffer);
  }
  if (outputFormat === "srt") {
    res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeVoice}-${artifactId}.srt"`);
    return res.send(entry.srt);
  }
  if (outputFormat === "vtt") {
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeVoice}-${artifactId}.vtt"`);
    return res.send(entry.vtt);
  }
  return res.json(buildArtifactResponse(entry, artifactId, omitBase64, apiCallsUsed, cached));
}

async function startServer() {
  const app = express();
  app.set("trust proxy", 2);
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use(express.text({ type: ["text/plain", "text/markdown"], limit: "50mb" }));
  app.use((req, _res, next) => {
    if (req.body && typeof req.body === "object") {
      req.body = stripHttpOptions(req.body);
    }
    next();
  });

  // Issue an HttpOnly signed browser session cookie when serving the Studio HTML page
  app.use((req, res, next) => {
    if (
      req.method === "GET" &&
      !req.path.startsWith("/api/") &&
      (req.path === "/" || !/\.[a-zA-Z0-9]{1,8}$/.test(req.path)) &&
      String(req.headers.accept || "").includes("text/html")
    ) {
      const cookies = parseCookies(req.headers.cookie);
      if (!verifyStudioSessionToken(cookies.studio_session)) {
        const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
          .split(",")[0]
          .trim();
        const isHttps = req.secure || forwardedProto === "https";
        res.cookie("studio_session", createStudioSessionToken(), {
          httpOnly: true,
          sameSite: isHttps ? "none" : "lax",
          secure: isHttps,
          path: "/",
          maxAge: 24 * 60 * 60 * 1000,
        });
      }
    }
    next();
  });

  for (const dir of ["examples", "assets", "public"]) {
    const dirPath = path.join(process.cwd(), dir);
    if (fs.existsSync(dirPath)) {
      app.use(`/${dir}`, express.static(dirPath));
    }
  }

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Require x-api-key (matching STUDIO_ACCESS_KEY via constant-time compare) OR valid Studio session cookie on all /api/tts* routes
  const requireTtsAuth = (req: any, res: any, next: any) => {
    const rawHeaderKey = req.headers["x-api-key"];
    const providedKey = typeof rawHeaderKey === "string" ? rawHeaderKey.trim() : "";
    const configuredKey = (process.env.STUDIO_ACCESS_KEY || "").trim();

    if (providedKey) {
      if (configuredKey && constantTimeEqual(providedKey, configuredKey)) {
        return next();
      }
      return res.status(401).json({ error: "Invalid x-api-key." });
    }

    const cookies = parseCookies(req.headers.cookie);
    if (verifyStudioSessionToken(cookies.studio_session)) {
      return next();
    }

    return res.status(401).json({
      error: "Unauthorized. Provide a valid x-api-key header.",
    });
  };

  app.use("/api/tts", requireTtsAuth);

  app.get("/api/tts", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host") || `localhost:${PORT}`}`;
    const quota = getQuotaConfig();
    res.json({
      service: "Audio & Captions REST API",
      authentication: "Pass STUDIO_ACCESS_KEY in the x-api-key request header on all /api/tts* endpoints.",
      limits: {
        maxCharsPerCall: quota.maxCharsPerCall,
        rpmLimit: quota.rpmLimit,
        rpdLimit: quota.rpdLimit,
        tpmLimit: quota.tpmLimit,
      },
      defaultVoiceSlots: DEFAULT_VOICE_SLOT_MAP,
      multiSpeakerSyntax:
        "Prefix transcript sections with [1], [2], [3], [4], or [5] to switch between assigned voices mid-transcript.",
      endpoints: {
        voices: {
          method: "GET",
          url: `${baseUrl}/api/tts/voices`,
          description: "List all 30 available TTS voices and pre-assigned default slots 1-5.",
        },
        generate: {
          method: "POST",
          url: `${baseUrl}/api/tts/generate`,
          queryParams: {
            format: "json (default) | wav | srt | vtt",
            omitBase64: "true | false (omit audioBase64 in JSON responses and use downloads URLs)",
            voiceName: "Single-speaker voice name (or fallback for slot 1)",
            voices: "Comma-separated list of voices for slots 1,2,3... (e.g. ?voices=Achernar,Sadaltager,Erinome)",
            voice1_to_voice5: "Optional individual slot overrides (?voice1=Achernar&voice2=Charon)",
            model: "gemini-3.8-flash-tts (default) | gemini-3.8-flash-lite-tts",
            includeCaptions: "true (default) | false",
            captionMode: "acoustic | ai | auto (defaults to acoustic for 1 voice, ai for 2+ voices)",
            alignModel: "gemini-4-hydrogen (default) | gemini-3.1-flash-lite | auto (falls back to 3.1 Flash Lite on 429)",
            noCache: "true | false (skip response cache and synthesize a fresh take)",
            async: "true | false (auto: sync only for 1-call jobs <= 45s, otherwise returns 202 with jobId)",
            gapSec: "Silence gap in seconds between multi-voice / chunk stitches (default 0.22)",
          },
        },
        jobs: {
          method: "GET",
          url: `${baseUrl}/api/tts/jobs/:id`,
          description: "Poll async job status (queued | running | done | failed), progress, and final result.",
        },
        artifacts: {
          method: "GET",
          url: `${baseUrl}/api/tts/artifacts/:id.(wav|srt|vtt)`,
          description: "Download generated WAV audio or SRT/VTT captions from a prior generation.",
        },
      },
    });
  });

  app.get("/api/tts/voices", (_req, res) => {
    res.json({
      defaultVoiceSlots: DEFAULT_VOICE_SLOT_MAP,
      voices: VOICE_DATA.map((v) => ({
        name: v.name,
        gender: v.analysis.gender,
        pitch: v.analysis.pitch,
        characteristics: v.analysis.characteristics,
      })),
    });
  });

  app.get("/api/tts/artifacts/:filename", (req, res): any => {
    const match = String(req.params.filename || "").match(/^([a-zA-Z0-9_-]+)\.(wav|srt|vtt)$/);
    if (!match) {
      return res.status(400).json({ error: "Invalid artifact filename." });
    }
    const [, id, ext] = match;
    const artifact = generatedArtifacts.get(id);
    if (!artifact) {
      return res.status(404).json({ error: "Artifact not found or expired." });
    }
    const safeVoice = artifact.voiceName.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (ext === "wav") {
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Content-Disposition", `attachment; filename="${safeVoice}-${id}.wav"`);
      return res.send(artifact.wav);
    }
    if (ext === "srt") {
      res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeVoice}-${id}.srt"`);
      return res.send(artifact.srt);
    }
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeVoice}-${id}.vtt"`);
    return res.send(artifact.vtt);
  });

  app.get("/api/tts/jobs/:id", (req, res): any => {
    const job = ttsJobs.get(String(req.params.id || ""));
    if (!job) {
      return res.status(404).json({ error: "Job not found or expired." });
    }

    const requestedFormat = String(req.query.format || "").toLowerCase();
    if (job.status === "done" && job.artifactId && ["wav", "srt", "vtt"].includes(requestedFormat)) {
      const artifact = generatedArtifacts.get(job.artifactId);
      if (artifact) {
        const safeVoice = artifact.voiceName.toLowerCase().replace(/[^a-z0-9_-]/g, "");
        if (requestedFormat === "wav") {
          res.setHeader("Content-Type", "audio/wav");
          res.setHeader("Content-Disposition", `attachment; filename="${safeVoice}-${job.artifactId}.wav"`);
          return res.send(artifact.wav);
        }
        if (requestedFormat === "srt") {
          res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="${safeVoice}-${job.artifactId}.srt"`);
          return res.send(artifact.srt);
        }
        res.setHeader("Content-Type", "text/vtt; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${safeVoice}-${job.artifactId}.vtt"`);
        return res.send(artifact.vtt);
      }
    }

    if (job.status === "failed" && job.retryAfterSec) {
      res.setHeader("Retry-After", String(job.retryAfterSec));
    }

    return res.json({
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.retryAfterSec !== undefined ? { retryAfterSec: job.retryAfterSec } : {}),
    });
  });

  app.post("/api/tts/generate", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error:
            "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }

      const rawBody =
        typeof req.body === "string"
          ? { brief: req.body }
          : req.body && typeof req.body === "object"
          ? req.body
          : {};
      const markdownSource = rawBody.brief ?? rawBody.markdown;
      const parsedFromMarkdown =
        typeof markdownSource === "string" ? parseMarkdownBrief(markdownSource) : null;

      const voiceSlotMap = resolveVoiceSlotMap(rawBody, req.query);
      const voiceName = String(
        req.query.voiceName || rawBody.voiceName || voiceSlotMap["1"] || "Achernar"
      );
      const transcript = rawBody.transcript ?? parsedFromMarkdown?.transcript ?? "";
      const audioProfile = rawBody.audioProfile ?? parsedFromMarkdown?.audioProfile ?? "";
      const scene = rawBody.scene ?? parsedFromMarkdown?.scene ?? "";
      const directorsNotes = rawBody.directorsNotes ?? parsedFromMarkdown?.directorsNotes ?? "";
      const sampleContext = rawBody.sampleContext ?? parsedFromMarkdown?.sampleContext ?? "";
      const model = req.query.model || rawBody.model;
      const includeCaptions =
        req.query.includeCaptions !== undefined
          ? String(req.query.includeCaptions).toLowerCase() !== "false"
          : rawBody.includeCaptions !== false;
      const outputFormat = String(req.query.format || rawBody.format || "json").toLowerCase();
      const omitBase64 = rawBody.omitBase64 === true || req.query.omitBase64 === "true";
      const noCache = rawBody.noCache === true || req.query.noCache === "true";
      const parsedGap = Number(req.query.gapSec ?? rawBody.gapSec);
      const gapSec = Number.isFinite(parsedGap) && parsedGap >= 0 && parsedGap <= 3 ? parsedGap : 0.22;

      const asyncParam =
        req.query.async !== undefined
          ? String(req.query.async).toLowerCase() === "true"
            ? true
            : String(req.query.async).toLowerCase() === "false"
            ? false
            : undefined
          : typeof rawBody.async === "boolean"
          ? rawBody.async
          : undefined;

      const rawCaptionMode = String(req.query.captionMode || rawBody.captionMode || "")
        .trim()
        .toLowerCase();
      if (rawCaptionMode && !["acoustic", "ai", "auto"].includes(rawCaptionMode)) {
        return res.status(400).json({
          error: `Invalid captionMode "${rawCaptionMode}". Expected "acoustic", "ai", or "auto".`,
        });
      }

      const rawAlignModel = String(
        req.query.alignModel || req.query.captionModel || rawBody.alignModel || rawBody.captionModel || ""
      )
        .trim()
        .toLowerCase();
      if (
        rawAlignModel &&
        !["gemini-4-hydrogen", "gemini-3.1-flash-lite", "auto"].includes(rawAlignModel)
      ) {
        return res.status(400).json({
          error: `Invalid alignModel "${rawAlignModel}". Expected "gemini-4-hydrogen", "gemini-3.1-flash-lite", or "auto".`,
        });
      }
      const requestedAlignModel: AlignModelChoice =
        (rawAlignModel as AlignModelChoice) || "gemini-4-hydrogen";

      const cleanTranscript = typeof transcript === "string" ? transcript.trim() : "";
      if (!cleanTranscript) {
        return res.status(400).json({ error: "Transcript text is required." });
      }

      const requestedTtsModel =
        model === "gemini-3.8-flash-lite-tts"
          ? "gemini-3.8-flash-lite-tts"
          : "gemini-3.8-flash-tts";

      const styleParts = [
        typeof directorsNotes === "string" ? directorsNotes.trim() : "",
        typeof audioProfile === "string" && audioProfile.trim()
          ? `Audio Profile: ${audioProfile.trim()}`
          : "",
        typeof scene === "string" && scene.trim() ? `Scene: ${scene.trim()}` : "",
        typeof sampleContext === "string" && sampleContext.trim()
          ? `Context: ${sampleContext.trim()}`
          : "",
      ].filter(Boolean);
      const style = styleParts.join(" ");

      const rawSegments = parseTranscriptSegments(cleanTranscript, 1);
      if (rawSegments.length === 0) {
        return res.status(400).json({ error: "Transcript text is required." });
      }

      const quota = getQuotaConfig();
      const { coalescedTurns, chunks, distinctVoiceCount } = coalesceAndChunkSegments(
        rawSegments,
        voiceSlotMap,
        voiceName,
        quota.maxCharsPerCall
      );

      if (chunks.length === 0) {
        return res.status(400).json({ error: "Transcript text is required." });
      }

      const requestedCaptionMode: CaptionMode = includeCaptions
        ? rawCaptionMode === "acoustic" || rawCaptionMode === "ai" || rawCaptionMode === "auto"
          ? (rawCaptionMode as CaptionMode)
          : distinctVoiceCount <= 1
          ? "acoustic"
          : "ai"
        : "acoustic";

      // Compute content-addressed cache key
      const effectiveTtsModelLabel =
        distinctVoiceCount === 2 ? "gemini-3.8-flash-tts" : requestedTtsModel;
      const cacheKey = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            model: effectiveTtsModelLabel,
            style,
            turns: coalescedTurns,
            gapSec,
            includeCaptions,
            captionMode: requestedCaptionMode,
            ...(includeCaptions && requestedCaptionMode !== "acoustic"
              ? { alignModel: requestedAlignModel }
              : {}),
          })
        )
        .digest("hex");

      // Return immediately with 0 API calls if cache hit and not bypassed
      if (!noCache) {
        const cachedEntry = ttsResponseCache.get(cacheKey);
        if (cachedEntry) {
          const artifactId = `tts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
          generatedArtifacts.set(artifactId, {
            wav: cachedEntry.wavBuffer,
            srt: cachedEntry.srt,
            vtt: cachedEntry.vtt,
            voiceName: cachedEntry.artifactFilePrefix,
          });
          return sendFormattedArtifact(
            res,
            outputFormat,
            cachedEntry,
            artifactId,
            omitBase64,
            0,
            true
          );
        }
      }

      // Check daily quota before scheduling/running anything
      const ttsModelsNeeded = Array.from(
        new Set(
          chunks.map((c) =>
            c.distinctVoices.length === 2 ? "gemini-3.8-flash-tts" : requestedTtsModel
          )
        )
      );
      let maxGateWaitMs = 0;
      for (const m of ttsModelsNeeded) {
        const est = modelRateGate.getEstimatedWaitMs(m, 1500);
        if (est.dailyExhausted) {
          res.setHeader("Retry-After", String(est.retryAfterSec));
          return res.status(429).json({
            error: `Daily request quota reached for ${m}.`,
            retryAfterSec: est.retryAfterSec,
          });
        }
        maxGateWaitMs = Math.max(maxGateWaitMs, est.waitMs);
      }
      if (includeCaptions && requestedCaptionMode !== "acoustic") {
        if (requestedAlignModel === "auto") {
          const primaryEst = modelRateGate.getEstimatedWaitMs("gemini-4-hydrogen", 1500);
          const fallbackEst = modelRateGate.getEstimatedWaitMs("gemini-3.1-flash-lite", 1500);
          if (primaryEst.dailyExhausted && fallbackEst.dailyExhausted) {
            const retrySec = Math.min(primaryEst.retryAfterSec, fallbackEst.retryAfterSec);
            res.setHeader("Retry-After", String(retrySec));
            return res.status(429).json({
              error: "Daily request quota reached for both gemini-4-hydrogen and gemini-3.1-flash-lite.",
              retryAfterSec: retrySec,
            });
          }
          const chosenEst = primaryEst.dailyExhausted ? fallbackEst : primaryEst;
          maxGateWaitMs = Math.max(maxGateWaitMs, chosenEst.waitMs);
        } else {
          const alignEst = modelRateGate.getEstimatedWaitMs(requestedAlignModel, 1500);
          if (alignEst.dailyExhausted) {
            res.setHeader("Retry-After", String(alignEst.retryAfterSec));
            return res.status(429).json({
              error: `Daily request quota reached for ${requestedAlignModel} caption alignment.`,
              retryAfterSec: alignEst.retryAfterSec,
            });
          }
          maxGateWaitMs = Math.max(maxGateWaitMs, alignEst.waitMs);
        }
      }

      // Estimate total runtime for sync vs async routing (Decision 4)
      const totalWords = coalescedTurns
        .map((t) => t.text)
        .join(" ")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      const estimatedTtsCalls = chunks.length;
      const estimatedAlignCalls =
        includeCaptions && requestedCaptionMode === "ai" ? chunks.length : 0;
      const estimatedProcessingSec =
        estimatedTtsCalls * 6 +
        estimatedAlignCalls * 4 +
        Math.ceil(totalWords / 35) +
        Math.ceil(maxGateWaitMs / 1000);

      const requiresAsync = estimatedTtsCalls > 1 || estimatedProcessingSec > 45;

      if (asyncParam === false && requiresAsync) {
        return res.status(400).json({
          error:
            estimatedTtsCalls > 1
              ? `This request requires ${estimatedTtsCalls} TTS chunks and must run asynchronously (omit async=false or pass async=true).`
              : `Estimated processing time (${estimatedProcessingSec}s) exceeds the 45s synchronous limit (omit async=false or pass async=true).`,
        });
      }

      const runPipeline = async (
        onProgress?: (progress: TtsJobProgress) => void
      ): Promise<{ entry: CachedTtsEntry; artifactId: string; apiCallsUsed: number }> => {
        const ai = createGenAIClient(apiKey, "v1beta");
        const chunkWavs: Buffer[] = [];
        const chunkSummaries: ChunkSummary[] = [];
        let totalApiCalls = 0;

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          onProgress?.({
            chunk: i + 1,
            of: chunks.length,
            phase: "tts",
            message:
              chunks.length > 1
                ? `Synthesizing chunk ${i + 1} of ${chunks.length}...`
                : "Synthesizing audio...",
          });

          const resChunk = await synthesizeChunkRecursive(
            ai,
            apiKey,
            requestedTtsModel,
            chunk,
            style,
            gapSec,
            (waitSec, modelName) => {
              onProgress?.({
                chunk: i + 1,
                of: chunks.length,
                phase: "pacing",
                message: `Pacing chunk ${i + 1} of ${chunks.length} (${waitSec}s cooldown for ${modelName} RPM/TPM)...`,
              });
            }
          );

          chunkWavs.push(resChunk.wavBuffer);
          chunkSummaries.push({
            index: i,
            chars: chunk.chars,
            durationSec: Number(resChunk.durationSec.toFixed(3)),
            apiCalls: resChunk.apiCalls,
          });
          totalApiCalls += resChunk.apiCalls;
        }

        const {
          wavBuffer,
          segmentTimings: chunkTimings,
          meta,
        } = concatenateWavBuffers(chunkWavs, gapSec);

        // Align captions per chunk & stitch
        let cues: FormattedCaptionCue[] = [];
        let srt = "";
        let vtt = "";
        let anyAiUsed = false;
        let lastAlignModelUsed: string | undefined;

        // Track per-turn timings accurately
        const segmentResults: Array<{
          slot: number;
          voiceName: string;
          startSec: number;
          endSec: number;
          text: string;
        }> = [];

        if (includeCaptions) {
          const allChunkCues: FormattedCaptionCue[] = [];

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkWav = chunkWavs[i];
            const chunkTiming = chunkTimings[i];
            let chunkCues: FormattedCaptionCue[];

            if (requestedCaptionMode === "acoustic") {
              chunkCues = buildAcousticCuesForTurns(chunk.turns, chunkWav, distinctVoiceCount > 1);
            } else if (requestedCaptionMode === "auto") {
              onProgress?.({
                chunk: i + 1,
                of: chunks.length,
                phase: "captions",
                message: `Checking acoustic captions for chunk ${i + 1} of ${chunks.length}...`,
              });
              const acoustic = buildAcousticCuesForTurns(
                chunk.turns,
                chunkWav,
                distinctVoiceCount > 1
              );
              const check = evaluateCaptionCheck(acoustic, chunkWav);
              if (check.passed) {
                chunkCues = acoustic;
              } else {
                onProgress?.({
                  chunk: i + 1,
                  of: chunks.length,
                  phase: "captions",
                  message: `Aligning captions with AI for chunk ${i + 1} of ${chunks.length}...`,
                });
                const aiAligned = await alignChunkWithGemini(
                  ai,
                  chunkWav,
                  chunk.turns,
                  chunkTiming.durationSec,
                  requestedAlignModel,
                  (waitSec, modelName) => {
                    onProgress?.({
                      chunk: i + 1,
                      of: chunks.length,
                      phase: "pacing",
                      message: `Pacing caption alignment (${waitSec}s cooldown for ${modelName})...`,
                    });
                  }
                );
                chunkCues = aiAligned.cues;
                chunkSummaries[i].apiCalls += aiAligned.apiCalls;
                totalApiCalls += aiAligned.apiCalls;
                if (aiAligned.apiCalls > 0) anyAiUsed = true;
                if (aiAligned.modelUsed) lastAlignModelUsed = aiAligned.modelUsed;
              }
            } else {
              // "ai"
              onProgress?.({
                chunk: i + 1,
                of: chunks.length,
                phase: "captions",
                message: `Aligning captions with AI for chunk ${i + 1} of ${chunks.length}...`,
              });
              const aiAligned = await alignChunkWithGemini(
                ai,
                chunkWav,
                chunk.turns,
                chunkTiming.durationSec,
                requestedAlignModel,
                (waitSec, modelName) => {
                  onProgress?.({
                    chunk: i + 1,
                    of: chunks.length,
                    phase: "pacing",
                    message: `Pacing caption alignment (${waitSec}s cooldown for ${modelName})...`,
                  });
                }
              );
              chunkCues = aiAligned.cues;
              chunkSummaries[i].apiCalls += aiAligned.apiCalls;
              totalApiCalls += aiAligned.apiCalls;
              if (aiAligned.apiCalls > 0) anyAiUsed = true;
              if (aiAligned.modelUsed) lastAlignModelUsed = aiAligned.modelUsed;
            }

            // Build offset cues & extract per-turn segment intervals
            let cueCursor = 0;
            for (const turn of chunk.turns) {
              const turnCueCount = splitTranscriptIntoCueTexts(turn.text, 78).length;
              const turnCues = chunkCues.slice(cueCursor, cueCursor + turnCueCount);
              cueCursor += turnCueCount;
              const segStart =
                turnCues.length > 0
                  ? turnCues[0].startSec + chunkTiming.startSec
                  : chunkTiming.startSec;
              const segEnd =
                turnCues.length > 0
                  ? turnCues[turnCues.length - 1].endSec + chunkTiming.startSec
                  : chunkTiming.endSec;
              segmentResults.push({
                slot: turn.slot,
                voiceName: turn.voiceName,
                startSec: Number(segStart.toFixed(3)),
                endSec: Number(segEnd.toFixed(3)),
                text: turn.text,
              });
            }

            for (const c of chunkCues) {
              allChunkCues.push({
                ...c,
                startSec: Number((c.startSec + chunkTiming.startSec).toFixed(3)),
                endSec: Number((c.endSec + chunkTiming.startSec).toFixed(3)),
              });
            }
          }

          cues = allChunkCues.map((c, idx) => ({
            ...c,
            index: idx + 1,
          }));
          srt = serializeSrt(cues);
          vtt = serializeVtt(cues);
        } else {
          // Captions disabled: still return accurate per-turn segments estimated by word count inside chunkTimings
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkTiming = chunkTimings[i];
            const totalChunkWords = Math.max(
              1,
              chunk.turns.reduce((sum, t) => sum + t.text.split(/\s+/).filter(Boolean).length, 0)
            );
            let cursor = chunkTiming.startSec;
            chunk.turns.forEach((turn, idx) => {
              const w = turn.text.split(/\s+/).filter(Boolean).length;
              const end =
                idx === chunk.turns.length - 1
                  ? chunkTiming.endSec
                  : cursor + (w / totalChunkWords) * chunkTiming.durationSec;
              segmentResults.push({
                slot: turn.slot,
                voiceName: turn.voiceName,
                startSec: Number(cursor.toFixed(3)),
                endSec: Number(end.toFixed(3)),
                text: turn.text,
              });
              cursor = end;
            });
          }
        }

        const captionCheck: CaptionCheck = includeCaptions
          ? evaluateCaptionCheck(cues, wavBuffer)
          : { sentenceEnds: 0, inPauses: 0, passed: true };

        const resolvedCaptionMode: CaptionMode = anyAiUsed
          ? "ai"
          : requestedCaptionMode === "ai"
          ? "ai"
          : "acoustic";

        const uniqueVoicesUsed: Array<{ slot: number; voiceName: string }> = [];
        const seenSlots = new Set<number>();
        for (const turn of coalescedTurns) {
          if (!seenSlots.has(turn.slot)) {
            seenSlots.add(turn.slot);
            uniqueVoicesUsed.push({ slot: turn.slot, voiceName: turn.voiceName });
          }
        }

        const uniqueVoiceNames = Array.from(new Set(coalescedTurns.map((t) => t.voiceName)));
        const resolvedVoiceSummary =
          uniqueVoiceNames.length > 1 ? uniqueVoiceNames.join(" + ") : uniqueVoiceNames[0] || voiceName;
        const artifactFilePrefix =
          uniqueVoiceNames.length > 1 ? "multi-voice" : resolvedVoiceSummary;

        const artifactId = `tts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        generatedArtifacts.set(artifactId, {
          wav: wavBuffer,
          srt,
          vtt,
          voiceName: artifactFilePrefix,
        });

        const cacheEntry: CachedTtsEntry = {
          wavBuffer,
          srt,
          vtt,
          durationSec: meta.durationSec,
          sampleRate: meta.sampleRate,
          voiceName: resolvedVoiceSummary,
          artifactFilePrefix,
          voicesUsed: uniqueVoicesUsed,
          voiceMap: voiceSlotMap,
          segments: segmentResults,
          model: effectiveTtsModelLabel,
          includeCaptions,
          captionMode: resolvedCaptionMode,
          ...(lastAlignModelUsed ? { alignModel: lastAlignModelUsed } : {}),
          captionCheck,
          chunks: chunkSummaries,
          cues,
        };

        ttsResponseCache.set(cacheKey, cacheEntry);
        return { entry: cacheEntry, artifactId, apiCallsUsed: totalApiCalls };
      };

      const useAsync = asyncParam === true || (asyncParam === undefined && requiresAsync);

      if (useAsync) {
        const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const job: TtsJobRecord = {
          jobId,
          status: "queued",
          progress: {
            chunk: 0,
            of: chunks.length,
            phase: "queued",
            message: `Queued ${chunks.length} chunk${chunks.length > 1 ? "s" : ""}...`,
          },
          createdAtMs: Date.now(),
        };
        ttsJobs.set(jobId, job);

        // Execute asynchronously in the background
        void (async () => {
          job.status = "running";
          try {
            const { entry, artifactId, apiCallsUsed } = await runPipeline((progress) => {
              job.progress = progress;
            });
            job.status = "done";
            job.artifactId = artifactId;
            job.progress = {
              chunk: chunks.length,
              of: chunks.length,
              phase: "done",
              message: "Completed",
            };
            job.result = buildArtifactResponse(entry, artifactId, omitBase64, apiCallsUsed, false);
          } catch (err: any) {
            console.error(`[Backend] Async TTS job ${jobId} failed:`, err);
            job.status = "failed";
            job.error = err?.message || "Failed to generate audio and captions.";
            if (err instanceof RateLimitHttpError) {
              job.retryAfterSec = err.retryAfterSec;
            }
          }
        })();

        return res.status(202).json({
          jobId,
          statusUrl: `/api/tts/jobs/${jobId}`,
        });
      }

      // Synchronous execution (1 TTS call and estimated <= 45s)
      const { entry, artifactId, apiCallsUsed } = await runPipeline();
      return sendFormattedArtifact(
        res,
        outputFormat,
        entry,
        artifactId,
        omitBase64,
        apiCallsUsed,
        false
      );
    } catch (error: any) {
      console.error("[Backend] /api/tts/generate error:", error);
      if (error instanceof RateLimitHttpError) {
        res.setHeader("Retry-After", String(error.retryAfterSec));
        return res.status(429).json({
          error: error.message,
          retryAfterSec: error.retryAfterSec,
        });
      }
      const status = error?.status || 500;
      return res.status(status >= 400 && status < 600 ? status : 500).json({
        error: error?.message || "Failed to generate audio and captions.",
      });
    }
  });

  app.post("/api/generate-content", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error:
            "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const ai = createGenAIClient(apiKey);
      const modelName = resolveModel(req.body?.model);
      const params = { ...req.body, model: modelName };
      const response = await modelRateGate.execute(modelName, 800, () =>
        ai.models.generateContent(params)
      );
      return res.json(serializeGenerateContentResponse(response));
    } catch (error: any) {
      console.error("[Backend] /api/generate-content error:", error);
      if (error instanceof RateLimitHttpError) {
        res.setHeader("Retry-After", String(error.retryAfterSec));
        return res.status(429).json({
          error: error.message,
          retryAfterSec: error.retryAfterSec,
        });
      }
      return res.status(500).json({ error: error.message || "Failed to generate content." });
    }
  });

  app.post("/api/generate-content-stream", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error:
            "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const ai = createGenAIClient(apiKey);
      const params = { ...req.body, model: resolveModel(req.body?.model) };
      const stream = await ai.models.generateContentStream(params);
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      for await (const chunk of stream) {
        res.write(JSON.stringify(serializeGenerateContentResponse(chunk)) + "\n");
      }
      res.end();
    } catch (error: any) {
      console.error("[Backend] /api/generate-content-stream error:", error);
      if (!res.headersSent) {
        return res.status(500).json({ error: error.message || "Failed to stream content." });
      }
      res.end();
    }
  });

  app.post("/api/chat-message", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error:
            "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const { sessionId, model, config, history, message, msgConfig } = req.body || {};
      const ai = createGenAIClient(apiKey);
      const chatKey = sessionId ? `${getClientKey(req)}:${String(sessionId).slice(0, 128)}` : "";
      let chat = chatKey ? chats.get(chatKey) : undefined;
      if (!chat) {
        chat = ai.chats.create({
          model: resolveModel(model),
          config,
          history,
        });
        if (chatKey) chats.set(chatKey, chat);
      }
      const response = await chat.sendMessage({ message, config: msgConfig });
      return res.json(serializeGenerateContentResponse(response));
    } catch (error: any) {
      console.error("[Backend] /api/chat-message error:", error);
      return res.status(500).json({ error: error.message || "Failed to send chat message." });
    }
  });

  app.post("/api/chat-stream", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error:
            "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const { sessionId, model, config, history, message, msgConfig } = req.body || {};
      const ai = createGenAIClient(apiKey);
      const chatKey = sessionId ? `${getClientKey(req)}:${String(sessionId).slice(0, 128)}` : "";
      let chat = chatKey ? chats.get(chatKey) : undefined;
      if (!chat) {
        chat = ai.chats.create({
          model: resolveModel(model),
          config,
          history,
        });
        if (chatKey) chats.set(chatKey, chat);
      }
      const stream = await chat.sendMessageStream({ message, config: msgConfig });
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      for await (const chunk of stream) {
        res.write(JSON.stringify(serializeGenerateContentResponse(chunk)) + "\n");
      }
      res.end();
    } catch (error: any) {
      console.error("[Backend] /api/chat-stream error:", error);
      if (!res.headersSent) {
        return res.status(500).json({ error: error.message || "Failed to stream chat message." });
      }
      res.end();
    }
  });

  app.post("/api/generate-images", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error:
            "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const ai = createGenAIClient(apiKey);
      const response = await ai.models.generateImages({
        ...req.body,
        model: resolveModel(req.body?.model || "imagen-3.0-generate-002"),
      });
      return res.json(response);
    } catch (error: any) {
      console.error("[Backend] /api/generate-images error:", error);
      return res.status(500).json({ error: error.message || "Failed to generate images." });
    }
  });

  app.post("/api/generate-videos", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error:
            "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const ai = createGenAIClient(apiKey);
      const body = { ...req.body };
      delete body.video;
      delete body.source;
      body.model = resolveModel(body.model || "veo-3.1-fast-generate-preview");
      const op = await ai.models.generateVideos(body);
      if (op.name) {
        videoOps.set(op.name, { op, ownerKey: getClientKey(req) });
      }
      return res.json({
        name: op.name,
        done: op.done,
        metadata: op.metadata,
        error: op.error,
        response: op.response,
      });
    } catch (error: any) {
      console.error("[Backend] /api/generate-videos error:", error);
      return res.status(500).json({ error: error.message || "Failed to start video generation." });
    }
  });

  app.post("/api/videos-operation", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error:
            "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const ai = createGenAIClient(apiKey);
      const opName = req.body?.operation?.name;
      const storedOp = opName ? videoOps.get(opName) : undefined;
      if (!storedOp) {
        return res.status(404).json({ error: "Video operation not found on server." });
      }
      const op = await ai.operations.getVideosOperation({ operation: storedOp.op });
      if (op.name) {
        videoOps.set(op.name, { op, ownerKey: getClientKey(req) });
      }
      const responseCopy = op.response ? JSON.parse(JSON.stringify(op.response)) : undefined;
      if (op.done && responseCopy?.generatedVideos) {
        for (const gv of responseCopy.generatedVideos) {
          if (gv.video?.uri) {
            const b64 = Buffer.from(gv.video.uri, "utf-8").toString("base64url");
            gv.video.uri = `/api/video-download?b64=${b64}`;
          }
        }
      }
      return res.json({
        name: op.name,
        done: op.done,
        metadata: op.metadata,
        error: op.error,
        response: responseCopy,
      });
    } catch (error: any) {
      console.error("[Backend] /api/videos-operation error:", error);
      return res.status(500).json({ error: error.message || "Failed to poll video operation." });
    }
  });

  app.get("/api/video-download", (_req, res) => {
    res.status(404).json({ error: "Video download is not enabled for this applet." });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(["/server.cjs", "/server.cjs.map"], (_req: any, res: any) => res.status(404).end());
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Backend] Server running on http://localhost:${PORT}`);
  });
}

startServer();
