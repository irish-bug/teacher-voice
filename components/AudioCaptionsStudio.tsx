/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Play,
  Pause,
  Download,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  FileText,
  Volume2,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Captions,
  Mic,
  Square,
  Eraser,
  Clock,
  Terminal,
  Users,
  Plus,
  RefreshCw,
} from 'lucide-react';
import {
  Voice,
  VoiceBrief,
  CaptionCue,
  CaptionMode,
  AlignModel,
  GeneratedAudioResult,
  VoiceMap,
} from '../types';
import {
  EMPTY_VOICE_BRIEF,
  DEFAULT_MULTI_VOICE_MAP,
  RECOMMENDED_EDUCATOR_VOICES,
  autoSplitTranscriptWithMarkers,
  hasSpeakerMarkers,
  parseMarkdownBrief,
  parseTranscriptSegments,
  stripSpeakerMarkers,
  buildSrtFromCues,
  buildVttFromCues,
  formatDisplayTime,
  estimatePreFlightPlan,
} from '../presets';
import AudioVisualizer from './AudioVisualizer';

interface AudioCaptionsStudioProps {
  voices: Voice[];
  incomingBrief?: VoiceBrief | null;
  incomingVoiceName?: string | null;
  onConsumeIncoming?: () => void;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

interface StudioTake {
  id: string;
  createdAt: string;
  voiceName: string;
  voiceMode: 'single' | 'multi';
  voiceMap: VoiceMap;
  transcriptPreview: string;
  brief: VoiceBrief;
  result: GeneratedAudioResult;
  cues: CaptionCue[];
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const AudioCaptionsStudio: React.FC<AudioCaptionsStudioProps> = ({
  voices,
  incomingBrief,
  incomingVoiceName,
  onConsumeIncoming,
}) => {
  const [brief, setBrief] = useState<VoiceBrief>(EMPTY_VOICE_BRIEF);
  const [selectedVoiceName, setSelectedVoiceName] = useState<string>('Achernar');
  const [voiceMode, setVoiceMode] = useState<'single' | 'multi'>('single');
  const [voiceMap, setVoiceMap] = useState<VoiceMap>({ ...DEFAULT_MULTI_VOICE_MAP });
  const [visibleSlotCount, setVisibleSlotCount] = useState<number>(3);
  const [ttsModel, setTtsModel] = useState<'gemini-3.8-flash-tts' | 'gemini-3.8-flash-lite-tts'>(
    'gemini-3.8-flash-tts'
  );
  const [captionModeOverride, setCaptionModeOverride] = useState<CaptionMode | null>(null);
  const [alignModel, setAlignModel] = useState<AlignModel>('gemini-4-hydrogen');
  const [showDirectionFields, setShowDirectionFields] = useState<boolean>(true);
  const [showPasteBox, setShowPasteBox] = useState<boolean>(false);
  const [showRestApi, setShowRestApi] = useState<boolean>(false);
  const [pasteInput, setPasteInput] = useState<string>('');

  // Generation state
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedAudioResult | null>(null);
  const [cues, setCues] = useState<CaptionCue[]>([]);
  const [takes, setTakes] = useState<StudioTake[]>([]);
  const [activeTakeId, setActiveTakeId] = useState<string | null>(null);

  // Audio playback state
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [vttUrl, setVttUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [showLiveCaptions, setShowLiveCaptions] = useState<boolean>(true);

  // Sample voice preview state
  const [previewingSlot, setPreviewingSlot] = useState<string | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);

  // Export & Tabs
  const [captionTab, setCaptionTab] = useState<'cues' | 'srt' | 'vtt'>('cues');
  const [copiedType, setCopiedType] = useState<'srt' | 'vtt' | 'curl' | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptRef = useRef<HTMLTextAreaElement | null>(null);
  const activeCueRef = useRef<HTMLDivElement | null>(null);

  const selectedVoice = useMemo(
    () => voices.find((v) => v.name === selectedVoiceName) || voices[0],
    [voices, selectedVoiceName]
  );

  const srtText = useMemo(() => buildSrtFromCues(cues), [cues]);
  const vttText = useMemo(() => buildVttFromCues(cues), [cues]);

  const wordCount = useMemo(() => {
    const clean = stripSpeakerMarkers(brief.transcript);
    return clean ? clean.split(/\s+/).length : 0;
  }, [brief.transcript]);

  const parsedSegments = useMemo(
    () => parseTranscriptSegments(brief.transcript, 1),
    [brief.transcript]
  );

  const transcriptHasMarkers = useMemo(
    () => hasSpeakerMarkers(brief.transcript),
    [brief.transcript]
  );

  const slotSegmentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!transcriptHasMarkers) return counts;
    for (const seg of parsedSegments) {
      const k = String(seg.slot);
      counts[k] = (counts[k] || 0) + 1;
    }
    return counts;
  }, [parsedSegments, transcriptHasMarkers]);

  const activeSlots = useMemo(() => {
    const maxUsedSlot = parsedSegments.reduce((max, s) => Math.max(max, s.slot), 0);
    const count = Math.min(5, Math.max(visibleSlotCount, maxUsedSlot));
    return Array.from({ length: count }, (_, i) => String(i + 1));
  }, [visibleSlotCount, parsedSegments]);

  const effectiveVoiceMap = useMemo(() => {
    if (voiceMode === 'multi' || transcriptHasMarkers) {
      return voiceMap;
    }
    return { ...voiceMap, '1': selectedVoiceName };
  }, [voiceMode, transcriptHasMarkers, voiceMap, selectedVoiceName]);

  const defaultCaptionMode: CaptionMode = useMemo(() => {
    const distinctVoices = new Set(
      parsedSegments.map(
        (s) =>
          effectiveVoiceMap[String(s.slot)] ||
          DEFAULT_MULTI_VOICE_MAP[String(s.slot)] ||
          selectedVoiceName
      )
    );
    return distinctVoices.size <= 1 ? 'acoustic' : 'ai';
  }, [parsedSegments, effectiveVoiceMap, selectedVoiceName]);

  const captionMode: CaptionMode = captionModeOverride ?? defaultCaptionMode;

  const preFlightPlan = useMemo(
    () =>
      estimatePreFlightPlan({
        transcript: brief.transcript,
        voiceMap: effectiveVoiceMap,
        captionMode,
      }),
    [brief.transcript, effectiveVoiceMap, captionMode]
  );

  const curlSnippet = useMemo(() => {
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'http://localhost:3000';
    const isMulti = voiceMode === 'multi' || transcriptHasMarkers;
    const payloadObj: Record<string, any> = isMulti
      ? {
          voiceMap: Object.fromEntries(
            activeSlots.map((slot) => [slot, effectiveVoiceMap[slot] || DEFAULT_MULTI_VOICE_MAP[slot]])
          ),
          model: ttsModel,
          captionMode,
          ...(captionMode !== 'acoustic' ? { alignModel } : {}),
          noCache: false,
          omitBase64: true,
          audioProfile: brief.audioProfile,
          scene: brief.scene,
          directorsNotes: brief.directorsNotes,
          sampleContext: brief.sampleContext,
          transcript: brief.transcript,
        }
      : {
          voiceName: selectedVoiceName,
          model: ttsModel,
          captionMode,
          ...(captionMode !== 'acoustic' ? { alignModel } : {}),
          noCache: false,
          omitBase64: true,
          audioProfile: brief.audioProfile,
          scene: brief.scene,
          directorsNotes: brief.directorsNotes,
          sampleContext: brief.sampleContext,
          transcript: brief.transcript,
        };
    const payload = JSON.stringify(payloadObj, null, 2);
    const escapedPayload = payload.replace(/'/g, "'\\''");
    return `curl -sS -X POST "${origin}/api/tts/generate" \\\n  -H "Content-Type: application/json" \\\n  -H "x-api-key: YOUR_STUDIO_ACCESS_KEY" \\\n  -d '${escapedPayload}'`;
  }, [
    brief,
    selectedVoiceName,
    ttsModel,
    captionMode,
    alignModel,
    voiceMode,
    transcriptHasMarkers,
    activeSlots,
    effectiveVoiceMap,
  ]);

  // Apply incoming brief or voice from AI Casting Director / Voice Library
  useEffect(() => {
    if (incomingBrief || incomingVoiceName) {
      if (incomingBrief) {
        setBrief(incomingBrief);
      }
      if (incomingVoiceName && voices.some((v) => v.name === incomingVoiceName)) {
        setSelectedVoiceName(incomingVoiceName);
        setVoiceMap((prev) => ({ ...prev, '1': incomingVoiceName }));
      }
      onConsumeIncoming?.();
    }
  }, [incomingBrief, incomingVoiceName, voices, onConsumeIncoming]);

  // Manage WAV Blob URL lifecycle
  useEffect(() => {
    if (!result?.audioBase64) {
      setAudioUrl(null);
      return;
    }
    const blob = base64ToBlob(result.audioBase64, result.mimeType || 'audio/wav');
    const url = URL.createObjectURL(blob);
    setAudioUrl(url);
    setDuration(result.durationSec);
    setCurrentTime(0);
    setIsPlaying(false);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [result]);

  // Manage VTT Blob URL lifecycle for native <track>
  useEffect(() => {
    if (!vttText) {
      setVttUrl(null);
      return;
    }
    const blob = new Blob([vttText], { type: 'text/vtt;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    setVttUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [vttText]);

  // Sync playbackRate with audio element
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, audioUrl]);

  // Stop voice sample preview when voice changes or component unmounts
  useEffect(() => {
    return () => {
      if (sampleAudioRef.current) {
        sampleAudioRef.current.pause();
        sampleAudioRef.current.currentTime = 0;
      }
    };
  }, []);

  const handleToggleSamplePreview = (voiceNameToPlay?: string, slotKey: string = 'single') => {
    if (!sampleAudioRef.current) return;
    const targetVoiceObj = voices.find((v) => v.name === (voiceNameToPlay || selectedVoiceName));
    if (!targetVoiceObj) return;

    if (previewingSlot === slotKey) {
      sampleAudioRef.current.pause();
      sampleAudioRef.current.currentTime = 0;
      setPreviewingSlot(null);
    } else {
      sampleAudioRef.current.src = targetVoiceObj.audioSampleUrl;
      sampleAudioRef.current
        .play()
        .then(() => setPreviewingSlot(slotKey))
        .catch(() => setPreviewingSlot(null));
    }
  };

  const handleInsertSpeakerMarker = (slot: string) => {
    const marker = `[${slot}] `;
    const el = transcriptRef.current;
    if (el) {
      const start = el.selectionStart ?? brief.transcript.length;
      const end = el.selectionEnd ?? brief.transcript.length;
      const before = brief.transcript.slice(0, start);
      const after = brief.transcript.slice(end);
      const needsLeadingSpace = before.length > 0 && !/[\s\n]$/.test(before);
      const inserted = `${needsLeadingSpace ? ' ' : ''}${marker}`;
      const nextTranscript = `${before}${inserted}${after}`;
      setBrief((prev) => ({ ...prev, transcript: nextTranscript }));
      requestAnimationFrame(() => {
        el.focus();
        const cursor = start + inserted.length;
        el.setSelectionRange(cursor, cursor);
      });
    } else {
      setBrief((prev) => ({
        ...prev,
        transcript: prev.transcript.trim() ? `${prev.transcript.trim()}\n\n${marker}` : marker,
      }));
    }
  };

  const handleGenerate = useCallback(
    async (options?: {
      noCache?: boolean;
      captionModeOverride?: CaptionMode;
      overrideBrief?: VoiceBrief;
      overrideVoice?: string;
      overrideVoiceMap?: VoiceMap;
    }) => {
      const targetBrief = options?.overrideBrief || brief;
      const targetVoice = options?.overrideVoice || selectedVoiceName;
      const usingMarkers = hasSpeakerMarkers(targetBrief.transcript);
      const targetMode: 'single' | 'multi' =
        voiceMode === 'multi' || usingMarkers ? 'multi' : 'single';
      const targetVoiceMap: VoiceMap =
        options?.overrideVoiceMap ||
        (targetMode === 'multi'
          ? voiceMap
          : { ...voiceMap, '1': targetVoice });
      const targetCaptionMode = options?.captionModeOverride || captionMode;

      if (!targetBrief.transcript.trim()) {
        setError('Please enter a transcript before generating audio.');
        return;
      }

      if (audioRef.current) {
        audioRef.current.pause();
        setIsPlaying(false);
      }
      if (sampleAudioRef.current && previewingSlot) {
        sampleAudioRef.current.pause();
        setPreviewingSlot(null);
      }

      setIsGenerating(true);
      setGenerationStatus('Submitting synthesis request...');
      setError(null);

      try {
        const res = await fetch('/api/tts/generate', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            voiceName: targetVoice,
            voiceMap: targetVoiceMap,
            transcript: targetBrief.transcript,
            audioProfile: targetBrief.audioProfile,
            scene: targetBrief.scene,
            directorsNotes: targetBrief.directorsNotes,
            sampleContext: targetBrief.sampleContext,
            model: ttsModel,
            captionMode: targetCaptionMode,
            alignModel,
            noCache: Boolean(options?.noCache),
            includeCaptions: true,
          }),
        });

        let data = await res.json().catch(() => ({}));

        if (res.status === 429) {
          const waitHint = data.retryAfterSec
            ? ` Retry in ${data.retryAfterSec}s.`
            : '';
          throw new Error((data.error || 'Quota limit reached.') + waitHint);
        }

        if (res.status === 202 && data.statusUrl) {
          setGenerationStatus('Job accepted. Preparing synthesis...');
          let completed = false;
          for (let attempt = 0; attempt < 240; attempt++) {
            await new Promise((r) => setTimeout(r, 1500));
            const jobRes = await fetch(data.statusUrl, { credentials: 'same-origin' });
            const jobData = await jobRes.json().catch(() => ({}));
            if (!jobRes.ok) {
              throw new Error(jobData.error || `Job check failed (${jobRes.status})`);
            }
            if (jobData.progress?.message) {
              setGenerationStatus(jobData.progress.message);
            }
            if (jobData.status === 'done' && jobData.result) {
              data = jobData.result;
              completed = true;
              break;
            }
            if (jobData.status === 'failed') {
              const waitHint = jobData.retryAfterSec
                ? ` Retry in ${jobData.retryAfterSec}s.`
                : '';
              throw new Error((jobData.error || 'Synthesis job failed.') + waitHint);
            }
          }
          if (!completed) {
            throw new Error('Job is still processing on the server. Please check back shortly.');
          }
        } else if (!res.ok) {
          throw new Error(data.error || `Request failed (${res.status})`);
        }

        const generatedCues: CaptionCue[] = Array.isArray(data.cues) ? data.cues : [];
        const takeId = `take_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const preview = stripSpeakerMarkers(targetBrief.transcript);
        const displayVoiceLabel = data.voiceName || targetVoice;
        const newTake: StudioTake = {
          id: takeId,
          createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          voiceName: displayVoiceLabel,
          voiceMode: targetMode,
          voiceMap: { ...targetVoiceMap },
          transcriptPreview: preview.length > 52 ? `${preview.slice(0, 52)}...` : preview,
          brief: { ...targetBrief },
          result: data,
          cues: generatedCues,
        };

        setResult(data);
        setCues(generatedCues);
        setTakes((prev) => [newTake, ...prev]);
        setActiveTakeId(takeId);
      } catch (err: any) {
        setError(err?.message || 'Failed to generate audio and captions.');
      } finally {
        setIsGenerating(false);
        setGenerationStatus(null);
      }
    },
    [brief, selectedVoiceName, voiceMode, voiceMap, ttsModel, captionMode, alignModel, previewingSlot]
  );

  const activeCueIndex = useMemo(() => {
    if (cues.length === 0) return -1;
    const exact = cues.findIndex(
      (c) => currentTime >= c.startSec && currentTime <= c.endSec
    );
    if (exact !== -1) return exact;
    // If between cues, find last cue that already started only if very close
    return -1;
  }, [cues, currentTime]);

  const activeCue = activeCueIndex >= 0 ? cues[activeCueIndex] : null;

  // Keep active cue scrolled into view while playing
  useEffect(() => {
    if (isPlaying && activeCueRef.current) {
      activeCueRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeCueIndex, isPlaying]);

  const handleTogglePlay = () => {
    if (!audioRef.current || !audioUrl) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch((e) => console.error('Audio playback error:', e));
    }
  };

  const handleSeek = (timeSec: number) => {
    if (!audioRef.current) return;
    const clamped = Math.max(0, Math.min(duration || 0, timeSec));
    audioRef.current.currentTime = clamped;
    setCurrentTime(clamped);
  };

  const handleSeekAndPlay = (timeSec: number) => {
    if (!audioRef.current) return;
    const clamped = Math.max(0, Math.min(duration || 0, timeSec));
    audioRef.current.currentTime = clamped;
    setCurrentTime(clamped);
    audioRef.current.play().catch((e) => console.error('Audio playback error:', e));
  };

  const handleUpdateCueText = (index: number, newText: string) => {
    setCues((prev) => {
      const updated = prev.map((cue, idx) => (idx === index ? { ...cue, text: newText } : cue));
      if (activeTakeId) {
        setTakes((prevTakes) =>
          prevTakes.map((t) => (t.id === activeTakeId ? { ...t, cues: updated } : t))
        );
      }
      return updated;
    });
  };

  const handleSelectTake = (take: StudioTake) => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
    setActiveTakeId(take.id);
    setResult(take.result);
    setCues(take.cues);
    setBrief(take.brief);
    setVoiceMode(take.voiceMode);
    setVoiceMap(take.voiceMap);
    if (take.voiceMode === 'single') {
      setSelectedVoiceName(take.voiceName);
    }
  };

  const handleApplyPastedBrief = () => {
    if (!pasteInput.trim()) return;
    const parsed = parseMarkdownBrief(pasteInput);
    setBrief(parsed);
    if (hasSpeakerMarkers(parsed.transcript)) {
      setVoiceMode('multi');
    }
    setShowPasteBox(false);
    setPasteInput('');
  };

  const handleDownloadWav = () => {
    if (!result?.audioBase64) return;
    const blob = base64ToBlob(result.audioBase64, result.mimeType || 'audio/wav');
    const safeVoice = (result.voiceName || selectedVoiceName).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    triggerDownload(blob, `${safeVoice}-lesson-recording.wav`);
  };

  const handleDownloadSrt = () => {
    if (!srtText) return;
    const safeVoice = (result?.voiceName || selectedVoiceName).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    triggerDownload(
      new Blob([srtText], { type: 'application/x-subrip;charset=utf-8' }),
      `${safeVoice}-lesson-captions.srt`
    );
  };

  const handleDownloadVtt = () => {
    if (!vttText) return;
    const safeVoice = (result?.voiceName || selectedVoiceName).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    triggerDownload(
      new Blob([vttText], { type: 'text/vtt;charset=utf-8' }),
      `${safeVoice}-lesson-captions.vtt`
    );
  };

  const handleCopyCaptions = (type: 'srt' | 'vtt') => {
    const content = type === 'srt' ? srtText : vttText;
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopiedType(type);
    setTimeout(() => setCopiedType(null), 2000);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
      <audio
        ref={sampleAudioRef}
        onEnded={() => setPreviewingSlot(null)}
        preload="none"
      />

      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Brief, Voice Casting & Transcript (5 cols) */}
          <section className="lg:col-span-5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 sm:p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-serif font-medium text-zinc-900 dark:text-white tracking-tight">
                  Audio & Captions Studio
                </h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  Configure voice talent, performance direction, and lesson transcript.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setShowRestApi((v) => !v);
                    setShowPasteBox(false);
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    showRestApi
                      ? 'border-zinc-900 dark:border-indigo-500 bg-zinc-900 dark:bg-indigo-600 text-white'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  <Terminal size={13} />
                  <span>REST API</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowPasteBox((v) => !v);
                    setShowRestApi(false);
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    showPasteBox
                      ? 'border-zinc-900 dark:border-indigo-500 bg-zinc-900 dark:bg-indigo-600 text-white'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  <ClipboardPaste size={13} />
                  <span>Paste Brief</span>
                </button>
              </div>
            </div>

            {showRestApi && (
              <div className="p-4 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                      Headless REST API (No GUI required)
                    </p>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                      Pass <code className="font-mono">x-api-key</code> to{' '}
                      <code className="font-mono">GET /api/tts/voices</code>,{' '}
                      <code className="font-mono">POST /api/tts/generate</code> (returns sync{' '}
                      <code className="font-mono">200</code> or async{' '}
                      <code className="font-mono">202</code>{' '}
                      <code className="font-mono">GET /api/tts/jobs/:id</code>), and{' '}
                      <code className="font-mono">GET /api/tts/artifacts/:id.wav</code>.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(curlSnippet);
                      setCopiedType('curl');
                      setTimeout(() => setCopiedType(null), 2000);
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    {copiedType === 'curl' ? (
                      <>
                        <Check size={12} className="text-emerald-600 dark:text-emerald-400" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy size={12} />
                        <span>Copy cURL</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="p-3 rounded-lg bg-zinc-900 text-zinc-100 text-[11px] font-mono overflow-x-auto max-h-48 custom-scrollbar leading-relaxed">
                  {curlSnippet}
                </pre>
              </div>
            )}

            {showPasteBox && (
              <div className="p-4 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 space-y-3">
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Paste structured markdown brief (## Audio Profile, ## Scene, ## Director&apos;s Notes, ## Sample context, ## Transcript)
                </label>
                <textarea
                  value={pasteInput}
                  onChange={(e) => setPasteInput(e.target.value)}
                  rows={5}
                  placeholder="## Audio Profile&#10;...&#10;&#10;## Transcript&#10;..."
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 p-2.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowPasteBox(false)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleApplyPastedBrief}
                    disabled={!pasteInput.trim()}
                    className="px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-indigo-600 text-white text-xs font-medium hover:bg-zinc-800 dark:hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                  >
                    Parse into Fields
                  </button>
                </div>
              </div>
            )}

            {/* Voice Selection */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  Voice Talent
                </span>
                <div className="inline-flex items-center p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                  <button
                    type="button"
                    onClick={() => setVoiceMode('single')}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      voiceMode === 'single'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    Single Voice
                  </button>
                  <button
                    type="button"
                    onClick={() => setVoiceMode('multi')}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      voiceMode === 'multi'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    <Users size={12} />
                    <span>Multi-Voice [1–5]</span>
                  </button>
                </div>
              </div>

              {voiceMode === 'single' ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <select
                        id="studio-voice-select"
                        value={selectedVoiceName}
                        onChange={(e) => {
                          setSelectedVoiceName(e.target.value);
                          if (sampleAudioRef.current && previewingSlot === 'single') {
                            sampleAudioRef.current.pause();
                            setPreviewingSlot(null);
                          }
                        }}
                        className="appearance-none w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 py-2 pl-3 pr-9 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/30 cursor-pointer"
                      >
                        {voices.map((v) => (
                          <option key={v.name} value={v.name}>
                            {v.name} ({v.analysis.gender}, {v.analysis.pitch})
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        size={14}
                        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => handleToggleSamplePreview(selectedVoiceName, 'single')}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors whitespace-nowrap shrink-0"
                      title="Preview dry reference sample for this voice"
                    >
                      {previewingSlot === 'single' ? (
                        <>
                          <Square size={12} className="fill-current" />
                          <span>Stop</span>
                        </>
                      ) : (
                        <>
                          <Volume2 size={13} />
                          <span>Sample</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Quick Educator Picks */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-zinc-400 dark:text-zinc-500 mr-1">
                        Educator picks:
                      </span>
                      {RECOMMENDED_EDUCATOR_VOICES.map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => setSelectedVoiceName(name)}
                          className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                            selectedVoiceName === name
                              ? 'bg-zinc-900 dark:bg-indigo-600 text-white'
                              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                          }`}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>

                  {selectedVoice && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {selectedVoice.analysis.gender} · {selectedVoice.analysis.pitch} ·{' '}
                      {selectedVoice.characteristics.join(', ')}
                    </p>
                  )}

                  {transcriptHasMarkers && (
                    <div className="px-3 py-2 rounded-lg bg-indigo-50/80 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900 flex items-center justify-between gap-2 text-xs text-indigo-900 dark:text-indigo-200">
                      <span>
                        Detected numbered voice markers in transcript (using pre-assigned slots 1–5).
                      </span>
                      <button
                        type="button"
                        onClick={() => setVoiceMode('multi')}
                        className="font-semibold underline shrink-0"
                      >
                        Edit Slots
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-2.5 p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      Put <code className="font-mono text-zinc-800 dark:text-zinc-200">[1]</code>,{' '}
                      <code className="font-mono text-zinc-800 dark:text-zinc-200">[2]</code>,{' '}
                      <code className="font-mono text-zinc-800 dark:text-zinc-200">[3]</code> in the
                      transcript where each voice starts. Click any tag to insert at cursor.
                    </p>
                  </div>

                  <div className="space-y-2">
                    {activeSlots.map((slot) => {
                      const assignedVoice =
                        voiceMap[slot] || DEFAULT_MULTI_VOICE_MAP[slot] || 'Achernar';
                      const partCount = slotSegmentCounts[slot] || 0;
                      const isSlotPlaying = previewingSlot === `slot-${slot}`;
                      return (
                        <div key={slot} className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleInsertSpeakerMarker(slot)}
                            className="px-2.5 py-1.5 rounded-lg bg-zinc-900 dark:bg-indigo-600 text-white font-mono text-xs font-semibold hover:bg-zinc-700 dark:hover:bg-indigo-500 transition-colors shrink-0"
                            title={`Insert [${slot}] at cursor in transcript`}
                          >
                            [{slot}]
                          </button>

                          <div className="relative flex-1 min-w-0">
                            <select
                              value={assignedVoice}
                              onChange={(e) => {
                                const nextVoice = e.target.value;
                                setVoiceMap((prev) => ({ ...prev, [slot]: nextVoice }));
                                if (sampleAudioRef.current && previewingSlot === `slot-${slot}`) {
                                  sampleAudioRef.current.pause();
                                  setPreviewingSlot(null);
                                }
                              }}
                              aria-label={`Voice for speaker slot ${slot}`}
                              className="appearance-none w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 py-1.5 pl-2.5 pr-8 rounded-lg text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/30 cursor-pointer"
                            >
                              {voices.map((v) => (
                                <option key={v.name} value={v.name}>
                                  {v.name} ({v.analysis.gender}, {v.analysis.pitch})
                                </option>
                              ))}
                            </select>
                            <ChevronDown
                              size={13}
                              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400"
                            />
                          </div>

                          <span className="text-[11px] font-mono tabular-nums text-zinc-400 dark:text-zinc-500 w-14 text-right shrink-0">
                            {transcriptHasMarkers
                              ? partCount > 0
                                ? `${partCount} part${partCount > 1 ? 's' : ''}`
                                : 'unused'
                              : slot === '1'
                              ? 'default'
                              : 'ready'}
                          </span>

                          <button
                            type="button"
                            onClick={() =>
                              handleToggleSamplePreview(assignedVoice, `slot-${slot}`)
                            }
                            className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
                            title={`Sample ${assignedVoice}`}
                            aria-label={`Sample ${assignedVoice}`}
                          >
                            {isSlotPlaying ? (
                              <Square size={12} className="fill-current" />
                            ) : (
                              <Volume2 size={13} />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-zinc-200/70 dark:border-zinc-800">
                    <div className="flex items-center gap-2">
                      {activeSlots.length < 5 && (
                        <button
                          type="button"
                          onClick={() => setVisibleSlotCount((c) => Math.min(5, c + 1))}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[11px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          <Plus size={12} />
                          <span>Add Slot [{activeSlots.length + 1}]</span>
                        </button>
                      )}
                      {activeSlots.length > 2 && (
                        <button
                          type="button"
                          onClick={() => setVisibleSlotCount((c) => Math.max(2, c - 1))}
                          className="px-2 py-1 rounded-md text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
                        >
                          Show Fewer
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => setVoiceMap({ ...DEFAULT_MULTI_VOICE_MAP })}
                      className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
                    >
                      Reset 1–5 Presets
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* TTS Model & Captions Mode Switch */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 block">
                  Synthesis Model
                </label>
                <div className="grid grid-cols-2 gap-1.5 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setTtsModel('gemini-3.8-flash-tts')}
                    className={`py-1.5 px-2.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap truncate ${
                      ttsModel === 'gemini-3.8-flash-tts'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    Studio Director (3.8 TTS)
                  </button>
                  <button
                    type="button"
                    onClick={() => setTtsModel('gemini-3.8-flash-lite-tts')}
                    className={`py-1.5 px-2.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap truncate ${
                      ttsModel === 'gemini-3.8-flash-lite-tts'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    Standard Fast (Lite TTS)
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                    Captions Alignment Mode
                  </label>
                  <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500">
                    Default: {defaultCaptionMode === 'acoustic' ? 'Acoustic (1 voice)' : 'AI (2+ voices)'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setCaptionModeOverride('acoustic')}
                    className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap truncate ${
                      captionMode === 'acoustic'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                    title="Zero Gemini API calls using local acoustic silence detection"
                  >
                    Acoustic (0 calls)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCaptionModeOverride('auto')}
                    className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap truncate ${
                      captionMode === 'auto'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                    title="Acoustic first, AI alignment only on chunks that fail the pause check"
                  >
                    Auto Check
                  </button>
                  <button
                    type="button"
                    onClick={() => setCaptionModeOverride('ai')}
                    className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap truncate ${
                      captionMode === 'ai'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                    title="Multimodal AI timing (+1 call per chunk)"
                  >
                    AI Precision
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                    AI Alignment Model
                  </label>
                  <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500">
                    {captionMode === 'acoustic'
                      ? 'Active on Auto / AI / Multi-Voice'
                      : 'Separate RPM/RPD buckets'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setAlignModel('gemini-4-hydrogen')}
                    className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap truncate ${
                      alignModel === 'gemini-4-hydrogen'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                    title="Default balanced multimodal alignment model (gemini-4-hydrogen)"
                  >
                    Gemini 4 Flash
                  </button>
                  <button
                    type="button"
                    onClick={() => setAlignModel('gemini-3.1-flash-lite')}
                    className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap truncate ${
                      alignModel === 'gemini-3.1-flash-lite'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                    title="Lightweight 3.1 Flash Lite alignment model with its own quota pool"
                  >
                    3.1 Flash Lite
                  </button>
                  <button
                    type="button"
                    onClick={() => setAlignModel('auto')}
                    className={`py-1.5 px-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap truncate ${
                      alignModel === 'auto'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                    title="Try Gemini 4 Flash first and fall back to 3.1 Flash Lite on 429"
                  >
                    Auto Fallback
                  </button>
                </div>
              </div>
            </div>

            {/* Collapsible Performance Direction */}
            <div className="border-t border-zinc-100 dark:border-zinc-800 pt-4">
              <button
                type="button"
                onClick={() => setShowDirectionFields((v) => !v)}
                className="w-full flex items-center justify-between text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-colors"
              >
                <span>Performance Direction (Profile, Scene &amp; Director&apos;s Notes)</span>
                {showDirectionFields ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>

              {showDirectionFields && (
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                      Director&apos;s Notes
                    </label>
                    <textarea
                      value={brief.directorsNotes}
                      onChange={(e) =>
                        setBrief((prev) => ({ ...prev, directorsNotes: e.target.value }))
                      }
                      rows={3}
                      placeholder="Optional tone, pacing, accent, or delivery guidance..."
                      className="w-full rounded-lg bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                      Audio Profile
                    </label>
                    <textarea
                      value={brief.audioProfile}
                      onChange={(e) =>
                        setBrief((prev) => ({ ...prev, audioProfile: e.target.value }))
                      }
                      rows={2}
                      placeholder="Optional speaker persona or role..."
                      className="w-full rounded-lg bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                        Scene
                      </label>
                      <textarea
                        value={brief.scene}
                        onChange={(e) =>
                          setBrief((prev) => ({ ...prev, scene: e.target.value }))
                        }
                        rows={2}
                        placeholder="Optional acoustic environment..."
                        className="w-full rounded-lg bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                        Sample Context
                      </label>
                      <textarea
                        value={brief.sampleContext}
                        onChange={(e) =>
                          setBrief((prev) => ({ ...prev, sampleContext: e.target.value }))
                        }
                        rows={2}
                        placeholder="Optional situational context..."
                        className="w-full rounded-lg bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Transcript Input */}
            <div className="border-t border-zinc-100 dark:border-zinc-800 pt-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="studio-transcript"
                  className="text-xs font-semibold text-zinc-700 dark:text-zinc-300"
                >
                  Transcript
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono tabular-nums">
                    {wordCount} words · ~{wordCount > 0 ? Math.max(1, Math.round((wordCount / 140) * 60)) : 0}s
                  </span>
                  {brief.transcript.trim().length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setVoiceMode('multi');
                        setBrief((prev) => ({
                          ...prev,
                          transcript: autoSplitTranscriptWithMarkers(
                            prev.transcript,
                            activeSlots.length
                          ),
                        }));
                      }}
                      className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
                      title="Split current sentences across active numbered voice slots"
                    >
                      Auto-tag [1–{activeSlots.length}]
                    </button>
                  )}
                  {transcriptHasMarkers && (
                    <button
                      type="button"
                      onClick={() =>
                        setBrief((prev) => ({
                          ...prev,
                          transcript: stripSpeakerMarkers(prev.transcript),
                        }))
                      }
                      className="text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
                    >
                      Strip Tags
                    </button>
                  )}
                  {brief.transcript.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setBrief((prev) => ({ ...prev, transcript: '' }))}
                      className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
                      title="Clear transcript to write or paste a new script"
                    >
                      <Eraser size={12} />
                      <span>Clear</span>
                    </button>
                  )}
                </div>
              </div>
              <textarea
                ref={transcriptRef}
                id="studio-transcript"
                value={brief.transcript}
                onChange={(e) =>
                  setBrief((prev) => ({ ...prev, transcript: e.target.value }))
                }
                rows={8}
                placeholder="Enter or paste any new transcript here. Use [1], [2], [3] before sections to assign different voices..."
                className="w-full rounded-xl bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3.5 py-3 text-sm text-zinc-900 dark:text-zinc-100 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            {/* Pre-Flight Budget & Generate CTA */}
            <div className="pt-1 space-y-2.5">
              {brief.transcript.trim().length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-zinc-500 dark:text-zinc-400">
                  <span>
                    {preFlightPlan.ttsCalls} TTS call{preFlightPlan.ttsCalls === 1 ? '' : 's'}
                    {captionMode === 'acoustic'
                      ? ' · Instant acoustic captions'
                      : captionMode === 'auto'
                      ? ` · Auto check (+AI if needed)`
                      : ` + ${preFlightPlan.maxCaptionCalls} AI alignment`}
                    {preFlightPlan.chunkCount > 1 ? ` · ${preFlightPlan.chunkCount} chunks` : ''}
                  </span>
                  <span>
                    ~{preFlightPlan.estimatedSec}s
                    {preFlightPlan.isAsyncLikely ? ' · Async job' : ' · Sync'}
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => handleGenerate()}
                  disabled={isGenerating || !brief.transcript.trim()}
                  className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-zinc-900 dark:bg-indigo-600 hover:bg-zinc-800 dark:hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors whitespace-nowrap"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 size={16} className="animate-spin shrink-0" />
                      <span>Synthesizing...</span>
                    </>
                  ) : (
                    <>
                      <Mic size={16} className="shrink-0" />
                      <span>{result ? 'Regenerate Audio & Captions' : 'Generate Audio & Captions'}</span>
                    </>
                  )}
                </button>

                {result && (
                  <button
                    type="button"
                    onClick={() => handleGenerate({ noCache: true })}
                    disabled={isGenerating || !brief.transcript.trim()}
                    className="inline-flex items-center gap-1.5 py-2.5 px-3.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 text-xs font-medium transition-colors whitespace-nowrap shrink-0"
                    title="Bypass cache and synthesize a fresh take"
                  >
                    <RefreshCw size={14} />
                    <span>New take</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setBrief(EMPTY_VOICE_BRIEF);
                    setCaptionModeOverride(null);
                    setError(null);
                  }}
                  className="p-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors shrink-0"
                  title="Clear all fields"
                  aria-label="Clear all fields"
                >
                  <RotateCcw size={16} />
                </button>
              </div>
            </div>
          </section>

          {/* Right Column: Recorded Audio Player, Live Captions & Downloads (7 cols) */}
          <section className="lg:col-span-7 space-y-6">
            {/* Audio Player & Live Caption Stage */}
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 sm:p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-serif font-medium text-zinc-900 dark:text-white">
                    Recorded Audio &amp; Live Captions
                  </h3>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 space-y-0.5">
                    {result ? (
                      <>
                        <p>
                          {result.voiceName} · {result.model} · {(result.sampleRate / 1000).toFixed(0)} kHz WAV ·{' '}
                          <span className="font-mono tabular-nums">{cues.length}</span> cues ·{' '}
                          <span className="font-mono tabular-nums">
                            {result.cached
                              ? 'Cached (0 calls)'
                              : `${result.apiCallsUsed ?? 1} API call${(result.apiCallsUsed ?? 1) === 1 ? '' : 's'}`}
                          </span>
                        </p>
                        {result.captionCheck && result.captionCheck.sentenceEnds > 0 && (
                          <p className="text-[11px] font-mono tabular-nums text-zinc-500 dark:text-zinc-400 flex flex-wrap items-center gap-2">
                            <span>
                              Captions: {result.captionMode || 'acoustic'}
                              {result.alignModel ? ` (${result.alignModel})` : ''} ·{' '}
                              {result.captionCheck.inPauses} of {result.captionCheck.sentenceEnds}{' '}
                              sentence ends in pauses
                            </span>
                            {!result.captionCheck.passed && result.captionMode !== 'ai' && (
                              <button
                                type="button"
                                onClick={() => handleGenerate({ captionModeOverride: 'ai' })}
                                disabled={isGenerating}
                                className="font-sans font-semibold text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50"
                              >
                                Align with AI
                              </button>
                            )}
                          </p>
                        )}
                      </>
                    ) : isGenerating ? (
                      <p>{generationStatus || `Synthesizing with ${selectedVoiceName}...`}</p>
                    ) : (
                      <p>
                        {brief.transcript.trim()
                          ? 'Click Generate Audio & Captions to synthesize this script (0 calls until triggered).'
                          : 'Enter or paste a script on the left, then click Generate Audio & Captions.'}
                      </p>
                    )}
                  </div>
                </div>

                {result && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleDownloadWav}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-indigo-600 text-white text-xs font-medium hover:bg-zinc-800 dark:hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Download size={13} />
                      <span>Download WAV</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadSrt}
                      disabled={!srtText}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Download size={13} />
                      <span>Download SRT</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadVtt}
                      disabled={!vttText}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Download size={13} />
                      <span>Download VTT</span>
                    </button>
                  </div>
                )}
              </div>

              {error && (
                <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-2.5 text-red-700 dark:text-red-300 text-sm">
                    <AlertCircle size={18} className="shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium">Generation failed</p>
                      <p className="text-xs opacity-90 mt-0.5">{error}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleGenerate()}
                    className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700 transition-colors shrink-0"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Visualizer & Live Caption Stage */}
              <div className="rounded-xl bg-zinc-950 text-white overflow-hidden border border-zinc-800">
                <div className="h-28 relative flex items-center justify-center">
                  <div
                    className="absolute inset-0 opacity-15"
                    style={{
                      backgroundImage: 'radial-gradient(#a1a1aa 1px, transparent 1px)',
                      backgroundSize: '12px 12px',
                    }}
                  />
                  {isGenerating ? (
                    <div className="relative z-10 flex flex-col items-center gap-2 text-zinc-300 px-4 text-center">
                      <Loader2 size={24} className="animate-spin text-indigo-400" />
                      <span className="text-xs font-medium">
                        {generationStatus || `Synthesizing ${selectedVoiceName} recording...`}
                      </span>
                    </div>
                  ) : audioUrl ? (
                    <div className="w-full h-full">
                      <AudioVisualizer isPlaying={isPlaying} color="#818cf8" />
                    </div>
                  ) : (
                    <div className="relative z-10 text-xs text-zinc-400 text-center px-4">
                      Click Generate Audio &amp; Captions to synthesize this brief.
                    </div>
                  )}
                </div>

                {/* Live Synchronized Caption Display */}
                {showLiveCaptions && (
                  <div className="px-5 py-4 bg-zinc-900/90 border-t border-zinc-800 min-h-[76px] flex items-center justify-center text-center">
                    {activeCue ? (
                      <p className="text-base sm:text-lg font-medium text-white leading-snug max-w-2xl">
                        {activeCue.text}
                      </p>
                    ) : audioUrl ? (
                      <p className="text-sm text-zinc-400">
                        {isPlaying ? '...' : 'Press Play to preview audio with synchronized captions'}
                      </p>
                    ) : (
                      <p className="text-sm text-zinc-500">
                        Synchronized captions will appear here during playback
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Audio Controls */}
              {audioUrl && (
                <div className="space-y-3">
                  <audio
                    ref={audioRef}
                    src={audioUrl}
                    onTimeUpdate={() => {
                      if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
                    }}
                    onLoadedMetadata={() => {
                      if (audioRef.current && Number.isFinite(audioRef.current.duration)) {
                        setDuration(audioRef.current.duration);
                      }
                    }}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                    crossOrigin="anonymous"
                  >
                    {vttUrl && (
                      <track
                        kind="captions"
                        src={vttUrl}
                        srcLang="en"
                        label="English Captions"
                        default
                      />
                    )}
                  </audio>

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleTogglePlay}
                      className="h-10 w-10 rounded-full bg-zinc-900 dark:bg-indigo-600 text-white flex items-center justify-center hover:bg-zinc-800 dark:hover:bg-indigo-500 transition-colors shrink-0"
                      aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
                    >
                      {isPlaying ? (
                        <Pause size={16} className="fill-current" />
                      ) : (
                        <Play size={16} className="fill-current ml-0.5" />
                      )}
                    </button>

                    <span className="text-xs font-mono tabular-nums text-zinc-600 dark:text-zinc-300 w-12 shrink-0">
                      {formatDisplayTime(currentTime)}
                    </span>

                    <input
                      type="range"
                      min={0}
                      max={duration || 1}
                      step={0.05}
                      value={currentTime}
                      onChange={(e) => handleSeek(Number(e.target.value))}
                      className="flex-1 accent-zinc-900 dark:accent-indigo-500 cursor-pointer h-1.5"
                      aria-label="Seek audio position"
                    />

                    <span className="text-xs font-mono tabular-nums text-zinc-500 dark:text-zinc-400 w-12 text-right shrink-0">
                      {formatDisplayTime(duration)}
                    </span>

                    <div className="hidden sm:flex items-center gap-1 border-l border-zinc-200 dark:border-zinc-700 pl-3">
                      {[0.85, 1, 1.15, 1.25].map((rate) => (
                        <button
                          key={rate}
                          type="button"
                          onClick={() => setPlaybackRate(rate)}
                          className={`px-2 py-1 rounded text-xs font-mono tabular-nums transition-colors ${
                            playbackRate === rate
                              ? 'bg-zinc-900 dark:bg-indigo-600 text-white'
                              : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                          }`}
                        >
                          {rate}x
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => setShowLiveCaptions((v) => !v)}
                      className={`p-2 rounded-lg border transition-colors shrink-0 ${
                        showLiveCaptions
                          ? 'border-zinc-900 dark:border-indigo-500 text-zinc-900 dark:text-indigo-300 bg-zinc-50 dark:bg-indigo-950/30'
                          : 'border-zinc-200 dark:border-zinc-700 text-zinc-400'
                      }`}
                      title="Toggle live caption display"
                      aria-label="Toggle live caption display"
                    >
                      <Captions size={15} />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Captions File Viewer & Cue Editor */}
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setCaptionTab('cues')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      captionTab === 'cues'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    Interactive Cues ({cues.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setCaptionTab('srt')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      captionTab === 'srt'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    captions.srt
                  </button>
                  <button
                    type="button"
                    onClick={() => setCaptionTab('vtt')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                      captionTab === 'vtt'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    captions.vtt
                  </button>
                </div>

                {cues.length > 0 && captionTab !== 'cues' && (
                  <button
                    type="button"
                    onClick={() => handleCopyCaptions(captionTab)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    {copiedType === captionTab ? (
                      <>
                        <Check size={13} className="text-emerald-600 dark:text-emerald-400" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy size={13} />
                        <span>Copy {captionTab.toUpperCase()}</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              <div className="max-h-[380px] overflow-y-auto custom-scrollbar">
                {cues.length === 0 ? (
                  <div className="p-10 text-center text-zinc-400 dark:text-zinc-500 text-sm flex flex-col items-center gap-2">
                    <FileText size={24} className="opacity-50" />
                    <span>
                      {isGenerating
                        ? 'Aligning spoken audio to generate timed captions...'
                        : 'No captions generated yet.'}
                    </span>
                  </div>
                ) : captionTab === 'cues' ? (
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {cues.map((cue, idx) => {
                      const isActive = idx === activeCueIndex;
                      return (
                        <div
                          key={cue.index}
                          ref={isActive ? activeCueRef : null}
                          className={`px-5 py-3 flex items-start gap-4 transition-colors ${
                            isActive
                              ? 'bg-indigo-50/70 dark:bg-indigo-950/30'
                              : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => handleSeekAndPlay(cue.startSec)}
                            className={`text-left font-mono tabular-nums text-xs pt-1 shrink-0 transition-colors min-w-[116px] ${
                              isActive
                                ? 'text-indigo-600 dark:text-indigo-400 font-semibold'
                                : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
                            }`}
                            title="Jump to this timestamp"
                          >
                            <div>#{String(cue.index).padStart(2, '0')}</div>
                            <div>
                              {cue.startSec.toFixed(2)}s – {cue.endSec.toFixed(2)}s
                            </div>
                            {cue.voiceName && (
                              <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                                {cue.speakerSlot ? `[${cue.speakerSlot}] ` : ''}
                                {cue.voiceName}
                                {cue.speakerEstimated ? ' (est.)' : ''}
                              </div>
                            )}
                          </button>
                          <textarea
                            value={cue.text}
                            onChange={(e) => handleUpdateCueText(idx, e.target.value)}
                            rows={2}
                            className="flex-1 bg-transparent text-sm text-zinc-800 dark:text-zinc-200 leading-snug resize-none focus:outline-none focus:bg-white dark:focus:bg-zinc-900 rounded-md px-2 py-1 border border-transparent focus:border-zinc-200 dark:focus:border-zinc-700"
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <pre className="p-5 text-xs font-mono tabular-nums text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap leading-relaxed">
                    {captionTab === 'srt' ? srtText : vttText}
                  </pre>
                )}
              </div>
            </div>

            {/* Session Takes History (when 2+ takes exist, or 1 take for clarity) */}
            {takes.length > 0 && (
              <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock size={14} className="text-zinc-400" />
                    <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Session Takes ({takes.length})
                    </h4>
                  </div>
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">
                    Click any take to load its audio &amp; captions
                  </span>
                </div>
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-48 overflow-y-auto custom-scrollbar">
                  {takes.map((take) => {
                    const isCurrent = take.id === activeTakeId;
                    return (
                      <button
                        key={take.id}
                        type="button"
                        onClick={() => handleSelectTake(take)}
                        className={`w-full px-5 py-2.5 text-left flex items-center justify-between gap-4 transition-colors ${
                          isCurrent
                            ? 'bg-indigo-50/70 dark:bg-indigo-950/30'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
                            <span>{take.voiceName}</span>
                            <span className="text-zinc-400 font-normal">·</span>
                            <span className="text-zinc-500 dark:text-zinc-400 font-normal font-mono tabular-nums">
                              {formatDisplayTime(take.result.durationSec)}
                            </span>
                            <span className="text-zinc-400 font-normal">·</span>
                            <span className="text-zinc-400 font-normal font-mono tabular-nums">
                              {take.createdAt}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                            {take.transcriptPreview}
                          </p>
                        </div>
                        <span
                          className={`text-xs font-medium shrink-0 ${
                            isCurrent
                              ? 'text-indigo-600 dark:text-indigo-400'
                              : 'text-zinc-400 dark:text-zinc-500'
                          }`}
                        >
                          {isCurrent ? 'Active' : 'Load'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default AudioCaptionsStudio;
