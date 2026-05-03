import React, { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, Square, Bug, Lock, Sparkles } from "lucide-react";
import GlassButton from "../ui/GlassButton";
import { toast } from "sonner";
import { startExtraction, stopExtraction, getActiveMediaStream, getActiveAudioContext } from "@/lib/audioFeatureExtractor";
import { buildReadableLabel, resetMatchState } from "@/lib/audioMatchingEngine";
import { clearContinuousAlert, speakScanResult } from "@/lib/voiceFeedback";
import { Logger } from "@/lib/logger";
import { getDetectionMode, setDetectionMode } from "@/lib/detectionMode";
import { useAuth } from "@/contexts/AuthContext";
import UpgradeModal from "./UpgradeModal";
import { motion } from "framer-motion";
import { supabase } from "@/lib/supabase";
import { useSettingsStore } from "@/store/settingsStore";

export default function AudioRecorder({
  onRecordingComplete,
  onRecordingStart,
  onAnalyserReady,
  vehicleId,
  isAnalyzing = false,
  language = 'en-US'
}) {
  const [isRecording, setIsRecording] = useState(false);
  // Ref mirrors isRecording so callbacks (timers, async) never capture stale state
  const isRecordingRef = useRef(false);
  const [audioContext, setAudioContext] = useState(null);
  const [analyser, setAnalyser] = useState(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const streamRef = useRef(null);
  const sessionAnomaliesRef = useRef([]);
  const sessionConfidenceRef = useRef([]); 
  
  const [remainingTime, setRemainingTime] = useState(120);
  // Read voice alerts + detection mode from global settings store (persisted)
  const { voiceAlertsEnabled: isVoiceAlertsEnabled, detectionMode: storedMode } = useSettingsStore();
  const [detectionMode, setDetectionModeState] = useState(storedMode || getDetectionMode());
  
  // PWA UX States
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  
  // Track offline status globally
  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Pre-warm microphone permission & pipeline to reduce overall latency when user clicks start
  useEffect(() => {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        .then(stream => {
          // Keep permission active but stop tracks immediately
          stream.getTracks().forEach(t => t.stop());
        })
        .catch(err => {
          console.warn("Pre-warm mic check failed. Permission will be requested on first click.", err);
        });
    }
    // Eagerly initialize AudioDataset to ensure it's loaded before click
    import('../../services/audioDatasetService').then(({ initializeAudioDataset }) => {
      initializeAudioDataset().catch(console.error);
    });
  }, []);
  
  const [debugStats, setDebugStats] = useState(null);
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const IS_DEBUG = import.meta.env.DEV;
  const { isPro } = useAuth();
  const navigate = useNavigate();
  // Debounce ref for debug stats — prevents re-render on every audio callback
  const debugDebounceRef = useRef(null);
  const pendingDebugRef  = useRef(null);

  // ─── Desktop Keyboard Shortcuts ─────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      if (e.code === 'Space' || e.key.toLowerCase() === 'r') {
        e.preventDefault(); // Prevent page scrolling
        if (isRecording) {
          stopRecording();
        } else if (!isAnalyzing) {
          startRecording();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isRecording, isAnalyzing]);

  // ─── Detection Mode Toggle Handler ──────────────────────
  const handleModeSwitch = (mode) => {
    try {
      if (isRecording) {
        toast.warning("Cannot switch while recording. Stop first.");
        return;
      }
      
      if (mode === 'ml' && !isPro) {
        setIsUpgradeModalOpen(true);
        return;
      }
      
      setDetectionMode(mode);
      setDetectionModeState(mode);
      resetMatchState();
      const modeLabel = mode === 'ml' ? '⚡ AI Enabled' : '🔊 Basic Mode';
      toast.success(`Detection mode set to: ${modeLabel}`);
      Logger.info(`User switched detection mode to: ${mode}`);
    } catch (err) {
      console.error("Error switching mode:", err);
      toast.error("Failed to switch interaction mode");
    }
  };

  const startRecording = () => {
    // MANDATORY debug log — confirms button is wired and responding instantly
    console.log("[Vroomie] Start Recording triggered");
    try {
      // ══════════════════════════════════════════════════════════════
      // STEP 1 — INSTANT UI RESPONSE (0ms, no await, no async)
      // The waveform burst animation fires here. Timer starts here.
      // User sees immediate feedback before mic even initialises.
      // ══════════════════════════════════════════════════════════════
      sessionAnomaliesRef.current  = [];
      sessionConfidenceRef.current = [];

      isRecordingRef.current = true;   // ← update ref FIRST (used by async callbacks)
      setIsRecording(true);            // ← triggers waveform BURST immediately
      setRecordingTime(0);
      setRemainingTime(120);

      // Notify parent now (cancels feedback popup timer)
      if (onRecordingStart) onRecordingStart();

      // Start the display timer instantly
      const activeMode = getDetectionMode();
      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => {
          const newTime = prev + 1;
          if (newTime === 20) {
            toast.info("Sufficient data collected.", {
              description: "You can stop now, or keep running for a deep scan.",
              duration: 5000,
              // Use ref-based stop to avoid stale closure
              action: { label: "Stop", onClick: () => { if (isRecordingRef.current) stopRecording(); } }
            });
          }
          return newTime;
        });
        setRemainingTime((prev) => {
          const next = prev - 1;
          // Use isRecordingRef — never captures stale state in closure
          if (next <= 0 && isRecordingRef.current) { stopRecording(); return 0; }
          return next;
        });
      }, 1000);

      const modeLabel = activeMode === 'ml' ? 'ML Mode' : 'Basic Mode';
      toast.success(`Recording started [${modeLabel}]`);

      // Defer all heavy audio initialization to ensure UI renders instantly
      setTimeout(() => {
        _startExtractionAsync(activeMode).catch(error => {
          // Revert all UI state if async setup failed
          console.error("🚨 Error in deferred startRecording:", error);
          isRecordingRef.current = false;
          setIsRecording(false);
          if (timerRef.current) clearInterval(timerRef.current);
          if (debugDebounceRef.current) {
            clearTimeout(debugDebounceRef.current);
            debugDebounceRef.current = null;
          }
          stopExtraction();

          if (error.name === 'NotAllowedError' || error.message?.includes('Permission')) {
            setMicPermissionDenied(true);
            toast.error("Microphone access is required for real-time analysis.");
          } else {
            toast.error("Failed to start the audio engine. Ensure your device has a working microphone.");
          }
        });
      }, 0);

    } catch (error) {
      console.error("[Vroomie] startRecording error:", error);
      isRecordingRef.current = false;
      toast.error("Failed to start recording");
    }
  };

  const _startExtractionAsync = async (activeMode) => {
      // ══════════════════════════════════════════════════════════════
      // STEP 2 — ASYNC: Initialise audio processing in background
      // UI already shows "recording". Mic permission happens here.
      // ══════════════════════════════════════════════════════════════
      await startExtraction((features) => {
        const workerResult = features._workerResult || {};
        const status     = workerResult.status     || 'normal';
        const confidence = workerResult.confidence  || 0;
        const anomaly    = workerResult.anomaly     || null;
        const severity   = workerResult.severity    || 'medium';
        const rms        = workerResult.rms         || features.rms || 0;

        if (confidence > 0) {
          sessionConfidenceRef.current.push(confidence);
        }

        // Debounced debug stats — max 4 re-renders/sec
        if (IS_DEBUG) {
          pendingDebugRef.current = {
            rms:      rms.toFixed(4),
            centroid: '0.0',
            conf:     confidence.toFixed(3),
            status:   status.toUpperCase(),
            cnnClass: 'N/A',
            cnnConf:  'N/A',
            source:   'off_thread_worker',
            mode:     activeMode
          };
          if (!debugDebounceRef.current) {
            debugDebounceRef.current = setTimeout(() => {
              if (pendingDebugRef.current) setDebugStats(pendingDebugRef.current);
              debugDebounceRef.current = null;
            }, 250);
          }
        }

        // Accumulate confirmed anomalies only
        if (status === 'anomaly' && anomaly) {
          const cleanLabel = buildReadableLabel(anomaly);
          const anomalyData = {
            type:             cleanLabel,
            rawLabel:         anomaly,
            severity,
            timestamp:        recordingTime,
            status:           'anomaly',
            signalSimilarity: confidence,
            finalDecision:    'ANOMALY DETECTED',
          };
          if (!sessionAnomaliesRef.current.some(a => a.rawLabel === anomaly)) {
            sessionAnomaliesRef.current.push(anomalyData);
            Logger.info(`Session anomaly added: ${cleanLabel}`);
          }
        }
      });

      // ══════════════════════════════════════════════════════════════
      // STEP 3 — Wire up waveform analyser + MediaRecorder
      // These are non-blocking once startExtraction resolves.
      // ══════════════════════════════════════════════════════════════
      const stream   = getActiveMediaStream();
      const audioCtx = getActiveAudioContext();

      if (!stream) throw new Error("Feature extractor started but no stream available");

      streamRef.current = stream;

      // Lightweight analyser for waveform UI (read-only, 1024 fftSize)
      const waveformAnalyser = audioCtx.createAnalyser();
      waveformAnalyser.fftSize = 1024;
      const waveformSource = audioCtx.createMediaStreamSource(stream);
      waveformSource.connect(waveformAnalyser);
      setAudioContext(audioCtx);
      setAnalyser(waveformAnalyser); // ← waveform switches from simulated → live data here
      // Propagate live analyser + audio context to parent (AudioWaveform in PredictiveMaintenance)
      if (onAnalyserReady) onAnalyserReady(audioCtx, waveformAnalyser);

      // MediaRecorder for audio blob upload
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          await handleAudioUpload(blob);
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
          }
        } catch (uploadErr) {
          console.error("Failed to upload audio:", uploadErr);
        }
      };

      mediaRecorder.start(1000);
  };


  const stopRecording = useCallback(() => {
    try {
      // Clear any pending debug debounce
      if (debugDebounceRef.current) {
        clearTimeout(debugDebounceRef.current);
        debugDebounceRef.current = null;
      }

      // Use ref — never stale when called from timer callbacks or async contexts
      if (isRecordingRef.current) {
        // INSTANT UI UPDATE
        isRecordingRef.current = false;
        setIsRecording(false);
        
        if (timerRef.current) {
          clearInterval(timerRef.current);
        }

        clearContinuousAlert();
        toast.info("Processing audio...");

        // DEFER HEAVY CLEANUP
        setTimeout(() => {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.stop();
          }
          stopExtraction(); // releases AudioWorklet + Worker + stream
        }, 0);
      }
    } catch (error) {
      console.error("Error stopping recording:", error);
      toast.error("Failed to stop recording cleanly");
      isRecordingRef.current = false;
      setIsRecording(false);
      setTimeout(() => stopExtraction(), 0);
    }
  }, []); // no deps — reads from isRecordingRef instead of stale isRecording

  const handleAudioUpload = async (blob) => {
    try {
      const activeMode = getDetectionMode();
      const realAnomalies = sessionAnomaliesRef.current || [];
      const totalConf = sessionConfidenceRef.current.reduce((a, b) => a + b, 0);
      const avgConfidence = sessionConfidenceRef.current.length > 0
        ? (totalConf / sessionConfidenceRef.current.length) * 100
        : 75;

      const overallHealth = realAnomalies.length === 0
        ? 'healthy'
        : realAnomalies.some(a => a.severity === 'critical' || a.severity === 'high')
          ? 'critical'
          : 'warning';

      // ── Step 1: Upload audio to Supabase Storage ──────────────────────────
      let audioFileUrl = null;
      try {
        const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
        const filePath = `recordings/${sessionId}.${ext}`;

        const { error: uploadErr } = await supabase.storage
          .from('audio-analyses')
          .upload(filePath, blob, { contentType: blob.type, upsert: false });

        if (!uploadErr) {
          const { data: urlData } = supabase.storage
            .from('audio-analyses')
            .getPublicUrl(filePath);
          audioFileUrl = urlData.publicUrl;
        } else {
          console.warn('Audio upload skipped:', uploadErr.message);
        }
      } catch (uploadEx) {
        console.warn('Storage upload error:', uploadEx.message);
      }

      // ── Step 2: Build the analysis payload ───────────────────────────────
      const primaryAnomaly = realAnomalies[0] || null;

      const dbPayload = {
        // created_at is server-generated — never set by client
        vehicle_id: vehicleId || null,
        audio_file_url: audioFileUrl,
        duration_seconds: recordingTime,
        status: realAnomalies.length > 0 ? 'flagged' : 'completed',
        confidence_score: parseFloat(avgConfidence.toFixed(2)),
        anomalies_detected: realAnomalies,
        detection_mode: activeMode,
        detection_source: activeMode === 'ml' ? 'YAMNet + DTW Fusion' : 'Signal Analysis',
        ml_confidence: primaryAnomaly?.mlConfidence ?? null,
        signal_similarity: primaryAnomaly?.signalSimilarity ?? null,
        final_decision: primaryAnomaly?.finalDecision ?? 'NO ANOMALY',
        analysis_result: {
          overall_health: overallHealth,
          confidence_score: avgConfidence,
          detected_patterns: realAnomalies.length > 0
            ? realAnomalies.map(a => a.type)
            : ['smooth_idle', 'consistent_rpm'],
        },
        // processed_at intentionally omitted — created_at is server-generated (DEFAULT now())
        // Never inject client-side timestamps into the primary timestamp chain
      };

      // ── Step 3: Insert into analyses table ────────────────────────────────
      const { data: inserted, error: insertErr } = await supabase
        .from('analyses')
        .insert([dbPayload])
        .select()
        .single();

      if (insertErr) {
        console.error('Failed to save analysis to DB:', insertErr.message);
        toast.error('Recording saved locally only. DB write failed.');
        // Still notify UI with local data so UI doesn't break
        if (onRecordingComplete) {
          onRecordingComplete({ ...dbPayload, id: `local-${crypto.randomUUID()}`, created_date: null });
        }
        return;
      }

      toast.success('Analysis saved and synced!');

      // onRecordingComplete triggers the realtime refetch
      if (onRecordingComplete) {
        onRecordingComplete(inserted);
      }

      // ── Step 4: Post-recording voice summary (ONLY place TTS fires) ────────
      if (isVoiceAlertsEnabled) {
        speakScanResult(realAnomalies, language);
      }

    } catch (error) {
      console.error('Error processing audio:', error);
      toast.error('Failed to process audio recording.');
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-8 flex flex-col items-center w-full relative">
      
      <UpgradeModal 
        isOpen={isUpgradeModalOpen} 
        onClose={() => setIsUpgradeModalOpen(false)} 
      />

      {/* ═══ Detection Mode Toggle (Centered & Minimal) ═══ */}
      <div className="flex flex-col items-center gap-3 mb-4">
        {/* Subtle System Status */}
        <div className="flex items-center gap-2">
          {isOffline ? (
            <>
              <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.8)]" />
              <span className="text-[10px] text-amber-500/80 font-medium uppercase tracking-widest">
                Offline Mode Active
              </span>
            </>
          ) : (
            <>
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
              <span className="text-[10px] text-gray-500 font-medium uppercase tracking-widest">
                {detectionMode === 'ml' ? 'AI Engine Ready' : 'System Ready'}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center bg-black/40 border border-white/5 rounded-full p-1 backdrop-blur-xl shadow-2xl">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => handleModeSwitch('basic')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-xs font-semibold transition-colors duration-300 ${
              detectionMode === 'basic'
                ? 'bg-zinc-800/80 text-white shadow-md border border-zinc-700/50'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            Basic
          </motion.button>
          
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => handleModeSwitch('ml')}
            className={`relative group flex items-center gap-2 px-5 py-2.5 rounded-full text-xs font-bold transition-colors duration-300 overflow-hidden ${
              detectionMode === 'ml'
                ? 'bg-gradient-to-r from-cyan-600/90 to-blue-700/90 text-white shadow-[0_0_20px_rgba(6,182,212,0.4)] border border-cyan-400/50'
                : !isPro
                  ? 'bg-gradient-to-r from-cyan-900/40 to-blue-900/40 text-cyan-200/50 border border-cyan-500/10'
                  : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {/* Shimmer animation for AI Enabled button */}
            {(!isPro || detectionMode === 'ml') && (
              <div className="absolute inset-0 w-[200%] bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-100%] animate-[shimmer_3s_infinite]" />
            )}
            
            {!isPro && <Lock className="w-3 h-3 text-cyan-400/50 relative z-10" />}
            {isPro && <Sparkles className="w-3.5 h-3.5 text-cyan-300 relative z-10" />}
            <span className="relative z-10 text-transparent bg-clip-text bg-gradient-to-r from-cyan-100 to-white">
              AI Enabled
            </span>
            
            {/* Glow halo */}
            {detectionMode === 'ml' && (
              <div className="absolute inset-0 shadow-[inset_0_0_12px_rgba(255,255,255,0.2)] rounded-full pointer-events-none" />
            )}
          </motion.button>
        </div>
      </div>

      {/* ═══ Recording Controls (Centered Spheroid) ═══ */}
      <div className="flex flex-col items-center justify-center w-full mt-4">
        <div className="flex items-center gap-3 mb-6 min-h-[30px]">
          {isRecording && (
            <div className="flex items-center gap-2 bg-red-500/10 px-4 py-1.5 rounded-full border border-red-500/20">
              <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]" />
              <span className="text-red-400 font-mono text-base tracking-wider">
                {formatTime(recordingTime)}
              </span>
            </div>
          )}
          {!isRecording && recordingTime > 0 && !micPermissionDenied && (
            <span className="text-gray-600 text-xs font-mono tracking-widest uppercase">Last run: {formatTime(recordingTime)}</span>
          )}
        </div>

        <div className="flex gap-3 justify-center w-full">
          {micPermissionDenied ? (
            <div className="flex flex-col items-center gap-3 p-6 bg-red-950/20 border border-red-500/20 rounded-3xl w-full max-w-[280px] text-center shadow-lg backdrop-blur-sm">
               <Mic className="w-8 h-8 text-red-400/80 mb-1" />
               <h3 className="text-white/90 font-semibold text-sm">Microphone Required</h3>
               <p className="text-zinc-400 text-xs text-balance">Vroomie needs mic access to perform acoustic AI diagnostics.</p>
               <button
                 onClick={() => window.location.reload()}
                 style={{ touchAction: 'manipulation', minHeight: '44px' }}
                 className="mt-3 px-6 py-2.5 bg-white text-black text-xs font-bold rounded-full hover:bg-zinc-200 transition-colors shadow-xl"
               >
                 Reload App
               </button>
            </div>
          ) : !isRecording ? (
            <GlassButton
              variant="primary"
              size="lg"
              icon={Mic}
              onClick={startRecording}
              disabled={isAnalyzing}
              // touch-action: manipulation prevents 300ms mobile tap delay
              style={{ touchAction: 'manipulation', minHeight: '44px' }}
              id="btn-start-recording"
            >
              Start Recording
            </GlassButton>
          ) : (
            <GlassButton
              variant="danger"
              size="lg"
              icon={Square}
              onClick={stopRecording}
              style={{ touchAction: 'manipulation', minHeight: '44px' }}
              id="btn-stop-recording"
            >
              Stop
            </GlassButton>
          )}
        </div>
      </div>


      {/* Pass analyser to parent for waveform visualization */}
      {isRecording && analyser && (
        <div className="hidden" data-analyser={analyser} />
      )}
      
      {/* Live Pipeline Debug Mode */}
      {IS_DEBUG && isRecording && debugStats && (
        <div className="mt-4 p-3 bg-black/40 border border-[#7b9a1e]/30 rounded-xl font-mono text-xs text-[#7b9a1e]/80 flex flex-col gap-1 backdrop-blur-md">
          <div className="flex items-center justify-between mb-1 border-b border-[#7b9a1e]/20 pb-1">
            <div className="flex items-center gap-2">
              <Bug size={14} className="text-[#7b9a1e]" />
              <span className="font-bold tracking-widest uppercase text-[#7b9a1e]">Pipeline Telemetry</span>
            </div>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
              debugStats.mode === 'ml' 
                ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' 
                : 'bg-zinc-700 text-zinc-300 border border-zinc-600'
            }`}>{debugStats.mode === 'ml' ? '🤖 ML' : '🔊 BASIC'}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4">
            <span>RMS Energy: <span className="text-white">{debugStats.rms}</span></span>
            <span>Centroid Hz: <span className="text-white">{debugStats.centroid}</span></span>
            <span className="col-span-2 mt-1 pt-1 border-t border-[#7b9a1e]/10">
              {debugStats.mode === 'basic' ? 'Meyda' : 'Active'} Confidence: <span className="text-white">{(debugStats.conf * 100).toFixed(1)}%</span>
            </span>
          </div>
          {debugStats.mode === 'ml' && (
            <div className="mt-2 pt-2 border-t border-cyan-500/20">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-bold tracking-widest uppercase text-cyan-400">🧠 CNN Classifier</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                  debugStats.source === 'cnn' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                }`}>{debugStats.source?.toUpperCase()}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4">
                <span>CNN Class: <span className="text-cyan-300">{debugStats.cnnClass}</span></span>
                <span>CNN Conf: <span className="text-cyan-300">{debugStats.cnnConf}</span></span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
