/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { Play, Square, Loader2, Volume2, AlertCircle, ChevronDown, Download } from 'lucide-react';
import { Voice } from '../types';
import { parseMarkdownBrief } from '../presets';
import AudioVisualizer from './AudioVisualizer';

interface AiTtsPreviewProps {
  text: string;
  voices: Voice[];
  systemInstruction?: string;
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

const AiTtsPreview: React.FC<AiTtsPreviewProps> = ({ text, voices, systemInstruction }) => {
  const [selectedVoiceName, setSelectedVoiceName] = useState(voices[0]?.name || 'Achernar');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedAudioUrl, setGeneratedAudioUrl] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (generatedAudioUrl) {
        URL.revokeObjectURL(generatedAudioUrl);
      }
    };
  }, [generatedAudioUrl]);

  useEffect(() => {
    if (voices.length > 0 && !voices.find((v) => v.name === selectedVoiceName)) {
      setSelectedVoiceName(voices[0].name);
    }
  }, [voices, selectedVoiceName]);

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (isMountedRef.current) {
      setIsPlaying(false);
    }
  };

  const handlePlay = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (isLoading) return;

    if (isPlaying) {
      stopAudio();
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const parsed = systemInstruction ? parseMarkdownBrief(systemInstruction) : null;
      const res = await fetch('/api/tts/generate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voiceName: selectedVoiceName,
          transcript: text,
          audioProfile: parsed?.audioProfile || '',
          scene: parsed?.scene || '',
          directorsNotes: parsed?.directorsNotes || '',
          sampleContext: parsed?.sampleContext || '',
          model: 'gemini-3.8-flash-tts',
          includeCaptions: false,
        }),
      });

      let data = await res.json().catch(() => ({}));
      if (res.status === 202 && data.statusUrl) {
        for (let attempt = 0; attempt < 90; attempt++) {
          await new Promise((r) => setTimeout(r, 1500));
          if (!isMountedRef.current) return;
          const jobRes = await fetch(data.statusUrl, { credentials: 'same-origin' });
          const jobData = await jobRes.json().catch(() => ({}));
          if (!jobRes.ok) {
            throw new Error(jobData.error || `Job check failed (${jobRes.status})`);
          }
          if (jobData.status === 'done' && jobData.result) {
            data = jobData.result;
            break;
          }
          if (jobData.status === 'failed') {
            throw new Error(jobData.error || 'Preview generation failed.');
          }
        }
      } else if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      if (!data.audioBase64) {
        throw new Error(data.error || 'No audio data received from API');
      }

      if (!isMountedRef.current) return;

      const blob = base64ToBlob(data.audioBase64, data.mimeType || 'audio/wav');
      const url = URL.createObjectURL(blob);
      setGeneratedAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });

      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
        if (isMountedRef.current) setIsPlaying(true);
      }
    } catch (err: any) {
      console.error('TTS Error:', err);
      if (isMountedRef.current) {
        setError(err?.message || 'Failed to generate speech. Please try again.');
      }
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!generatedAudioUrl) return;
    const a = document.createElement('a');
    a.href = generatedAudioUrl;
    a.download = `${selectedVoiceName.toLowerCase()}-preview.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <audio
        ref={audioRef}
        onEnded={() => {
          if (isMountedRef.current) setIsPlaying(false);
        }}
        onPause={() => {
          if (isMountedRef.current) setIsPlaying(false);
        }}
      />

      {/* Header / Controls */}
      <div className="p-4 flex flex-col sm:flex-row gap-3 items-center justify-between bg-white dark:bg-zinc-800 border-b border-zinc-100 dark:border-zinc-700">
        {/* Voice Selector */}
        <div className="relative group w-full sm:w-auto">
          <select
            value={selectedVoiceName}
            onChange={(e) => setSelectedVoiceName(e.target.value)}
            className="appearance-none w-full sm:w-48 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 py-2 pl-3 pr-10 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-zinc-200 dark:focus:ring-zinc-600 cursor-pointer transition-all hover:bg-zinc-100 dark:hover:bg-zinc-800"
            disabled={isLoading || isPlaying}
          >
            {voices.map((voice) => (
              <option key={voice.name} value={voice.name}>
                {voice.name} ({voice.analysis.gender})
              </option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-zinc-400">
            <ChevronDown size={14} />
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          {generatedAudioUrl && (
            <button
              type="button"
              onClick={handleDownload}
              className="p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
              title="Download WAV"
              aria-label="Download WAV"
            >
              <Download size={15} />
            </button>
          )}

          {/* Play Button */}
          <button
            onClick={handlePlay}
            disabled={isLoading}
            className={`flex items-center gap-2 px-5 py-2 rounded-full text-sm font-medium transition-all duration-300 transform active:scale-95 ${
              isPlaying
                ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-white border border-zinc-200 dark:border-zinc-600 hover:bg-zinc-200 dark:hover:bg-zinc-600'
                : 'bg-zinc-900 dark:bg-indigo-600 text-white hover:bg-zinc-800 dark:hover:bg-indigo-500 shadow-md'
            } ${isLoading ? 'cursor-not-allowed opacity-70' : ''}`}
          >
            {isLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : isPlaying ? (
              <Square size={16} className="fill-current" />
            ) : (
              <Play size={16} className="fill-current" />
            )}
            <span>{isLoading ? 'Generating...' : isPlaying ? 'Stop Preview' : 'Listen'}</span>
          </button>
        </div>
      </div>

      {/* Visualizer Area */}
      <div
        className={`h-24 relative flex items-center justify-center bg-zinc-50 dark:bg-zinc-900 overflow-hidden group ${
          isLoading ? 'cursor-not-allowed' : 'cursor-pointer'
        }`}
        onClick={handlePlay}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handlePlay();
        }}
        aria-label={isPlaying ? 'Stop audio preview' : 'Play audio preview'}
      >
        <div
          className="absolute inset-0 opacity-[0.05] dark:opacity-[0.1]"
          style={{
            backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)',
            backgroundSize: '8px 8px',
          }}
        ></div>

        <div className="w-full h-full absolute inset-0 flex items-center justify-center pointer-events-none">
          {isPlaying ? (
            <div className="w-full h-full opacity-80">
              <AudioVisualizer
                isPlaying={true}
                color={document.documentElement.classList.contains('dark') ? '#a5b4fc' : '#18181b'}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-zinc-300 dark:text-zinc-600">
              <Volume2 size={24} />
              <span className="text-xs font-medium">Click to preview audio</span>
            </div>
          )}
        </div>

        {error && (
          <div className="absolute inset-0 bg-zinc-50 dark:bg-zinc-900 flex items-center justify-center text-red-500 dark:text-red-400 gap-2 text-xs px-4 text-center z-20">
            <AlertCircle size={15} className="shrink-0" />
            <span className="line-clamp-2">{error}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default AiTtsPreview;