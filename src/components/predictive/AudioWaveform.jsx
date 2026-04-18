import React, { useRef, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Activity, AlertTriangle } from "lucide-react";

export default function AudioWaveform({ 
  audioContext, 
  analyser, 
  isRecording = false,
  anomalies = [],
  duration = 0,
  onAnomalyDetected 
}) {
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const [waveformData, setWaveformData] = useState([]);
  const [isListening, setIsListening] = useState(false);

  // Play alert tone when anomaly is detected
  const playAlertTone = (severity) => {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      const frequencies = {
        low: 440,
        medium: 587,
        high: 784,
        critical: 988,
      };

      oscillator.type = 'sine';
      oscillator.frequency.value = frequencies[severity] || 440;
      
      gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.start(audioCtx.currentTime);
      oscillator.stop(audioCtx.currentTime + 0.5);
      // NOTE: TTS is handled exclusively by voiceFeedback.js — do NOT speak here
    } catch (error) {
      console.error('Error playing alert tone:', error);
    }
  };

  useEffect(() => {
    if (anomalies.length > 0 && onAnomalyDetected) {
      const latestAnomaly = anomalies[anomalies.length - 1];
      playAlertTone(latestAnomaly.severity);
      onAnomalyDetected(latestAnomaly);
    }
  }, [anomalies.length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const updateCanvasSize = () => {
      const container = canvas.parentElement;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = container.clientWidth * dpr;
      canvas.height = container.clientHeight * dpr;
      canvas.style.width = container.clientWidth + 'px';
      canvas.style.height = container.clientHeight + 'px';
      ctx.scale(dpr, dpr);
    };

    updateCanvasSize();
    window.addEventListener('resize', updateCanvasSize);

    const width = canvas.width / (window.devicePixelRatio || 1);
    const height = canvas.height / (window.devicePixelRatio || 1);

    let phase = 0;
    let amplitude = 0.3;

    const drawWaveform = () => {
      // Clear with dark background
      ctx.fillStyle = "#09090b";
      ctx.fillRect(0, 0, width, height);

      // ECG Grid - Make it faint, background-only
      ctx.strokeStyle = "rgba(252, 211, 77, 0.04)";
      ctx.lineWidth = 1;
      
      // Horizontal lines
      const gridSpacingY = Math.max(20, height / 12);
      for (let i = 0; i < height; i += gridSpacingY) {
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(width, i);
        ctx.stroke();
      }
      
      // Vertical lines
      const gridSpacingX = Math.max(30, width / 20);
      for (let i = 0; i < width; i += gridSpacingX) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, height);
        ctx.stroke();
      }

      // Center line (baseline)
      ctx.strokeStyle = "rgba(252, 211, 77, 0.1)";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (isRecording && analyser) {
        // Live recording waveform
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);

        // Enhanced ECG-style waveform
        ctx.strokeStyle = "#FCD34D";
        ctx.lineWidth = 2.5;
        ctx.shadowBlur = 12; // Reduced glow intensity
        ctx.shadowColor = "#FCD34D";
        ctx.beginPath();

        const sliceWidth = (width * 1.0) / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0;
          const y = (v * height) / 2;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }

          x += sliceWidth;
        }

        ctx.lineTo(width, height / 2);
        ctx.stroke();
        ctx.shadowBlur = 0;

        animationRef.current = requestAnimationFrame(drawWaveform);
      } else if (isListening) {
        // Dynamic ECG animation when idle/listening
        ctx.strokeStyle = "#FCD34D";
        ctx.lineWidth = 2;
        ctx.shadowBlur = 8; // Reduced glow
        ctx.shadowColor = "#FCD34D";
        ctx.beginPath();

        const points = Math.max(150, width / 4);
        const sliceWidth = width / points;

        for (let i = 0; i < points; i++) {
          const x = i * sliceWidth;
          
          // Create realistic ECG pattern
          const normalizedX = i / points;
          let y = height / 2;
          
          // P wave (small bump before main spike)
          if (normalizedX % 0.25 < 0.05) {
            y += Math.sin((normalizedX % 0.05) / 0.05 * Math.PI) * 15;
          }
          
          // QRS complex (main sharp spike)
          else if (normalizedX % 0.25 >= 0.08 && normalizedX % 0.25 < 0.12) {
            const qrsPos = (normalizedX % 0.25 - 0.08) / 0.04;
            if (qrsPos < 0.3) {
              y -= 30; // Q wave
            } else if (qrsPos < 0.7) {
              y += 80 * Math.sin((qrsPos - 0.3) / 0.4 * Math.PI); // R wave (peak)
            } else {
              y -= 20; // S wave
            }
          }
          
          // T wave (rounded bump after spike)
          else if (normalizedX % 0.25 >= 0.15 && normalizedX % 0.25 < 0.22) {
            y += Math.sin(((normalizedX % 0.25 - 0.15) / 0.07) * Math.PI) * 25;
          }
          
          // Add slight noise for realism
          y += (Math.random() - 0.5) * 3;
          
          // Apply phase shift for animation
          const phaseOffset = Math.sin(phase + i * 0.1) * 2;
          y += phaseOffset;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }

        ctx.stroke();
        ctx.shadowBlur = 0;

        phase += 0.15; // Speed of ECG animation
        if (phase > Math.PI * 2) phase = 0;

        animationRef.current = requestAnimationFrame(drawWaveform);
      } else if (waveformData.length > 0) {
        // Static playback waveform
        ctx.strokeStyle = "#FCD34D";
        ctx.lineWidth = 2;
        ctx.shadowBlur = 8; // Reduced glow
        ctx.shadowColor = "#FCD34D";
        ctx.beginPath();

        const sliceWidth = width / waveformData.length;
        let x = 0;

        waveformData.forEach((value, i) => {
          const y = (value * height) / 2;
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
          x += sliceWidth;
        });

        ctx.stroke();
        ctx.shadowBlur = 0;

        // Anomaly markers
        anomalies.forEach((anomaly) => {
          const anomalyX = (anomaly.timestamp / duration) * width;
          const severityColors = {
            low: "#22c55e",
            medium: "#eab308",
            high: "#f97316",
            critical: "#ef4444",
          };
          const color = severityColors[anomaly.severity] || "#ef4444";

          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(anomalyX, 0);
          ctx.lineTo(anomalyX, height);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = color;
          ctx.shadowBlur = 20;
          ctx.shadowColor = color;
          ctx.beginPath();
          ctx.arc(anomalyX, height / 2, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        });
      } else {
        // Idle flat line
        ctx.strokeStyle = "rgba(252, 211, 77, 0.1)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
      }
    };

    drawWaveform();

    return () => {
      window.removeEventListener('resize', updateCanvasSize);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isRecording, analyser, waveformData, anomalies, duration, isListening]);

  const generateMockWaveform = () => {
    const data = [];
    for (let i = 0; i < 200; i++) {
      const value = Math.sin(i * 0.1) * 0.5 + Math.random() * 0.3;
      data.push(value + 1);
    }
    setWaveformData(data);
  };

  useEffect(() => {
    if (!isRecording && !waveformData.length) {
      generateMockWaveform();
    }
  }, []);

  useEffect(() => {
    setIsListening(true);
    return () => setIsListening(false);
  }, []);

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="w-full h-full rounded-xl"
      />
      
      {/* Listening Indicator */}
      {isListening && !isRecording && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="absolute top-2 md:top-4 right-2 md:right-4"
        >
          <div className="flex items-center gap-1.5 md:gap-2 backdrop-blur-md bg-yellow-300/10 border border-yellow-300/30 rounded-lg px-2 md:px-3 py-1 md:py-2">
            <motion.div
              animate={{
                scale: [1, 1.2, 1],
                opacity: [0.5, 1, 0.5],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            >
              <Activity className="w-3 h-3 md:w-4 md:h-4 text-yellow-300" />
            </motion.div>
            <span className="text-[10px] md:text-xs text-yellow-300 font-medium">Monitoring</span>
          </div>
        </motion.div>
      )}

      {!isRecording && waveformData.length === 0 && !isListening && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <Activity className="w-8 h-8 md:w-12 md:h-12 text-yellow-300/30 mx-auto mb-2" />
            <p className="text-gray-500 text-xs md:text-sm">Start recording to see live waveform</p>
          </div>
        </div>
      )}

      {/* Anomaly Legend */}
      {anomalies.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-2 md:mt-4 flex flex-wrap gap-2 md:gap-3"
        >
          {["low", "medium", "high", "critical"].map((severity) => {
            const count = anomalies.filter((a) => a.severity === severity).length;
            if (count === 0) return null;

            const colors = {
              low: "bg-green-500",
              medium: "bg-yellow-500",
              high: "bg-orange-500",
              critical: "bg-red-500",
            };

            return (
              <div key={severity} className="flex items-center gap-1.5 md:gap-2">
                <div className={`w-2 h-2 md:w-3 md:h-3 rounded-full ${colors[severity]} animate-pulse`} />
                <span className="text-[10px] md:text-xs text-gray-400 capitalize">
                  {severity}: {count}
                </span>
              </div>
            );
          })}
          <div className="flex items-center gap-1.5 md:gap-2 ml-auto">
            <AlertTriangle className="w-3 h-3 md:w-4 md:h-4 text-yellow-400" />
            <span className="text-[10px] md:text-xs text-yellow-400 hidden md:inline">
              Audio alerts enabled
            </span>
          </div>
        </motion.div>
      )}
    </div>
  );
}