/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CaptionCue, TranscriptSegment, VoiceBrief, VoiceMap } from './types';

export const EMPTY_VOICE_BRIEF: VoiceBrief = {
  audioProfile: '',
  scene: '',
  directorsNotes: '',
  sampleContext: '',
  transcript: '',
};

export const DEFAULT_LESSON_BRIEF: VoiceBrief = {
  audioProfile:
    'You are an expert educator with a background in clear, patient communication. Your persona is professional yet approachable, characterized by crisp articulation and a steady, calming cadence that invites curiosity and deep learning.',
  scene:
    'A quiet, scholarly environment such as a private study or a high-end recording booth meant for educational content. The atmosphere is serene and distraction-free, perfectly suited for intellectual focus.',
  directorsNotes:
    'Prioritize clarity and enunciation above all else. Use a measured pace to convey patience. Maintain a clear General American accent. Your tone should be authoritative and sophisticated but never harsh, guiding the student with confidence, warmth, and encouragement.',
  sampleContext:
    'The beginning of a foundational lesson where complex ideas are introduced with a focus on accessibility and thoroughness for new students.',
  transcript:
    'There are several terms you may hear in relationship to the type of activity that is conducted by a penetration tester. The difference between them is based on the intent of the individual carrying out the activity and whether the individual was authorized to conduct the activity or not. The first term is White-Hat Hacking. This is basically the same thing as Ethical Hacking. The individual conducting the testing has been authorized to test your systems and the motivation is not malicious but rather to attempt to improve your security posture. The second term is Gray Hat Hacking. In this case the individual who is conducting the activity has not been authorized to conduct the activity but does not have any malicious intent in testing the security. If a vulnerability is discovered, the individual will contact the organization or the vendor of an application with a problem to let them know of the vulnerability. Opinions vary on whether this activity should be encouraged or not since the intent is to not exploit the system or software being tested. The final term is Black Hat hacking. In this case the individual does not have permission to conduct the activity and actually has a malicious intent and intends to exploit any vulnerability that may be discovered. This activity is generally what the media means when they use the term “hacking”.',
};

export const RECOMMENDED_EDUCATOR_VOICES = [
  'Achernar',
  'Sadaltager',
  'Erinome',
  'Charon',
  'Autonoe',
];

export const DEFAULT_MULTI_VOICE_MAP: VoiceMap = {
  '1': 'Achernar',
  '2': 'Sadaltager',
  '3': 'Erinome',
  '4': 'Charon',
  '5': 'Autonoe',
};

const SPEAKER_MARKER_REGEX = /\[([1-9]\d*)\]/g;

export function hasSpeakerMarkers(transcript: string): boolean {
  return /\[[1-9]\d*\]/.test(transcript);
}

