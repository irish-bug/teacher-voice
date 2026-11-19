/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface WavMetadata {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
  durationSec: number;
}

export interface SpeechInterval {
  startSec: number;
  endSec: number;
}

export interface RawCaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface FormattedCaptionCue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  speakerSlot?: number;
  voiceName?: string;
  speakerEstimated?: boolean;
}

export interface CaptionCheck {
  sentenceEnds: number;
  inPauses: number;
  passed: boolean;
}

export interface SilencePause {
  startSec: number;
  endSec: number;
  durationSec: number;
  midpointSec: number;
}

export interface TranscriptSegment {
  slot: number;
  text: string;
}

export interface ResolvedTurn {
  slot: number;
  voiceName: string;
  text: string;
}

export interface SynthesisChunk {
  index: number;
  turns: ResolvedTurn[];
  distinctVoices: string[];
  chars: number;
}

export const DEFAULT_VOICE_SLOT_MAP: Record<string, string> = {
  '1': 'Achernar',
  '2': 'Sadaltager',
  '3': 'Erinome',
  '4': 'Charon',
  '5': 'Autonoe',
};

export function parseTranscriptSegments(
  transcript: string,
  defaultSlot: number = 1
): TranscriptSegment[] {
  const clean = transcript.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const matches = Array.from(clean.matchAll(/\[([1-9]\d*)\]/g));
  if (matches.length === 0) {
    return [{ slot: defaultSlot, text: clean }];
  }

  const segments: TranscriptSegment[] = [];
  const firstIdx = matches[0].index ?? 0;
  if (firstIdx > 0) {
    const leadingText = clean.slice(0, firstIdx).trim();
    if (leadingText) {
      segments.push({ slot: defaultSlot, text: leadingText });
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const slot = Number(match[1]) || defaultSlot;
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = i + 1 < matches.length ? (matches[i + 1].index ?? clean.length) : clean.length;
    const text = clean.slice(contentStart, contentEnd).trim();
    if (text) {
      segments.push({ slot, text });
    }
  }

  return segments;
}

export interface ParsedBrief {
  audioProfile: string;
  scene: string;
  directorsNotes: string;
  sampleContext: string;
  transcript: string;
}

export function parseMarkdownBrief(rawText: string): ParsedBrief {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();

  const extractSection = (headingPattern: RegExp): string => {
    const match = normalized.match(headingPattern);
    if (!match || match.index === undefined) return '';
    const start = match.index + match[0].length;
    const rest = normalized.slice(start);
    const nextHeading = rest.search(/\n##\s+/);
    const content = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    return content.trim();
  };

  const audioProfile = extractSection(/##\s*Audio Profile\s*\n/i);
  const scene = extractSection(/##\s*Scene\s*\n/i);
  const directorsNotes = extractSection(/##\s*Director'?s Notes\s*\n/i);
  const sampleContext = extractSection(/##\s*Sample Context\s*\n/i);
  let transcript = extractSection(/##\s*Transcript\s*\n/i);

  if (!audioProfile && !scene && !directorsNotes && !sampleContext && !transcript) {
    transcript = normalized;
  }

  if (transcript.startsWith('"') && transcript.endsWith('"') && transcript.length > 2) {
    transcript = transcript.slice(1, -1).trim();
  } else if (transcript.startsWith('"') && !transcript.slice(1).includes('"')) {
    transcript = transcript.slice(1).trim();
  }

  return {
    audioProfile,
    scene,
    directorsNotes,
    sampleContext,
    transcript,
  };
}

export function ensureWavBuffer(rawBuffer: Buffer, mimeType?: string): Buffer {
  if (
    rawBuffer.length >= 44 &&
    rawBuffer.toString('ascii', 0, 4) === 'RIFF' &&
    rawBuffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return rawBuffer;
  }

  // Wrap headerless 24kHz mono 16-bit PCM into a RIFF WAV container
  let sampleRate = 24000;
  const rateMatch = mimeType?.match(/rate=(\d+)/i);
  if (rateMatch) {
    sampleRate = Number(rateMatch[1]) || 24000;
  }
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = rawBuffer.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, rawBuffer]);
}

export function parseWavMetadata(wavBuffer: Buffer): WavMetadata {
  if (wavBuffer.length < 44 || wavBuffer.toString('ascii', 0, 4) !== 'RIFF') {
    const sampleRate = 24000;
    const dataSize = wavBuffer.length;
    return {
      sampleRate,
      numChannels: 1,
      bitsPerSample: 16,
      dataOffset: 0,
      dataSize,
      durationSec: dataSize / (sampleRate * 2),
    };
  }

  let sampleRate = 24000;
  let numChannels = 1;
  let bitsPerSample = 16;
  let dataOffset = 44;
  let dataSize = Math.max(0, wavBuffer.length - 44);

  let offset = 12;
  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;

    if (chunkId === 'fmt ' && payloadOffset + 16 <= wavBuffer.length) {
      numChannels = wavBuffer.readUInt16LE(payloadOffset + 2) || 1;
      sampleRate = wavBuffer.readUInt32LE(payloadOffset + 4) || 24000;
      bitsPerSample = wavBuffer.readUInt16LE(payloadOffset + 14) || 16;
    } else if (chunkId === 'data') {
      dataOffset = payloadOffset;
      dataSize = Math.min(chunkSize, wavBuffer.length - payloadOffset);
      break;
    }

    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }

  const bytesPerSecond = sampleRate * numChannels * (bitsPerSample / 8);
  const durationSec = bytesPerSecond > 0 ? dataSize / bytesPerSecond : 0;

  return {
    sampleRate,
    numChannels,
    bitsPerSample,
    dataOffset,
    dataSize,
    durationSec,
  };
}

export function concatenateWavBuffers(
  wavBuffers: Buffer[],
  gapSec: number = 0.22
): {
  wavBuffer: Buffer;
  segmentTimings: Array<{ startSec: number; endSec: number; durationSec: number }>;
  meta: WavMetadata;
} {
  if (wavBuffers.length === 0) {
    throw new Error('Cannot concatenate empty WAV buffer list.');
  }
  if (wavBuffers.length === 1) {
    const meta = parseWavMetadata(wavBuffers[0]);
    return {
      wavBuffer: wavBuffers[0],
      segmentTimings: [{ startSec: 0, endSec: meta.durationSec, durationSec: meta.durationSec }],
      meta,
    };
  }

  const firstMeta = parseWavMetadata(wavBuffers[0]);
  const sampleRate = firstMeta.sampleRate || 24000;
  const numChannels = firstMeta.numChannels || 1;
  const bitsPerSample = firstMeta.bitsPerSample || 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  // Align silence gap to frame boundary
  const gapFrames = Math.max(0, Math.round(sampleRate * gapSec));
  const gapBuffer = gapFrames > 0 ? Buffer.alloc(gapFrames * blockAlign) : Buffer.alloc(0);

  const pcmParts: Buffer[] = [];
  const segmentTimings: Array<{ startSec: number; endSec: number; durationSec: number }> = [];
  let cursorBytes = 0;

  for (let i = 0; i < wavBuffers.length; i++) {
    const buf = wavBuffers[i];
    const meta = parseWavMetadata(buf);
    const pcmSlice = buf.subarray(meta.dataOffset, meta.dataOffset + meta.dataSize);
    const startSec = byteRate > 0 ? cursorBytes / byteRate : 0;
    const durationSec = byteRate > 0 ? pcmSlice.length / byteRate : meta.durationSec;
    const endSec = startSec + durationSec;

    segmentTimings.push({ startSec, endSec, durationSec });
    pcmParts.push(pcmSlice);
    cursorBytes += pcmSlice.length;

    if (i < wavBuffers.length - 1 && gapBuffer.length > 0) {
      pcmParts.push(gapBuffer);
      cursorBytes += gapBuffer.length;
    }
  }

  const combinedPcm = Buffer.concat(pcmParts);
  const dataSize = combinedPcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  const wavBuffer = Buffer.concat([header, combinedPcm]);
  return {
    wavBuffer,
    segmentTimings,
    meta: parseWavMetadata(wavBuffer),
  };
}

export function splitLongTextAtSentences(text: string, maxChars: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const sentences = clean
    .split(/(?<=[.!?]["”']?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      const words = sentence.split(' ');
      let wChunk = '';
      for (const word of words) {
        const next = wChunk ? `${wChunk} ${word}` : word;
        if (next.length > maxChars && wChunk) {
          chunks.push(wChunk);
          wChunk = word;
        } else {
          wChunk = next;
        }
      }
      if (wChunk) chunks.push(wChunk);
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function coalesceAndChunkSegments(
  rawSegments: TranscriptSegment[],
  voiceSlotMap: Record<string, string>,
  fallbackVoice: string,
  maxCharsPerCall: number = 3000
): {
  coalescedTurns: ResolvedTurn[];
  chunks: SynthesisChunk[];
  distinctVoiceCount: number;
} {
  const coalescedTurns: ResolvedTurn[] = [];
  for (const seg of rawSegments) {
    const clean = seg.text.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const voiceName =
      voiceSlotMap[String(seg.slot)] ||
      DEFAULT_VOICE_SLOT_MAP[String(seg.slot)] ||
      fallbackVoice ||
      'Achernar';
    const prev = coalescedTurns[coalescedTurns.length - 1];
    if (prev && prev.slot === seg.slot && prev.voiceName === voiceName) {
      prev.text = `${prev.text} ${clean}`;
    } else {
      coalescedTurns.push({ slot: seg.slot, voiceName, text: clean });
    }
  }

  if (coalescedTurns.length === 0) {
    return { coalescedTurns: [], chunks: [], distinctVoiceCount: 0 };
  }

  const distinctVoices = Array.from(new Set(coalescedTurns.map((t) => t.voiceName)));
  const distinctVoiceCount = distinctVoices.length;
  const chunks: SynthesisChunk[] = [];

  if (distinctVoiceCount === 1) {
    const combinedText = coalescedTurns.map((t) => t.text).join(' ');
    const firstTurn = coalescedTurns[0];
    const parts = splitLongTextAtSentences(combinedText, maxCharsPerCall);
    parts.forEach((partText, idx) => {
      chunks.push({
        index: idx,
        turns: [{ slot: firstTurn.slot, voiceName: firstTurn.voiceName, text: partText }],
        distinctVoices: [firstTurn.voiceName],
        chars: partText.length,
      });
    });
  } else if (distinctVoiceCount === 2) {
    // Keep canonical slot-ordered dual voices consistent across all chunks
    const slotByVoice = new Map<string, number>();
    for (const turn of coalescedTurns) {
      if (!slotByVoice.has(turn.voiceName)) {
        slotByVoice.set(turn.voiceName, turn.slot);
      }
    }
    const sortVoicesCanonical = (voices: string[]): string[] =>
      voices.sort((a, b) => (slotByVoice.get(a) ?? 99) - (slotByVoice.get(b) ?? 99));

    // Split long individual turns safely before packing at speaker turn boundaries
    const turnOverhead = 14;
    const safeTurnMax = Math.max(200, maxCharsPerCall - turnOverhead);
    const expandedTurns: ResolvedTurn[] = [];
    for (const turn of coalescedTurns) {
      const subParts = splitLongTextAtSentences(turn.text, safeTurnMax);
      for (const sub of subParts) {
        expandedTurns.push({ slot: turn.slot, voiceName: turn.voiceName, text: sub });
      }
    }

    let currentTurns: ResolvedTurn[] = [];
    let currentChars = 0;

    const flushChunk = () => {
      if (currentTurns.length === 0) return;
      chunks.push({
        index: chunks.length,
        turns: currentTurns,
        distinctVoices: sortVoicesCanonical(
          Array.from(new Set(currentTurns.map((t) => t.voiceName)))
        ),
        chars: currentChars,
      });
      currentTurns = [];
      currentChars = 0;
    };

    for (const turn of expandedTurns) {
      const turnPromptChars = turn.text.length + turnOverhead;
      if (currentTurns.length > 0 && currentChars + turnPromptChars > maxCharsPerCall) {
        flushChunk();
      }
      currentTurns.push(turn);
      currentChars += turnPromptChars;
    }
    flushChunk();
  } else {
    // 3-5 voices: each coalesced speaker turn is synthesized cleanly (split at sentences if > maxCharsPerCall)
    for (const turn of coalescedTurns) {
      const subParts = splitLongTextAtSentences(turn.text, maxCharsPerCall);
      for (const sub of subParts) {
        chunks.push({
          index: chunks.length,
          turns: [{ slot: turn.slot, voiceName: turn.voiceName, text: sub }],
          distinctVoices: [turn.voiceName],
          chars: sub.length,
        });
      }
    }
  }

  return { coalescedTurns, chunks, distinctVoiceCount };
}

export function splitChunkInHalf(chunk: SynthesisChunk): [SynthesisChunk, SynthesisChunk] | null {
  if (chunk.turns.length >= 2) {
    const mid = Math.ceil(chunk.turns.length / 2);
    const left = chunk.turns.slice(0, mid);
    const right = chunk.turns.slice(mid);
    const orderMap = new Map(chunk.distinctVoices.map((v, i) => [v, i]));
    const orderedUnique = (items: ResolvedTurn[]) =>
      Array.from(new Set(items.map((t) => t.voiceName))).sort(
        (a, b) => (orderMap.get(a) ?? 99) - (orderMap.get(b) ?? 99)
      );
    return [
      {
        index: chunk.index,
        turns: left,
        distinctVoices: orderedUnique(left),
        chars: left.reduce((sum, t) => sum + t.text.length, 0),
      },
      {
        index: chunk.index,
        turns: right,
        distinctVoices: orderedUnique(right),
        chars: right.reduce((sum, t) => sum + t.text.length, 0),
      },
    ];
  }

  const singleTurn = chunk.turns[0];
  if (!singleTurn) return null;
  const halfMax = Math.max(120, Math.floor(singleTurn.text.length * 0.55));
  const splitTexts = splitLongTextAtSentences(singleTurn.text, halfMax);
  if (splitTexts.length < 2) {
    // Word midpoint split
    const words = singleTurn.text.split(' ');
    if (words.length < 6) return null;
    const midWord = Math.ceil(words.length / 2);
    const t1 = words.slice(0, midWord).join(' ');
    const t2 = words.slice(midWord).join(' ');
    return [
      {
        index: chunk.index,
        turns: [{ ...singleTurn, text: t1 }],
        distinctVoices: [singleTurn.voiceName],
        chars: t1.length,
      },
      {
        index: chunk.index,
        turns: [{ ...singleTurn, text: t2 }],
        distinctVoices: [singleTurn.voiceName],
        chars: t2.length,
      },
    ];
  }

  const midPart = Math.ceil(splitTexts.length / 2);
  const t1 = splitTexts.slice(0, midPart).join(' ');
  const t2 = splitTexts.slice(midPart).join(' ');
  return [
    {
      index: chunk.index,
      turns: [{ ...singleTurn, text: t1 }],
      distinctVoices: [singleTurn.voiceName],
      chars: t1.length,
    },
    {
      index: chunk.index,
      turns: [{ ...singleTurn, text: t2 }],
      distinctVoices: [singleTurn.voiceName],
      chars: t2.length,
    },
  ];
}

export function detectSilenceMidpoints(wavBuffer: Buffer): {
  meta: WavMetadata;
  speechStartSec: number;
  speechEndSec: number;
  silenceMidpointsSec: number[];
  pauses: SilencePause[];
  speechIntervals: SpeechInterval[];
} {
  const meta = parseWavMetadata(wavBuffer);
  const frameDurationSec = 0.02; // 20ms frames
  const samplesPerFrame = Math.max(1, Math.floor(meta.sampleRate * frameDurationSec));
  const bytesPerSample = Math.max(1, Math.floor(meta.bitsPerSample / 8)) * meta.numChannels;
  const totalSamples = Math.floor(meta.dataSize / bytesPerSample);
  const frameCount = Math.floor(totalSamples / samplesPerFrame);

  if (frameCount <= 0 || meta.bitsPerSample !== 16) {
    return {
      meta,
      speechStartSec: 0,
      speechEndSec: meta.durationSec,
      silenceMidpointsSec: [],
      pauses: [],
      speechIntervals: [{ startSec: 0, endSec: meta.durationSec }],
    };
  }

  const rmsValues: number[] = [];
  for (let f = 0; f < frameCount; f++) {
    let sumSq = 0;
    const baseSample = f * samplesPerFrame;
    for (let s = 0; s < samplesPerFrame; s++) {
      const bytePos = meta.dataOffset + (baseSample + s) * bytesPerSample;
      if (bytePos + 1 >= wavBuffer.length) break;
      const sample = wavBuffer.readInt16LE(bytePos) / 32768;
      sumSq += sample * sample;
    }
    rmsValues.push(Math.sqrt(sumSq / samplesPerFrame));
  }

  const sortedRms = [...rmsValues].sort((a, b) => a - b);
  const p90 = sortedRms[Math.floor(sortedRms.length * 0.9)] || 0.05;
  const p02 = sortedRms[Math.floor(sortedRms.length * 0.02)] || 0.001;
  const silenceThreshold = Math.min(
    Math.max(p90 * 0.25, 0.008),
    Math.max(p02 * 2.2, p90 * 0.08, 0.008)
  );

  const isSilent = rmsValues.map((rms) => rms < silenceThreshold);

  let firstActive = isSilent.findIndex((s) => !s);
  if (firstActive === -1) firstActive = 0;
  let lastActive = frameCount - 1;
  while (lastActive > firstActive && isSilent[lastActive]) {
    lastActive--;
  }

  const speechStartSec = Math.max(0, firstActive * frameDurationSec - 0.04);
  const speechEndSec = Math.min(meta.durationSec, (lastActive + 1) * frameDurationSec + 0.08);

  // Find internal silence runs >= 120ms (6 frames)
  const silenceMidpointsSec: number[] = [];
  const pauses: SilencePause[] = [];
  const speechIntervals: SpeechInterval[] = [];
  let intervalStart = speechStartSec;

  let i = firstActive;
  while (i <= lastActive) {
    if (isSilent[i]) {
      const runStart = i;
      while (i <= lastActive && isSilent[i]) i++;
      const runLen = i - runStart;
      if (runLen >= 6) {
        const gapStartSec = runStart * frameDurationSec;
        const gapEndSec = i * frameDurationSec;
        const durationSec = gapEndSec - gapStartSec;
        const midpoint = (gapStartSec + gapEndSec) / 2;
        silenceMidpointsSec.push(midpoint);
        pauses.push({
          startSec: Number(gapStartSec.toFixed(3)),
          endSec: Number(gapEndSec.toFixed(3)),
          durationSec: Number(durationSec.toFixed(3)),
          midpointSec: Number(midpoint.toFixed(3)),
        });
        if (gapStartSec > intervalStart + 0.15) {
          speechIntervals.push({ startSec: intervalStart, endSec: gapStartSec + 0.03 });
          intervalStart = Math.max(gapEndSec - 0.03, midpoint);
        }
      }
    } else {
      i++;
    }
  }

  if (speechEndSec > intervalStart + 0.1) {
    speechIntervals.push({ startSec: intervalStart, endSec: speechEndSec });
  }

  if (speechIntervals.length === 0) {
    speechIntervals.push({ startSec: speechStartSec, endSec: Math.max(speechStartSec + 0.5, speechEndSec) });
  }

  return {
    meta,
    speechStartSec,
    speechEndSec,
    silenceMidpointsSec,
    pauses,
    speechIntervals,
  };
}

export function splitTranscriptIntoCueTexts(transcript: string, maxCueChars = 80): string[] {
  const clean = transcript.replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  // Split into sentences first (preserving abbreviations/quotes reasonably)
  const sentences = clean
    .split(/(?<=[.!?]["”']?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const cues: string[] = [];

  for (const sentence of sentences) {
    if (sentence.length <= maxCueChars) {
      cues.push(sentence);
      continue;
    }

    // Break long sentences at clause punctuation or natural conjunction boundaries
    const words = sentence.split(' ');
    let chunk = '';
    for (let idx = 0; idx < words.length; idx++) {
      const word = words[idx];
      const next = chunk ? `${chunk} ${word}` : word;
      if (next.length > maxCueChars && chunk) {
        cues.push(chunk);
        chunk = word;
      } else {
        chunk = next;
        // Prefer breaking after comma/semicolon once chunk has decent length
        if (/[;,]$/.test(word) && chunk.length >= 34 && idx < words.length - 2) {
          cues.push(chunk);
          chunk = '';
        }
      }
    }
    if (chunk) cues.push(chunk);
  }

  return cues;
}

export interface PreSplitTurnCue {
  cueIndex: number;
  text: string;
  speakerSlot: number;
  voiceName: string;
}

export function buildPreSplitCuesForTurns(
  turns: ResolvedTurn[],
  maxCueChars = 78
): PreSplitTurnCue[] {
  const result: PreSplitTurnCue[] = [];
  for (const turn of turns) {
    const texts = splitTranscriptIntoCueTexts(turn.text, maxCueChars);
    for (const text of texts) {
      result.push({
        cueIndex: result.length,
        text,
        speakerSlot: turn.slot,
        voiceName: turn.voiceName,
      });
    }
  }
  return result;
}

function alignBreaksMonotonically(
  expectedTimes: number[],
  pauses: SilencePause[],
  totalStart: number,
  totalEnd: number
): number[] {
  const K = expectedTimes.length;
  if (K === 0) return [];
  const M = pauses.length;
  const totalSpan = Math.max(1, totalEnd - totalStart);
  const maxWindow = Math.max(2.8, Math.min(8.0, totalSpan * 0.16));

  if (M === 0) {
    return [...expectedTimes];
  }

  // Needleman-Wunsch style DP: rows = breaks (0..K), cols = pauses (0..M)
  const SKIP_BREAK_PENALTY = 3.5;
  const INF = 1e9;
  const dp: number[][] = Array.from({ length: K + 1 }, () => new Array(M + 1).fill(INF));
  const choice: number[][] = Array.from({ length: K + 1 }, () => new Array(M + 1).fill(0));
  // choice: 1 = match (k-1, p-1), 2 = skip break k-1, 3 = skip pause p-1

  for (let p = 0; p <= M; p++) dp[0][p] = 0;
  for (let k = 1; k <= K; k++) {
    dp[k][0] = dp[k - 1][0] + SKIP_BREAK_PENALTY;
    choice[k][0] = 2;
  }

  for (let k = 1; k <= K; k++) {
    const exp = expectedTimes[k - 1];
    for (let p = 1; p <= M; p++) {
      // Option A: skip pause p-1
      let best = dp[k][p - 1];
      let act = 3;

      // Option B: skip break k-1
      const skipBreakCost = dp[k - 1][p] + SKIP_BREAK_PENALTY;
      if (skipBreakCost < best) {
        best = skipBreakCost;
        act = 2;
      }

      // Option C: match break k-1 to pause p-1
      const pause = pauses[p - 1];
      const dist = Math.abs(pause.midpointSec - exp);
      if (dist <= maxWindow && pause.midpointSec > totalStart + 0.3 && pause.midpointSec < totalEnd - 0.3) {
        const matchCost = dist - 1.8 * Math.min(1.2, pause.durationSec);
        const candidate = dp[k - 1][p - 1] + matchCost;
        if (candidate < best) {
          best = candidate;
          act = 1;
        }
      }

      dp[k][p] = best;
      choice[k][p] = act;
    }
  }

  const matched = new Array<number | null>(K).fill(null);
  let k = K;
  let p = M;
  while (k > 0 && p > 0) {
    const act = choice[k][p];
    if (act === 1) {
      matched[k - 1] = pauses[p - 1].midpointSec;
      k--;
      p--;
    } else if (act === 2) {
      k--;
    } else {
      p--;
    }
  }

  // Interpolate any unmatched breaks proportionally between nearest matched anchors
  const resolved = [...expectedTimes];
  for (let i = 0; i < K; i++) {
    if (matched[i] !== null) {
      resolved[i] = matched[i]!;
      continue;
    }
    let leftIdx = i - 1;
    while (leftIdx >= 0 && matched[leftIdx] === null) leftIdx--;
    let rightIdx = i + 1;
    while (rightIdx < K && matched[rightIdx] === null) rightIdx++;

    const leftActual = leftIdx >= 0 ? matched[leftIdx]! : totalStart;
    const rightActual = rightIdx < K ? matched[rightIdx]! : totalEnd;
    const leftExp = leftIdx >= 0 ? expectedTimes[leftIdx] : totalStart;
    const rightExp = rightIdx < K ? expectedTimes[rightIdx] : totalEnd;
    const expSpan = Math.max(0.01, rightExp - leftExp);
    const frac = (expectedTimes[i] - leftExp) / expSpan;
    resolved[i] = leftActual + frac * Math.max(0.25, rightActual - leftActual);
  }

  // Enforce strict monotonicity
  for (let i = 0; i < K; i++) {
    const minAllowed = (i === 0 ? totalStart : resolved[i - 1]) + 0.25;
    const maxAllowed = totalEnd - (K - i) * 0.25;
    resolved[i] = Math.max(minAllowed, Math.min(maxAllowed, resolved[i]));
  }

  return resolved;
}

export function buildAcousticCuesForTurns(
  turns: ResolvedTurn[],
  wavBuffer: Buffer,
  markSpeakerEstimated: boolean
): FormattedCaptionCue[] {
  const analysis = detectSilenceMidpoints(wavBuffer);
  const preSplit = buildPreSplitCuesForTurns(turns, 78);
  if (preSplit.length === 0) return [];

  const totalStart = analysis.speechStartSec;
  const totalEnd = Math.max(totalStart + 0.5, analysis.speechEndSec);
  const longPauses = analysis.pauses.filter((p) => p.durationSec >= 0.25);

  const weights = preSplit.map((c) => {
    const base = Math.max(8, c.text.replace(/\s+/g, '').length);
    const pauseBonus = /[.!?]["”']?$/.test(c.text) ? 7 : /[,;:]$/.test(c.text) ? 3 : 0;
    return base + pauseBonus;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const totalSpan = totalEnd - totalStart;

  // Identify internal cue boundaries that end a sentence
  const sentenceBreakCueIndices: number[] = [];
  const expectedBreakTimes: number[] = [];
  let cumWeight = 0;
  for (let i = 0; i < preSplit.length - 1; i++) {
    cumWeight += weights[i];
    if (/[.!?]["”']?$/.test(preSplit[i].text)) {
      sentenceBreakCueIndices.push(i);
      expectedBreakTimes.push(totalStart + (cumWeight / totalWeight) * totalSpan);
    }
  }

  const anchoredBreakTimes = alignBreaksMonotonically(
    expectedBreakTimes,
    longPauses,
    totalStart,
    totalEnd
  );

  // Build spans partitioned by anchored sentence breaks and allocate intra-sentence cues linearly
  const spans: Array<{ startCue: number; endCue: number; startSec: number; endSec: number }> = [];
  let prevCue = 0;
  let prevSec = totalStart;
  for (let b = 0; b < sentenceBreakCueIndices.length; b++) {
    const endCue = sentenceBreakCueIndices[b];
    const endSec = anchoredBreakTimes[b];
    spans.push({ startCue: prevCue, endCue, startSec: prevSec, endSec });
    prevCue = endCue + 1;
    prevSec = endSec;
  }
  spans.push({ startCue: prevCue, endCue: preSplit.length - 1, startSec: prevSec, endSec: totalEnd });

  const rawCues: Array<RawCaptionCue & { speakerSlot: number; voiceName: string; speakerEstimated?: boolean }> =
    new Array(preSplit.length);

  for (const span of spans) {
    let spanWeight = 0;
    for (let i = span.startCue; i <= span.endCue; i++) spanWeight += weights[i];
    let curSec = span.startSec;
    const secLen = Math.max(0.2, span.endSec - span.startSec);
    for (let i = span.startCue; i <= span.endCue; i++) {
      const endSec =
        i === span.endCue
          ? span.endSec
          : curSec + (weights[i] / Math.max(1, spanWeight)) * secLen;
      const item = preSplit[i];
      rawCues[i] = {
        startSec: curSec,
        endSec,
        text: item.text,
        speakerSlot: item.speakerSlot,
        voiceName: item.voiceName,
        ...(markSpeakerEstimated ? { speakerEstimated: true } : {}),
      };
      curSec = endSec;
    }
  }

  return refineCuesWithAudio(rawCues, wavBuffer);
}

export function buildFallbackCues(
  transcript: string,
  wavBuffer: Buffer
): FormattedCaptionCue[] {
  return buildAcousticCuesForTurns(
    [{ slot: 1, voiceName: 'Achernar', text: transcript }],
    wavBuffer,
    false
  );
}

export function refineCuesWithAudio(
  rawCues: Array<
    RawCaptionCue & { speakerSlot?: number; voiceName?: string; speakerEstimated?: boolean }
  >,
  wavBuffer: Buffer
): FormattedCaptionCue[] {
  const analysis = detectSilenceMidpoints(wavBuffer);
  const maxDur = Math.max(0.5, analysis.meta.durationSec);
  const longPauses = analysis.pauses.filter((p) => p.durationSec >= 0.25);
  const silences = analysis.silenceMidpointsSec;

  const cleaned = rawCues
    .filter((c) => c && typeof c.text === 'string' && c.text.trim().length > 0)
    .map((c) => ({
      startSec: Math.max(0, Math.min(maxDur, Number(c.startSec) || 0)),
      endSec: Math.max(0, Math.min(maxDur, Number(c.endSec) || 0)),
      text: c.text.replace(/\s+/g, ' ').trim(),
      speakerSlot: c.speakerSlot,
      voiceName: c.voiceName,
      speakerEstimated: c.speakerEstimated,
    }));

  if (cleaned.length === 0) return [];

  // Pass 1: Claim & snap sentence-ending internal boundaries to longPauses (>=0.25s)
  const claimedBoundaries = new Set<number>();
  const claimedPauseMidpoints = new Set<number>();
  for (let i = 0; i < cleaned.length - 1; i++) {
    if (!/[.!?]["”']?$/.test(cleaned[i].text)) continue;
    const boundary = (cleaned[i].endSec + cleaned[i + 1].startSec) / 2;
    let bestDist = 0.75;
    let snapped: number | null = null;
    for (const p of longPauses) {
      if (claimedPauseMidpoints.has(p.midpointSec)) continue;
      const dist = Math.abs(p.midpointSec - boundary);
      if (
        dist < bestDist &&
        p.midpointSec > cleaned[i].startSec + 0.3 &&
        p.midpointSec < cleaned[i + 1].endSec - 0.25
      ) {
        bestDist = dist;
        snapped = p.midpointSec;
      }
    }
    if (snapped !== null) {
      cleaned[i].endSec = Number(snapped.toFixed(3));
      cleaned[i + 1].startSec = Number(snapped.toFixed(3));
      claimedPauseMidpoints.add(snapped);
      claimedBoundaries.add(i);
    }
  }

  // Pass 2: Snap remaining non-sentence internal boundaries only to unclaimed silences
  for (let i = 0; i < cleaned.length - 1; i++) {
    if (claimedBoundaries.has(i)) continue;
    const boundary = (cleaned[i].endSec + cleaned[i + 1].startSec) / 2;
    let bestDist = 0.4;
    let snapped: number | null = null;
    for (const s of silences) {
      if (claimedPauseMidpoints.has(s)) continue;
      const dist = Math.abs(s - boundary);
      if (dist < bestDist && s > cleaned[i].startSec + 0.35 && s < cleaned[i + 1].endSec - 0.25) {
        bestDist = dist;
        snapped = s;
      }
    }
    const resolvedBoundary = snapped ?? Math.max(cleaned[i].startSec + 0.25, boundary);
    cleaned[i].endSec = Number(resolvedBoundary.toFixed(3));
    cleaned[i + 1].startSec = Number(resolvedBoundary.toFixed(3));
  }

  // Ensure monotonic valid intervals
  cleaned[0].startSec = Number(Math.max(0, Math.min(cleaned[0].startSec, analysis.speechStartSec + 0.15)).toFixed(3));
  const lastIdx = cleaned.length - 1;
  cleaned[lastIdx].endSec = Number(
    Math.min(maxDur, Math.max(cleaned[lastIdx].endSec, analysis.speechEndSec)).toFixed(3)
  );

  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i].endSec <= cleaned[i].startSec + 0.2) {
      cleaned[i].endSec = Number(Math.min(maxDur, cleaned[i].startSec + 0.25).toFixed(3));
    }
    if (i > 0 && cleaned[i].startSec < cleaned[i - 1].endSec) {
      cleaned[i].startSec = cleaned[i - 1].endSec;
      if (cleaned[i].endSec <= cleaned[i].startSec + 0.15) {
        cleaned[i].endSec = Number(Math.min(maxDur, cleaned[i].startSec + 0.2).toFixed(3));
      }
    }
  }

  return cleaned.map((cue, idx) => ({
    index: idx + 1,
    startSec: cue.startSec,
    endSec: cue.endSec,
    text: cue.text,
    ...(cue.speakerSlot !== undefined ? { speakerSlot: cue.speakerSlot } : {}),
    ...(cue.voiceName !== undefined ? { voiceName: cue.voiceName } : {}),
    ...(cue.speakerEstimated ? { speakerEstimated: true } : {}),
  }));
}

export function evaluateCaptionCheck(
  cues: FormattedCaptionCue[],
  wavBuffer: Buffer
): CaptionCheck {
  const analysis = detectSilenceMidpoints(wavBuffer);
  const longPauses: SilencePause[] = [
    ...analysis.pauses.filter((p) => p.durationSec >= 0.25),
    // Trailing silence at the end of the recording counts as a final pause for the closing sentence
    {
      startSec: Math.max(0, analysis.speechEndSec - 0.12),
      endSec: Math.max(analysis.speechEndSec + 0.35, analysis.meta.durationSec + 0.25),
      durationSec: 0.4,
      midpointSec: analysis.speechEndSec,
    },
  ];

  const sentenceEndingCues = cues.filter((c) => /[.!?]["”']?$/.test(c.text.trim()));
  if (sentenceEndingCues.length === 0) {
    return { sentenceEnds: 0, inPauses: 0, passed: true };
  }

  let inPauses = 0;
  let pauseIdx = 0;

  for (const cue of sentenceEndingCues) {
    const endSec = cue.endSec;
    while (pauseIdx < longPauses.length && longPauses[pauseIdx].endSec < endSec - 0.2) {
      pauseIdx++;
    }
    for (let j = pauseIdx; j < longPauses.length; j++) {
      const p = longPauses[j];
      if (p.startSec > endSec + 0.25) break;
      if (endSec >= p.startSec - 0.18 && endSec <= p.endSec + 0.18) {
        inPauses++;
        pauseIdx = j + 1;
        break;
      }
    }
  }

  return {
    sentenceEnds: sentenceEndingCues.length,
    inPauses,
    passed: inPauses / sentenceEndingCues.length >= 0.9,
  };
}

function formatSrtTime(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatVttTime(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function wrapCueText(text: string, maxChars = 42): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const words = clean.split(' ');
  const midpoint = Math.ceil(clean.length / 2);
  let bestSplit = -1;
  let bestDist = Infinity;
  let running = 0;
  for (let i = 0; i < words.length - 1; i++) {
    running += (i > 0 ? 1 : 0) + words[i].length;
    const dist = Math.abs(running - midpoint);
    if (dist < bestDist) {
      bestDist = dist;
      bestSplit = i + 1;
    }
  }
  if (bestSplit > 0) {
    return `${words.slice(0, bestSplit).join(' ')}\n${words.slice(bestSplit).join(' ')}`;
  }
  return clean;
}

export function serializeSrt(cues: FormattedCaptionCue[]): string {
  return cues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}\n${wrapCueText(cue.text)}`
    )
    .join('\n\n')
    .concat(cues.length > 0 ? '\n' : '');
}

export function serializeVtt(cues: FormattedCaptionCue[]): string {
  const body = cues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatVttTime(cue.startSec)} --> ${formatVttTime(cue.endSec)}\n${wrapCueText(cue.text)}`
    )
    .join('\n\n');
  return `WEBVTT\n\n${body}${cues.length > 0 ? '\n' : ''}`;
}
