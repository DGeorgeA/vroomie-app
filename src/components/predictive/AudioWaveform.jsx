/**
 * AudioWaveform.jsx — Real-time canvas waveform with animation state machine
 *
 * STATES:
 *   idle      → ECG animation @ 20fps (throttled, no mic needed)
 *   burst     → 0–3s after recording start: aggressive multi-frequency simulation
 *   live      → 3s+ : live analyser data (or simulated if analyser not yet ready)
 *   stopping  → 0–300ms spike + 300–1000ms exponential decay after stop
 *
 * State transitions fire from isRecording prop changes — decoupled from mic readiness.
 * All animation runs in a single RAF loop; only the draw function changes per state.
 */
import React, { useRef, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Activity, AlertTriangle } from "lucide-react";

// ─── Constants ────────────────────────────────────────────
const BURST_DURATION   = 3000; // ms — aggressive phase
const STOP_SPIKE_MS    = 300;  // ms — spike phase on stop
const STOP_TOTAL_MS    = 1000; // ms — full stopping animation
const IDLE_FRAME_MS    = 50;   // ~20fps when idle
const LIVE_GLOW        = 14;
const BURST_GLOW       = 22;

// ─── Drawing helpers ──────────────────────────────────────
function clearCanvas(ctx, width, height) {
  ctx.fillStyle = "#09090b";
  ctx.fillRect(0, 0, width, height);
}

