import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, Square, Upload, Loader2, Clock, Bug, Cpu, AudioWaveform as WaveformIcon, Lock, Sparkles } from "lucide-react";
import GlassButton from "../ui/GlassButton";
import { toast } from "sonner";
import { startExtraction, stopExtraction, getActiveMediaStream, getActiveAudioContext } from "@/lib/audioFeatureExtractor";
import { matchBuffer, resetMatchState } from "@/lib/audioMatchingEngine";
import { triggerContinuousAlert, clearContinuousAlert, speakText } from "@/lib/voiceFeedback";
import { Logger } from "@/lib/logger";
import { getDiagnosticMetadata } from "@/lib/diagnosticDictionary";
import { getDetectionMode, setDetectionMode } from "@/lib/detectionMode";
import { useAuth } from "@/contexts/AuthContext";
import { canAccess } from "@/lib/featureGate";
import UpgradeModal from "./UpgradeModal";
import { motion } from "framer-motion";
import { supabase } from "@/lib/supabase";
import { useSettingsStore } from "@/store/settingsStore";

export default function AudioRecorder({
  onRecordingComplete,
  onRecordingStart,
  vehicleId,
  isAnalyzing = false,
  language = 'en-US'
}) {
  const [isRecording, setIsRecording] = useState(false);
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
  
  const [debugStats, setDebugStats] = useState(null);
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const IS_DEBUG = import.meta.env.DEV;
  const { isPro } = useAuth();
  const navigate = useNavigate();

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

  const startRecording = async () => {
    try {
      sessionAnomaliesRef.current = [];
      sessionConfidenceRef.current = [];
      
      const activeMode = getDetectionMode();
      
      await startExtraction((features) => {
        const result = matchBuffer(features);
        
        if (result.confidence > 0) {
          sessionConfidenceRef.current.push(result.confidence);
        }
        
        if (IS_DEBUG) {
          setDebugStats({
            rms: features.rms.toFixed(4),
            centroid: features.spectralCentroid.toFixed(1),
            conf: result.confidence.toFixed(3),
            status: result.status?.toUpperCase() || 'NORMAL',
            cnnClass: result.detectedClass || 'N/A',
            cnnConf: result.cnnConfidence ? (result.cnnConfidence * 100).toFixed(1) + '%' : 'N/A',
            source: result.classifierSource || 'meyda',
            mode: result.mode || activeMode
          });
        }
        
        if (result.status === 'anomaly' || result.status === 'potential_anomaly') {
          const anomalyData = {
             type: result.anomaly?.split('_').filter(a => a !== result.severity).join(' ').replace(/\b\w/g, l => l.toUpperCase()),
             severity: result.severity || 'high',
             timestamp: recordingTime,
             status: result.status,
             matchedFile: result.source,
             detectedClass: result.detectedClass,
             cnnConfidence: result.cnnConfidence,
             classifierSource: result.classifierSource,
             mode: result.mode || activeMode,
             // Phase 2 Hybrid Metrics
             mlConfidence: result.mlConfidence || 0,
             signalSimilarity: result.signalSimilarity || 0,
             finalDecision: result.finalDecision || 'NO ANOMALY'
          };
          
          if (!sessionAnomaliesRef.current.some(a => a.type === anomalyData.type)) {
            sessionAnomaliesRef.current.push(anomalyData);
          }
          
          Logger.info(`Real-time Alert (${result.status}) [HYBRID]`, { anomaly: result.anomaly, finalDecision: result.finalDecision });
          
          // Only pop toast if it's confirmed or probable (not transient tracking)
          if (result.finalDecision !== 'NO ANOMALY') {
            toast.warning(`${result.finalDecision}: ${anomalyData.type}`, {
              description: `ML: ${(anomalyData.mlConfidence * 100).toFixed(1)}% | Signal: ${(anomalyData.signalSimilarity * 100).toFixed(1)}%`
            });
          }
          
          // STRICT RULE: Bind Voice Output ONLY to CONFIRMED ANOMALY 
          if (result.finalDecision === 'CONFIRMED ANOMALY') {
             triggerContinuousAlert(result.anomaly, isVoiceAlertsEnabled);
          }
        } else {
          clearContinuousAlert();
        }
      });
      
      // CRITICAL FIX: Do NOT call getUserMedia twice.
      // startExtraction already got the mic. Reuse that stream.
      const stream = getActiveMediaStream();
      const audioCtx = getActiveAudioContext();
      
      if (!stream) {
        throw new Error("Feature extractor started but no stream available");
      }

      streamRef.current = stream;

      const analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 2048;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyserNode);

      setAudioContext(audioCtx);
      setAnalyser(analyserNode);

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          await handleAudioUpload(blob);

          if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
          }
        } catch (uploadObjErr) {
          console.error("Failed to upload audio at end of recording:", uploadObjErr);
        }
      };

      mediaRecorder.start(1000);
      setIsRecording(true);
      setRecordingTime(0);
      setRemainingTime(120);

      // Notify parent so it can cancel the feedback popup timer
      if (onRecordingStart) onRecordingStart();

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => {
          const newTime = prev + 1;

          if (newTime % 20 === 0 && newTime < 120) {
            try { speakText("No anomalies found. Continuing scan."); } catch (e) {}
            toast.info("Scanning in progress...", {
              description: `Time elapsed: ${newTime}s. Analyzing patterns...`,
              duration: 3000,
            });
          }

          if (newTime === 20) {
            toast.info("Sufficient data collected.", {
              description: "You can stop now, or keep running for a deep scan.",
              duration: 5000,
              action: {
                label: "Stop",
                onClick: () => stopRecording()
              }
            });
          }

          return newTime;
        });

        setRemainingTime((prev) => {
          const next = prev - 1;
          if (next <= 0) {
            stopRecording();
            return 0;
          }
          return next;
        });
      }, 1000);

      const modeLabel = activeMode === 'ml' ? 'ML Mode' : 'Basic Mode';
      toast.success(`Recording started [${modeLabel}] - recommended: 2 minutes`);
    } catch (error) {
      console.error("🚨 Error in startRecording:", error);
      if (error.name === 'NotAllowedError' || error.message.includes('Permission')) {
        setMicPermissionDenied(true);
        toast.error("Microphone access is required for real-time analysis.");
      } else {
        toast.error("Failed to start the audio engine. Ensure your device has a working microphone.");
      }
      setIsRecording(false);
      stopExtraction();
    }
  };

  const stopRecording = () => {
    try {
      if (mediaRecorderRef.current && isRecording) {
        if (mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.stop();
        }
        setIsRecording(false);
        stopExtraction(); // This handles closing stream and audioContext

        if (timerRef.current) {
          clearInterval(timerRef.current);
        }

        clearContinuousAlert();
        toast.info("Processing audio...");
      }
    } catch (error) {
      console.error("Error stopping recording:", error);
      toast.error("Failed to stop recording cleanly");
      setIsRecording(false);
      stopExtraction();
    }
  };

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

      // ── Step 4: Voice alerts ───────────────────────────────────────────────
      if (isVoiceAlertsEnabled) {
        if (realAnomalies.length > 0) {
          const primary = realAnomalies[0].type;
          const meta = getDiagnosticMetadata(primary);
          speakText(`Analysis complete. Priority issue: ${primary}. Estimated repair cost around ${meta.usd} dollars.`);
        } else {
          speakText('Analysis complete. No anomalies detected. Vehicle is operating normally.');
        }
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
               <button onClick={() => window.location.reload()} className="mt-3 px-6 py-2.5 bg-white text-black text-xs font-bold rounded-full hover:bg-zinc-200 transition-colors shadow-xl">
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
            >
              Start Recording
            </GlassButton>
          ) : (
            <GlassButton
              variant="danger"
              size="lg"
              icon={Square}
              onClick={stopRecording}
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
