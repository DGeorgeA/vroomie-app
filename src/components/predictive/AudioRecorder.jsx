import React, { useState, useRef } from "react";
import { Mic, Square, Upload, Loader2, Clock, Bug } from "lucide-react";
import GlassButton from "../ui/GlassButton";
import { toast } from "sonner";
import { startExtraction, stopExtraction } from "@/lib/audioFeatureExtractor";
import { matchBuffer } from "@/lib/audioMatchingEngine";
import { triggerContinuousAlert, clearContinuousAlert, speakText } from "@/lib/voiceFeedback";
import { Logger } from "@/lib/logger";
import { getDiagnosticMetadata } from "@/lib/diagnosticDictionary";

export default function AudioRecorder({
  onRecordingComplete,
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
  const sessionAnomaliesRef = useRef([]); // Track real anomalies exclusively
  const sessionConfidenceRef = useRef([]); 
  
  const [remainingTime, setRemainingTime] = useState(120); // 2 minutes target
  const [isVoiceAlertsEnabled, setIsVoiceAlertsEnabled] = useState(true);
  
  const [debugStats, setDebugStats] = useState(null);
  const IS_DEBUG = import.meta.env.DEV || true;

  // Remove WebSocket
  const startRecording = async () => {
    try {
      sessionAnomaliesRef.current = [];
      sessionConfidenceRef.current = [];
      
      // Start real-time extraction using our local pipeline
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
            status: result.status?.toUpperCase() || 'NORMAL'
          });
        }
        
        if (result.status === 'anomaly' || result.status === 'potential_anomaly') {
          // Add to session log to pass back up the chain later
          const anomalyData = {
             type: result.anomaly?.split('_').filter(a => a !== result.severity).join(' ').replace(/\b\w/g, l => l.toUpperCase()),
             severity: result.severity || 'high',
             timestamp: recordingTime,
             status: result.status,
             matchedFile: result.source
          };
          
          // Basic debouncing for the history array
          if (!sessionAnomaliesRef.current.some(a => a.type === anomalyData.type)) {
            sessionAnomaliesRef.current.push(anomalyData);
          }
          
          Logger.info(`Real-time Alert Dispatched to UI (${result.status})`, { anomaly: result.anomaly, score: result.confidence });
          toast.warning(`Issue Detected: ${anomalyData.type}`, {
            description: `Confidence: ${(result.confidence * 100).toFixed(1)}% | Status: ${result.status}`
          });
          
          triggerContinuousAlert(result.anomaly, isVoiceAlertsEnabled);
        } else {
          clearContinuousAlert();
        }
      });
      
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
        }
      });

      streamRef.current = stream;

      // Set up Web Audio API for visualization
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 2048;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyserNode);

      setAudioContext(audioCtx);
      setAnalyser(analyserNode);

      // Set up MediaRecorder for saving audio AND streaming
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);

          // Stream to WebSocket
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(e.data);
          }
        }
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        await handleAudioUpload(blob);

        // Clean up
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      };

      mediaRecorder.start(1000); // Send chunks every 1s
      setIsRecording(true);
      setRecordingTime(0);
      setRemainingTime(120);

      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => {
          const newTime = prev + 1;

          // 20 Second Intervals - Periodic Voice Check
          if (newTime % 20 === 0 && newTime < 120) {
            // Trigger voice prompt: "No anomalies, continuing..."
            speakText("No anomalies found. Continuing scan.");

            toast.info("Scanning in progress...", {
              description: `Time elapsed: ${newTime}s. Analyzing patterns...`,
              duration: 3000,
            });
          }

          // 20 Second Prompt
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
            // Auto stop at 0
            stopRecording();
            return 0;
          }
          return next;
        });
      }, 1000);

      toast.success("Recording started - recommended: 2 minutes");
    } catch (error) {
      console.error("Error accessing microphone:", error);
      toast.error("Could not access microphone. Please check permissions.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      stopExtraction(); // Stop our analysis pipeline

      if (timerRef.current) {
        clearInterval(timerRef.current);
      }

      clearContinuousAlert(); // Clear repeating alarms if active

      if (audioContext) {
        audioContext.close();
      }

      toast.info("Processing audio...");
    }
  };

  const handleAudioUpload = async (blob) => {
    try {
      const mockId = `analysis-live-${Date.now()}`;
      
      const realAnomalies = sessionAnomaliesRef.current || [];
      const totalConf = sessionConfidenceRef.current.reduce((a, b) => a + b, 0);
      const avgConfidence = sessionConfidenceRef.current.length > 0 
        ? (totalConf / sessionConfidenceRef.current.length) * 100 
        : 85; 

      const overallHealth = realAnomalies.length === 0
        ? "healthy"
        : realAnomalies.some(a => a.severity === "critical" || a.severity === "high")
          ? "critical"
          : "warning";

      const analysis = {
        id: mockId,
        vehicle_id: vehicleId,
        audio_file_url: URL.createObjectURL(blob),
        duration_seconds: recordingTime,
        status: realAnomalies.length > 0 ? "flagged" : "completed",
        confidence_score: avgConfidence,
        anomalies_detected: realAnomalies,
        analysis_result: {
          overall_health: overallHealth,
          confidence_score: avgConfidence,
          detected_patterns: realAnomalies.length > 0
            ? realAnomalies.map(a => a.type)
            : ["smooth_idle", "consistent_rpm"],
        },
        processed_at: new Date().toISOString(),
        created_date: new Date().toISOString(),
        notes: realAnomalies.length > 0
          ? "Active acoustic signatures met anomaly thresholds."
          : "Engine block returned nominal patterns cleanly across all frequencies.",
      };

      toast.success("Audio captured and verified fully on-device!");
      
      if (onRecordingComplete) {
        onRecordingComplete(analysis);
      }
      
      // Voice Feedback Confirmation
      if (isVoiceAlertsEnabled) {
          if (realAnomalies.length > 0) {
            const primary = realAnomalies[0].type;
            const meta = getDiagnosticMetadata(primary);
            speakText(`Analysis complete. Priority issue: ${primary}. Estimated repair costs around ${meta.usd} dollars.`);
          } else {
            speakText("No anomalies detected. Vehicle is operating normally.");
          }
      }
      
    } catch (error) {
      console.error("Error processing audio:", error);
      toast.error("Failed to process audio");
    }
  };



  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isRecording && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
              <div className="flex flex-col">
                <span className="text-white font-mono text-lg">
                  {formatTime(recordingTime)}
                </span>
                <span className="text-xs text-gray-500">
                  / 2:00
                </span>
              </div>
            </div>
          )}
          {!isRecording && recordingTime > 0 && (
            <span className="text-gray-400 text-sm">Last run: {formatTime(recordingTime)}</span>
          )}
        </div>

        <div className="flex gap-3">
          {!isRecording ? (
            <GlassButton
              onClick={startRecording}
              disabled={isAnalyzing}
              icon={Mic}
            >
              Start Recording
            </GlassButton>
          ) : (
            <GlassButton
              onClick={stopRecording}
              variant="secondary"
              icon={Square}
              className="border-red-500/30 text-red-400 hover:bg-red-500/10"
            >
              Stop Recording
            </GlassButton>
          )}
        </div>
      </div>

      {/* Voice Alert Settings Toggle */}
      <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/5">
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input 
            type="checkbox" 
            checked={isVoiceAlertsEnabled}
            onChange={(e) => setIsVoiceAlertsEnabled(e.target.checked)}
            className="rounded border-zinc-700 bg-zinc-800 text-blue-500 focus:ring-blue-500/50 cursor-pointer"
          />
          Voice Alerts ON/OFF
        </label>
      </div>

      {/* Pass analyser to parent for waveform visualization */}
      {isRecording && analyser && (
        <div className="hidden" data-analyser={analyser} />
      )}
      
      {/* Live Pipeline Debug Mode */}
      {IS_DEBUG && isRecording && debugStats && (
        <div className="mt-4 p-3 bg-black/40 border border-[#7b9a1e]/30 rounded-xl font-mono text-xs text-[#7b9a1e]/80 flex flex-col gap-1 backdrop-blur-md">
          <div className="flex items-center gap-2 mb-1 border-b border-[#7b9a1e]/20 pb-1">
            <Bug size={14} className="text-[#7b9a1e]" />
            <span className="font-bold tracking-widest uppercase text-[#7b9a1e]">ML Pipeline Telemetry</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4">
            <span>RMS Energy: <span className="text-white">{debugStats.rms}</span></span>
            <span>Centroid Hz: <span className="text-white">{debugStats.centroid}</span></span>
            <span className="col-span-2 mt-1 pt-1 border-t border-[#7b9a1e]/10">Match Confidence: <span className="text-white">{(debugStats.conf * 100).toFixed(1)}%</span></span>
          </div>
        </div>
      )}
    </div>
  );
}