function drawGrid(ctx, width, height) {
  ctx.strokeStyle = "rgba(252, 211, 77, 0.04)";
  ctx.lineWidth = 1;
  const gY = Math.max(20, height / 12);
  const gX = Math.max(30, width / 20);
  for (let y = 0; y < height; y += gY) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  for (let x = 0; x < width; x += gX) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  // Centre baseline
  ctx.strokeStyle = "rgba(252, 211, 77, 0.10)";
  ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * BURST waveform — aggressive, multi-frequency, fading over 3s
 */
function drawBurst(ctx, width, height, elapsed) {
  const progress   = Math.min(elapsed / BURST_DURATION, 1);       // 0→1 over 3s
  const amplitude  = height * 0.38 * (1 - progress * 0.52);       // decays as it stabilises
  const glow       = BURST_GLOW * (1 - progress * 0.6);
  const t          = elapsed / 1000;

  ctx.strokeStyle = "#FCD34D";
  ctx.lineWidth   = 2.5;
  ctx.shadowBlur  = glow;
  ctx.shadowColor = "#FCD34D";
  ctx.beginPath();

  const steps = Math.max(200, width);
  for (let i = 0; i <= steps; i++) {
    const px = i / steps;
    const x  = px * width;

    // Layered frequencies — creates complex "engine noise" feel
    let y = height / 2;
    y += Math.sin(px * 22 + t * 5.2) * amplitude * 0.45;
    y += Math.sin(px * 7  + t * 2.8) * amplitude * 0.28;
    y += Math.sin(px * 40 + t * 9.0) * amplitude * 0.14;
    y += Math.sin(px * 3  + t * 1.5) * amplitude * 0.13;

    // Sharp impulse spikes in the first 1.5s
    if (progress < 0.5) {
      const spike = Math.sin(px * 60 + t * 4);
      if (spike > 0.88) y -= amplitude * 0.45 * (1 - progress * 2);
      if (spike < -0.88) y += amplitude * 0.35 * (1 - progress * 2);
    }

    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  }

  ctx.stroke();
  ctx.shadowBlur = 0;
}

/**
 * LIVE waveform — reads from the Web Audio AnalyserNode.
 * Falls back to a smooth simulated wave if analyser not ready yet.
 */
function drawLive(ctx, width, height, analyser, t) {
  ctx.strokeStyle = "#FCD34D";
  ctx.lineWidth   = 2.5;
  ctx.shadowBlur  = LIVE_GLOW;
  ctx.shadowColor = "#FCD34D";
  ctx.beginPath();

  if (analyser) {
    const bufLen = analyser.frequencyBinCount;
    const data   = new Uint8Array(bufLen);
    analyser.getByteTimeDomainData(data);

    const sliceW = width / bufLen;
    for (let i = 0; i < bufLen; i++) {
      const v = data[i] / 128.0;
      const y = (v * height) / 2;
      if (i === 0) ctx.moveTo(0, y);
      else         ctx.lineTo(i * sliceW, y);
    }
    ctx.lineTo(width, height / 2);
  } else {
    // Smooth fallback while analyser initialises
    const amp = height * 0.15;
    const steps = Math.max(200, width);
    for (let i = 0; i <= steps; i++) {
      const px = i / steps;
      const x  = px * width;
      const y  = height / 2 + Math.sin(px * 14 + t * 3) * amp * 0.6
                             + Math.sin(px * 5  + t * 1.8) * amp * 0.4;
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
  ctx.shadowBlur = 0;
}

/**
 * STOPPING waveform — spike (0–300ms) then exponential decay (300–1000ms)
 */
function drawStopping(ctx, width, height, elapsed, t) {
  let amplitude;
  if (elapsed < STOP_SPIKE_MS) {
    // Rise to spike
    const p = elapsed / STOP_SPIKE_MS;
    amplitude = height * 0.32 * Math.sin(p * Math.PI); // bell curve peak
  } else {
    // Exponential decay
    const p = (elapsed - STOP_SPIKE_MS) / (STOP_TOTAL_MS - STOP_SPIKE_MS);
    amplitude = height * 0.22 * Math.exp(-p * 4);
  }

  const glow = (amplitude / (height * 0.32)) * LIVE_GLOW;

  ctx.strokeStyle = "#FCD34D";
  ctx.lineWidth   = 2;
  ctx.shadowBlur  = glow;
  ctx.shadowColor = "#FCD34D";
  ctx.beginPath();

  const steps = Math.max(200, width);
  for (let i = 0; i <= steps; i++) {
    const px = i / steps;
    const x  = px * width;
    const y  = height / 2
               + Math.sin(px * 12 + t * 6) * amplitude * 0.65
               + Math.sin(px * 4  + t * 2) * amplitude * 0.35;
    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  }

  ctx.stroke();
  ctx.shadowBlur = 0;
}

/**
 * IDLE ECG — calm cardiac-trace animation @ 20fps
 */
function drawIdleECG(ctx, width, height, phase) {
  ctx.strokeStyle = "#FCD34D";
  ctx.lineWidth   = 2;
  ctx.shadowBlur  = 8;
  ctx.shadowColor = "#FCD34D";
  ctx.beginPath();

  const steps    = Math.max(100, Math.floor(width / 5));
  const sliceW   = width / steps;

  for (let i = 0; i < steps; i++) {
    const x  = i * sliceW;
    const nx = i / steps;   // 0→1
    let y    = height / 2;

    const pos = nx % 0.25;
    if (pos < 0.05)                      y += Math.sin((pos / 0.05) * Math.PI) * 15;
    else if (pos >= 0.08 && pos < 0.12) {
      const q = (pos - 0.08) / 0.04;
      if      (q < 0.3) y -= 30;
      else if (q < 0.7) y += 80 * Math.sin((q - 0.3) / 0.4 * Math.PI);
      else               y -= 20;
    } else if (pos >= 0.15 && pos < 0.22) {
      y += Math.sin(((pos - 0.15) / 0.07) * Math.PI) * 25;
    }

    y += Math.sin(phase + i * 0.1) * 2;

    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  }

  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ─── Component ────────────────────────────────────────────
export default function AudioWaveform({
  audioContext,
  analyser,
  isRecording = false,
  anomalies   = [],
  duration    = 0,
  onAnomalyDetected
}) {
  const canvasRef  = useRef(null);
  const rafRef     = useRef(null);
  const timerRef   = useRef(null);
  const mountedRef = useRef(true);

  // All animation state in refs — zero re-renders from animation
  const waveStateRef     = useRef('idle');   // 'idle'|'burst'|'live'|'stopping'
  const stateStartRef    = useRef(0);
  const idlePhaseRef     = useRef(0);
  const analyserRef      = useRef(analyser); // mirror prop into ref

  // Keep analyser ref in sync with prop without restarting the loop
  useEffect(() => { analyserRef.current = analyser; }, [analyser]);

  // ── State machine logic ──────────────────────────────────
  useEffect(() => {
    if (isRecording) {
      // Instant: switch to BURST
      waveStateRef.current  = 'burst';
      stateStartRef.current = performance.now();

      // After 3s: transition to LIVE
      timerRef.current = setTimeout(() => {
        if (mountedRef.current && waveStateRef.current === 'burst') {
          waveStateRef.current  = 'live';
          stateStartRef.current = performance.now();
        }
      }, BURST_DURATION);

      return () => clearTimeout(timerRef.current);
    } else {
      // Only animate stop if we were actually recording
      if (waveStateRef.current === 'burst' || waveStateRef.current === 'live') {
        waveStateRef.current  = 'stopping';
        stateStartRef.current = performance.now();

        timerRef.current = setTimeout(() => {
          if (mountedRef.current) {
            waveStateRef.current  = 'idle';
            stateStartRef.current = performance.now();
          }
        }, STOP_TOTAL_MS);

        return () => clearTimeout(timerRef.current);
      }
    }
  }, [isRecording]);

  // ── Single animation loop — runs forever, changes draw fn per state ──────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    mountedRef.current = true;
    const ctx = canvas.getContext('2d');

    // HiDPI canvas setup
    const resize = () => {
      const parent = canvas.parentElement;
      const dpr    = window.devicePixelRatio || 1;
      canvas.width  = parent.clientWidth  * dpr;
      canvas.height = parent.clientHeight * dpr;
      canvas.style.width  = parent.clientWidth  + 'px';
      canvas.style.height = parent.clientHeight + 'px';
      ctx.scale(dpr, dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    let throttleTimeout = null;

    const tick = () => {
      if (!mountedRef.current) return;

      const dpr    = window.devicePixelRatio || 1;
      const width  = canvas.width  / dpr;
      const height = canvas.height / dpr;
      const now    = performance.now();
      const state  = waveStateRef.current;
      const elapsed = now - stateStartRef.current;
      const t       = now / 1000; // time in seconds for phase

      clearCanvas(ctx, width, height);
      drawGrid(ctx, width, height);

      switch (state) {
        case 'burst':
          drawBurst(ctx, width, height, elapsed);
          rafRef.current = requestAnimationFrame(tick); // 60fps
          break;

        case 'live':
          drawLive(ctx, width, height, analyserRef.current, t);
          rafRef.current = requestAnimationFrame(tick); // 60fps
          break;

        case 'stopping':
          drawStopping(ctx, width, height, elapsed, t);
          if (elapsed < STOP_TOTAL_MS) {
            rafRef.current = requestAnimationFrame(tick); // 60fps during animation
          } else {
            // Animation done — switch to idle and start throttled loop
            waveStateRef.current  = 'idle';
            stateStartRef.current = performance.now();
            throttleTimeout = setTimeout(() => {
              if (mountedRef.current) rafRef.current = requestAnimationFrame(tick);
            }, IDLE_FRAME_MS);
          }
          break;

        case 'idle':
        default:
          drawIdleECG(ctx, width, height, idlePhaseRef.current);
          idlePhaseRef.current += 0.15;
          if (idlePhaseRef.current > Math.PI * 2) idlePhaseRef.current = 0;
          // Throttle to 20fps
          throttleTimeout = setTimeout(() => {
            if (mountedRef.current) rafRef.current = requestAnimationFrame(tick);
          }, IDLE_FRAME_MS);
          break;
      }
    };

    // Kick off the loop
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      mountedRef.current = false;
      if (rafRef.current)     cancelAnimationFrame(rafRef.current);
      if (throttleTimeout)    clearTimeout(throttleTimeout);
      if (timerRef.current)   clearTimeout(timerRef.current);
      window.removeEventListener('resize', resize);
    };
  }, []); // ← empty deps: single loop, reads state from refs

  // ── Anomaly alert tone ───────────────────────────────────
  useEffect(() => {
    if (anomalies.length > 0 && onAnomalyDetected) {
      const latest = anomalies[anomalies.length - 1];
      try {
        const ac  = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ac.createOscillator();
        const g   = ac.createGain();
        const freq = { low: 440, medium: 587, high: 784, critical: 988 };
        osc.type = 'sine';
        osc.frequency.value = freq[latest.severity] || 440;
        g.gain.setValueAtTime(0.3, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.01, ac.currentTime + 0.5);
        osc.connect(g); g.connect(ac.destination);
        osc.start(ac.currentTime); osc.stop(ac.currentTime + 0.5);
      } catch (_) {}
      onAnomalyDetected(latest);
    }
  }, [anomalies.length]);

  // ── Render ───────────────────────────────────────────────
  return (
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} className="w-full h-full rounded-xl" />

      {/* Recording pulse ring — visible only during active states */}
      {isRecording && (
        <motion.div
          className="absolute inset-0 rounded-xl pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.15, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          style={{ border: '1px solid #FCD34D' }}
        />
      )}

      {/* Monitoring badge */}
      {!isRecording && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="absolute top-2 md:top-4 right-2 md:right-4"
        >
          <div className="flex items-center gap-1.5 md:gap-2 backdrop-blur-md bg-yellow-300/10 border border-yellow-300/30 rounded-lg px-2 md:px-3 py-1 md:py-2">
            <motion.div
              animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            >
              <Activity className="w-3 h-3 md:w-4 md:h-4 text-yellow-300" />
            </motion.div>
            <span className="text-[10px] md:text-xs text-yellow-300 font-medium">Monitoring</span>
          </div>
        </motion.div>
      )}

      {/* RECORDING active badge */}
      {isRecording && (
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="absolute top-2 md:top-4 right-2 md:right-4"
        >
          <div className="flex items-center gap-1.5 backdrop-blur-md bg-red-500/10 border border-red-500/40 rounded-lg px-2 md:px-3 py-1 md:py-2">
            <motion.div
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 0.8, repeat: Infinity }}
              className="w-2 h-2 rounded-full bg-red-500"
            />
            <span className="text-[10px] md:text-xs text-red-400 font-medium tracking-widest uppercase">Live</span>
          </div>
        </motion.div>
      )}

      {/* Anomaly legend */}
      {anomalies.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-2 md:mt-4 flex flex-wrap gap-2 md:gap-3"
        >
          {['low', 'medium', 'high', 'critical'].map((sev) => {
            const count = anomalies.filter(a => a.severity === sev).length;
            if (!count) return null;
            const colors = { low: 'bg-green-500', medium: 'bg-yellow-500', high: 'bg-orange-500', critical: 'bg-red-500' };
            return (
              <div key={sev} className="flex items-center gap-1.5 md:gap-2">
                <div className={`w-2 h-2 md:w-3 md:h-3 rounded-full ${colors[sev]} animate-pulse`} />
                <span className="text-[10px] md:text-xs text-gray-400 capitalize">{sev}: {count}</span>
              </div>
            );
          })}
          <div className="flex items-center gap-1.5 md:gap-2 ml-auto">
            <AlertTriangle className="w-3 h-3 md:w-4 md:h-4 text-yellow-400" />
            <span className="text-[10px] md:text-xs text-yellow-400 hidden md:inline">Audio alerts enabled</span>
          </div>
        </motion.div>
      )}
    </div>
  );
}