/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

export interface VoiceAnalysis {
  gender: string;
  pitch: string;
  characteristics: string[];
  visualDescription: string;
}

export interface Voice {
  name: string;
  pitch: string;
  characteristics: string[];
  audioSampleUrl: string;
  fileUri: string;
  analysis: VoiceAnalysis;
  imageUrl: string;
}

export interface FilterState {
  gender: string | 'All';
  pitch: string | 'All';
  search: string;
}

export interface AiRecommendation {
  voiceNames: string[];
  systemInstruction: string;
  sampleText: string;
}

export interface VoiceBrief {
  audioProfile: string;
  scene: string;
  directorsNotes: string;
  sampleContext: string;
  transcript: string;
}

export type VoiceMap = Record<string, string>;

export interface TranscriptSegment {
  slot: number;
  text: string;
}

export type CaptionMode = 'acoustic' | 'ai' | 'auto';
export type AlignModel = 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite' | 'auto';

export interface CaptionCheck {
  sentenceEnds: number;
  inPauses: number;
  passed: boolean;
}

export interface ChunkSummary {
  index: number;
  chars: number;
  durationSec: number;
  apiCalls: number;
}

export interface CaptionCue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  speakerSlot?: number;
  voiceName?: string;
  speakerEstimated?: boolean;
}

export interface GeneratedAudioResult {
  id?: string;
  audioBase64: string;
  mimeType: string;
  durationSec: number;
  sampleRate: number;
  voiceName: string;
  model: string;
  voicesUsed?: Array<{ slot: number; voiceName: string }>;
  voiceMap?: VoiceMap;
  apiCallsUsed?: number;
  cached?: boolean;
  captionMode?: CaptionMode;
  alignModel?: string;
  captionCheck?: CaptionCheck;
  chunks?: ChunkSummary[];
  cues: CaptionCue[];
  srt: string;
  vtt: string;
}

export interface TtsJobResponse {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: {
    chunk: number;
    of: number;
    phase?: string;
    message?: string;
  };
  result?: GeneratedAudioResult;
  error?: string;
  retryAfterSec?: number;
}