export function stripSpeakerMarkers(transcript: string): string {
  return transcript
    .replace(/\s*\[[1-9]\d*\]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseTranscriptSegments(
  transcript: string,
  defaultSlot: number = 1
): TranscriptSegment[] {
  const clean = transcript.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const matches = Array.from(clean.matchAll(SPEAKER_MARKER_REGEX));
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

export const DEFAULT_MAX_CHARS_PER_CALL = 3000;

export function coalesceTranscriptSegments(
  segments: TranscriptSegment[],
  voiceMap: VoiceMap
): Array<TranscriptSegment & { voiceName: string }> {
  const mapped: Array<TranscriptSegment & { voiceName: string }> = [];
  for (const seg of segments) {
    const clean = seg.text.trim();
    if (!clean) continue;
    const voiceName = voiceMap[String(seg.slot)] || DEFAULT_MULTI_VOICE_MAP[String(seg.slot)] || 'Achernar';
    const prev = mapped[mapped.length - 1];
    if (prev && prev.slot === seg.slot && prev.voiceName === voiceName) {
      prev.text = `${prev.text} ${clean}`;
    } else {
      mapped.push({ slot: seg.slot, voiceName, text: clean });
    }
  }
  return mapped;
}

function splitLongTextAtSentences(text: string, maxChars: number): string[] {
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
      // Split oversized sentence at words
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

export function estimatePreFlightPlan(params: {
  transcript: string;
  voiceMap: VoiceMap;
  captionMode: 'acoustic' | 'ai' | 'auto';
  maxCharsPerCall?: number;
}): {
  distinctVoiceCount: number;
  chunkCount: number;
  ttsCalls: number;
  maxCaptionCalls: number;
  totalCalls: number;
  estimatedSec: number;
  isAsyncLikely: boolean;
} {
  const maxChars = params.maxCharsPerCall || DEFAULT_MAX_CHARS_PER_CALL;
  const rawSegments = parseTranscriptSegments(params.transcript, 1);
  const coalesced = coalesceTranscriptSegments(rawSegments, params.voiceMap);
  if (coalesced.length === 0) {
    return {
      distinctVoiceCount: 0,
      chunkCount: 0,
      ttsCalls: 0,
      maxCaptionCalls: 0,
      totalCalls: 0,
      estimatedSec: 0,
      isAsyncLikely: false,
    };
  }

  const distinctVoices = new Set(coalesced.map((s) => s.voiceName));
  const distinctVoiceCount = distinctVoices.size;
  let chunkCount = 0;

  if (distinctVoiceCount === 1) {
    const combined = coalesced.map((s) => s.text).join(' ');
    chunkCount = splitLongTextAtSentences(combined, maxChars).length;
  } else if (distinctVoiceCount === 2) {
    const normalizedTurns: Array<{ voiceName: string; text: string }> = [];
    for (const seg of coalesced) {
      for (const sub of splitLongTextAtSentences(seg.text, maxChars - 24)) {
        normalizedTurns.push({ voiceName: seg.voiceName, text: sub });
      }
    }
    let currentLen = 0;
    for (const turn of normalizedTurns) {
      const lineLen = turn.text.length + 14;
      if (currentLen > 0 && currentLen + lineLen > maxChars) {
        chunkCount++;
        currentLen = lineLen;
      } else {
        currentLen += lineLen + 1;
      }
    }
    if (currentLen > 0) chunkCount++;
  } else {
    for (const seg of coalesced) {
      chunkCount += splitLongTextAtSentences(seg.text, maxChars).length;
    }
  }

  const ttsCalls = chunkCount;
  const maxCaptionCalls =
    params.captionMode === 'acoustic' ? 0 : chunkCount;
  const totalCalls = ttsCalls + maxCaptionCalls;
  const totalWords = stripSpeakerMarkers(params.transcript).split(/\s+/).filter(Boolean).length;
  const estimatedSec = Math.max(4, Math.round(totalWords / 35 + ttsCalls * 4 + maxCaptionCalls * 3));
  const isAsyncLikely = ttsCalls > 1 || estimatedSec > 45;

  return {
    distinctVoiceCount,
    chunkCount,
    ttsCalls,
    maxCaptionCalls,
    totalCalls,
    estimatedSec,
    isAsyncLikely,
  };
}

export function autoSplitTranscriptWithMarkers(
  transcript: string,
  slotCount: number = 3
): string {
  const plain = stripSpeakerMarkers(transcript);
  if (!plain) return '';
  const sentences = plain
    .split(/(?<=[.!?]["”']?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length <= 1) {
    return `[1] ${plain}`;
  }
  const count = Math.max(2, Math.min(5, slotCount, sentences.length));
  const chunkSize = Math.ceil(sentences.length / count);
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const slice = sentences.slice(i * chunkSize, (i + 1) * chunkSize);
    if (slice.length > 0) {
      parts.push(`[${i + 1}] ${slice.join(' ')}`);
    }
  }
  return parts.join('\n\n');
}

export function parseMarkdownBrief(rawText: string): VoiceBrief {
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

  // Strip wrapping quote if user pasted `"There are several...` without closing quote or with matching quotes
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

export function formatSrtTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function formatVttTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function formatDisplayTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function wrapCaptionLines(text: string, maxCharsPerLine = 42): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxCharsPerLine) return clean;

  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  if (lines.length <= 2) return lines.join('\n');

  // Rebalance into 2 lines if close enough
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
  return lines.join('\n');
}

export function buildSrtFromCues(cues: CaptionCue[]): string {
  return cues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(cue.startSec)} --> ${formatSrtTimestamp(cue.endSec)}\n${wrapCaptionLines(cue.text)}`
    )
    .join('\n\n')
    .concat(cues.length > 0 ? '\n' : '');
}

export function buildVttFromCues(cues: CaptionCue[]): string {
  const body = cues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatVttTimestamp(cue.startSec)} --> ${formatVttTimestamp(cue.endSec)}\n${wrapCaptionLines(cue.text)}`
    )
    .join('\n\n');
  return `WEBVTT\n\n${body}${cues.length > 0 ? '\n' : ''}`;
}
