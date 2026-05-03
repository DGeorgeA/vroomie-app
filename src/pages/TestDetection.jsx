/**
 * TestDetection.jsx — Vroomie In-App Audio Detection Accuracy Testing
 *
 * Guided testing flow:
 * 1. User selects test type (anomaly / non-anomaly)
 * 2. User plays audio near mic (or speaks, or stays silent)
 * 3. System records 4 seconds, runs matching pipeline
 * 4. Displays: Expected vs Actual, confidence, pass/fail
 * 5. Aggregates accuracy score across all runs
 *
 * Tests:
 *   TEST A: Known anomaly → must detect
 *   TEST B: Speech/music → must NOT detect
 *   TEST C: Silence → must return "No anomalies detected"
 *   TEST D: Repeated runs → must be consistent
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Mic, Square, CheckCircle2, XCircle, AlertCircle,
  FlaskConical, RefreshCw, ChevronDown, Info, Database,
  Zap, Volume2, VolumeX, Activity
} from 'lucide-react';
import { startExtraction, stopExtraction, getActiveMediaStream, getActiveAudioContext } from '@/lib/audioFeatureExtractor';
import { referenceIndex, initializeAudioDataset, refreshAudioDataset } from '@/services/audioDatasetService';
import { Logger } from '@/lib/logger';
import { toast } from 'sonner';

// ─── Test matrix definitions ─────────────────────────────────────────────────
const TEST_SCENARIOS = [
  {
    id: 'anomaly_play',
    label: 'Play Anomaly Audio Near Mic',
    type: 'anomaly',
    expected: 'ANOMALY',
    instruction: 'Play one of the anomaly clips from your Supabase bucket near your microphone (piston knock, belt squeal, bearing fault, etc.)',
    icon: '🔊',
    color: 'amber',
  },
  {
    id: 'speech',
    label: 'Speak Normally',
    type: 'normal',
    expected: 'NO ANOMALY',
    instruction: 'Speak naturally into the mic for 4 seconds (e.g., "This is a speech test for Vroomie")',
    icon: '🗣️',
    color: 'blue',
  },
  {
    id: 'silence',
    label: 'Complete Silence',
    type: 'normal',
    expected: 'NO ANOMALY',
    instruction: 'Stay completely silent for 4 seconds — no breathing into mic',
    icon: '🔇',
    color: 'purple',
  },
  {
    id: 'music',
    label: 'Play Music / Background Noise',
    type: 'normal',
    expected: 'NO ANOMALY',
    instruction: 'Play music or background noise near the mic for 4 seconds',
    icon: '🎵',
    color: 'indigo',
  },
  {
    id: 'anomaly_repeat',
    label: 'Repeat Anomaly (Consistency Check)',
    type: 'anomaly',
    expected: 'ANOMALY',
    instruction: 'Play the SAME anomaly clip again to verify consistent detection',
    icon: '🔁',
    color: 'amber',
  },
];

const RECORD_DURATION_S = 4; // seconds per test

function Badge({ color, children }) {
  const styles = {
    amber:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
    blue:   'bg-blue-500/15 text-blue-400 border-blue-500/30',
    purple: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    indigo: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
    green:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    red:    'bg-red-500/15 text-red-400 border-red-500/30',
    zinc:   'bg-zinc-700 text-zinc-400 border-zinc-600',
  };
  return (
    <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full border ${styles[color] || styles.zinc}`}>
      {children}
    </span>
  );
}

function ScoreBar({ passed, total }) {
  const pct = total > 0 ? Math.round(passed / total * 100) : 0;
  const color = pct >= 95 ? 'bg-emerald-500' : pct >= 70 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="w-full">
      <div className="flex justify-between text-xs font-mono text-zinc-400 mb-1">
        <span>{passed}/{total} passed</span>
        <span className={pct >= 95 ? 'text-emerald-400' : pct >= 70 ? 'text-amber-400' : 'text-red-400'}>
          {pct}%
        </span>
      </div>
      <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className={`h-full rounded-full ${color}`}
        />
      </div>
    </div>
  );
}

export default function TestDetection() {
  const [results, setResults] = useState([]);
  const [currentScenario, setCurrentScenario] = useState(null);
  const [phase, setPhase] = useState('select'); // 'select' | 'recording' | 'analyzing' | 'result'
  const [countdown, setCountdown] = useState(RECORD_DURATION_S);
  const [lastResult, setLastResult] = useState(null);
  const [refCount, setRefCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [dbgLog, setDbgLog] = useState([]);

  // Accumulated session anomalies from this 4-second recording
  const sessionAnomaliesRef = useRef([]);
  const countdownRef = useRef(null);
  const isRecordingRef = useRef(false);

  // Load dataset on mount
  useEffect(() => {
    initializeAudioDataset().then(() => {
      setRefCount(referenceIndex.length);
    });
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshAudioDataset().catch(console.error);
    setRefCount(referenceIndex.length);
    setRefreshing(false);
    toast.success(`Loaded ${referenceIndex.length} reference embeddings`);
  };

  const runTest = useCallback(async (scenario) => {
    if (isRecordingRef.current) return;
    if (refCount === 0) {
      toast.error('No reference embeddings loaded. Click "Refresh Refs" first.');
      return;
    }

    setCurrentScenario(scenario);
    setPhase('recording');
    setCountdown(RECORD_DURATION_S);
    setDbgLog([]);
    sessionAnomaliesRef.current = [];
    isRecordingRef.current = true;

    // Start countdown
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(countdownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    const dbgLines = [];

    try {
      await startExtraction((features) => {
        const r = features._workerResult || {};
        const line = {
          status:     r.status || 'normal',
          anomaly:    r.anomaly || null,
          confidence: r.confidence || 0,
          rms:        r.rms || 0,
        };
        dbgLines.push(line);
        setDbgLog([...dbgLines]);

        if (r.status === 'anomaly' && r.anomaly) {
          const exists = sessionAnomaliesRef.current.some(a => a.label === r.anomaly);
          if (!exists) sessionAnomaliesRef.current.push({ label: r.anomaly, confidence: r.confidence });
        }
      });

      // Auto-stop after RECORD_DURATION_S
      await new Promise(resolve => setTimeout(resolve, RECORD_DURATION_S * 1000));

      // Stop extraction
      isRecordingRef.current = false;
      setPhase('analyzing');
      clearInterval(countdownRef.current);

      stopExtraction();
      await new Promise(resolve => setTimeout(resolve, 300));

      // Evaluate result
      const detected    = sessionAnomaliesRef.current.length > 0;
      const expected    = scenario.type === 'anomaly';
      const pass        = detected === expected;
      const detectedLabel = detected
        ? sessionAnomaliesRef.current.map(a => a.label).join(', ')
        : 'No anomalies detected';
      const topConf = sessionAnomaliesRef.current.length > 0
        ? Math.max(...sessionAnomaliesRef.current.map(a => a.confidence))
        : (dbgLines.length > 0 ? Math.max(...dbgLines.map(d => d.confidence)) : 0);

      const result = {
        id:           Date.now(),
        scenario:     scenario.label,
        scenarioId:   scenario.id,
        type:         scenario.type,
        expected:     scenario.expected,
        detected:     detected ? 'ANOMALY' : 'NO ANOMALY',
        detectedLabel,
        confidence:   topConf,
        pass,
        timestamp:    new Date().toLocaleTimeString(),
        debugFrames:  dbgLines.length,
      };

      setLastResult(result);
      setResults(prev => [...prev, result]);
      setPhase('result');

    } catch (err) {
      isRecordingRef.current = false;
      clearInterval(countdownRef.current);
      stopExtraction();
      setPhase('select');
      Logger.error('Test recording failed:', err.message);
      toast.error('Recording failed: ' + err.message);
    }
  }, [refCount]);

  const resetTest = () => {
    setPhase('select');
    setCurrentScenario(null);
    setLastResult(null);
    setDbgLog([]);
  };

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  const accuracy = results.length > 0 ? Math.round(passed / results.length * 100) : null;

  const colorMap = { amber: 'border-amber-500/30 bg-amber-500/5', blue: 'border-blue-500/30 bg-blue-500/5', purple: 'border-purple-500/30 bg-purple-500/5', indigo: 'border-indigo-500/30 bg-indigo-500/5' };

  return (
    <div className="max-w-3xl mx-auto pb-20 w-full">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2.5 bg-amber-500/10 rounded-xl border border-amber-500/20">
            <FlaskConical className="w-5 h-5 text-amber-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">Test Detection</h1>
        </div>
        <p className="text-zinc-500 text-sm leading-relaxed">
          Guided accuracy validation. Run each test scenario to verify the anomaly detection pipeline.
          Target: ≥95% accuracy across all test types.
        </p>
      </div>

      {/* ── Dataset Status ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6 p-3 bg-zinc-900/60 rounded-xl border border-white/5">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-zinc-500" />
          <span className="text-sm text-zinc-400">
            Reference dataset: <span className={refCount > 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{refCount} embeddings</span>
          </span>
          {refCount === 0 && (
            <span className="text-xs text-red-400 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> Detection disabled
            </span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing || phase === 'recording'}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors text-xs font-medium disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Loading...' : 'Refresh Refs'}
        </button>
      </div>

      {/* ── Score Summary (shown after tests) ──────────────────────────────── */}
      {results.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 p-4 bg-zinc-900/60 rounded-2xl border border-white/5"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" />
              <span className="text-sm font-bold text-white">Accuracy Score</span>
            </div>
            <div className={`text-2xl font-black ${accuracy >= 95 ? 'text-emerald-400' : accuracy >= 70 ? 'text-amber-400' : 'text-red-400'}`}>
              {accuracy}%
            </div>
          </div>
          <ScoreBar passed={passed} total={results.length} />
          {accuracy >= 95 && (
            <p className="text-emerald-400 text-xs mt-2 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> Meets ≥95% production target
            </p>
          )}
          {accuracy < 95 && results.length >= 3 && (
            <p className="text-amber-400 text-xs mt-2 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> Below target — continue testing or check embedding quality
            </p>
          )}
        </motion.div>
      )}

      {/* ── Main: Recording / Result / Select ──────────────────────────────── */}
      <AnimatePresence mode="wait">

        {/* RECORDING PHASE */}
        {phase === 'recording' && currentScenario && (
          <motion.div
            key="recording"
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            className="mb-6 p-6 bg-zinc-900/80 rounded-2xl border border-red-500/20 backdrop-blur-sm"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]" />
              <span className="text-red-400 font-bold text-sm">RECORDING</span>
              <span className="ml-auto font-mono text-2xl font-black text-white">{countdown}s</span>
            </div>

            <div className={`p-4 rounded-xl border ${colorMap[currentScenario.color] || 'border-zinc-700 bg-zinc-800/50'} mb-4`}>
              <div className="text-3xl mb-2">{currentScenario.icon}</div>
              <p className="font-semibold text-white text-sm mb-1">{currentScenario.label}</p>
              <p className="text-zinc-400 text-xs leading-relaxed">{currentScenario.instruction}</p>
            </div>

            {/* Live debug frames */}
            {dbgLog.length > 0 && (
              <div className="mt-3 space-y-1 max-h-24 overflow-y-auto">
                {[...dbgLog].reverse().slice(0, 4).map((d, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px] font-mono text-zinc-500">
                    <span className={d.status === 'anomaly' ? 'text-amber-400' : d.status === 'silence' ? 'text-blue-400' : 'text-zinc-500'}>
                      {d.status.toUpperCase().padEnd(8)}
                    </span>
                    <span>conf={d.confidence.toFixed(3)}</span>
                    <span>rms={d.rms.toFixed(3)}</span>
                    {d.anomaly && <span className="text-amber-300">{d.anomaly}</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: '100%' }}
                animate={{ width: `${(countdown / RECORD_DURATION_S) * 100}%` }}
                transition={{ duration: 1, ease: 'linear' }}
                className="h-full bg-red-500 rounded-full"
              />
            </div>
          </motion.div>
        )}

        {/* ANALYZING PHASE */}
        {phase === 'analyzing' && (
          <motion.div
            key="analyzing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mb-6 p-8 bg-zinc-900/80 rounded-2xl border border-white/5 flex flex-col items-center gap-3"
          >
            <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin" />
            <p className="text-zinc-300 font-medium">Analyzing embedding match...</p>
          </motion.div>
        )}

        {/* RESULT PHASE */}
        {phase === 'result' && lastResult && (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`mb-6 p-6 rounded-2xl border backdrop-blur-sm ${
              lastResult.pass
                ? 'bg-emerald-500/5 border-emerald-500/20'
                : 'bg-red-500/5 border-red-500/20'
            }`}
          >
            <div className="flex items-center gap-3 mb-4">
              {lastResult.pass
                ? <CheckCircle2 className="w-7 h-7 text-emerald-400 flex-shrink-0" />
                : <XCircle className="w-7 h-7 text-red-400 flex-shrink-0" />
              }
              <div>
                <p className={`font-bold text-lg ${lastResult.pass ? 'text-emerald-400' : 'text-red-400'}`}>
                  {lastResult.pass ? '✅ PASS' : '❌ FAIL'}
                </p>
                <p className="text-zinc-500 text-xs">{lastResult.scenario}</p>
              </div>
              <div className="ml-auto text-right">
                <p className="text-white font-mono text-lg font-bold">
                  {(lastResult.confidence * 100).toFixed(1)}%
                </p>
                <p className="text-zinc-600 text-[10px]">confidence</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="p-3 bg-black/30 rounded-xl">
                <p className="text-zinc-600 text-[10px] uppercase tracking-widest mb-1">Expected</p>
                <Badge color={lastResult.expected === 'ANOMALY' ? 'amber' : 'blue'}>{lastResult.expected}</Badge>
              </div>
              <div className="p-3 bg-black/30 rounded-xl">
                <p className="text-zinc-600 text-[10px] uppercase tracking-widest mb-1">Detected</p>
                <Badge color={lastResult.detected === 'ANOMALY' ? 'amber' : 'blue'}>{lastResult.detected}</Badge>
              </div>
            </div>

            {lastResult.detected === 'ANOMALY' && (
              <div className="p-3 bg-black/30 rounded-xl mb-4">
                <p className="text-zinc-600 text-[10px] uppercase tracking-widest mb-1">Matched Label</p>
                <p className="text-amber-300 text-sm font-medium">{lastResult.detectedLabel}</p>
              </div>
            )}

            <p className="text-zinc-500 text-xs font-mono">
              {lastResult.debugFrames} analysis windows processed
            </p>

            <div className="flex gap-2 mt-4">
              <button
                onClick={resetTest}
                className="flex-1 py-2.5 rounded-xl bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors text-sm font-medium"
              >
                Run Another Test
              </button>
            </div>
          </motion.div>
        )}

        {/* SELECT PHASE */}
        {phase === 'select' && (
          <motion.div key="select" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <h2 className="text-sm font-bold text-zinc-400 uppercase tracking-widest mb-3 px-1">
              Select Test Scenario
            </h2>
            <div className="space-y-2">
              {TEST_SCENARIOS.map((scenario) => {
                const prevRun = results.filter(r => r.scenarioId === scenario.id);
                const lastRun = prevRun[prevRun.length - 1];
                return (
                  <motion.button
                    key={scenario.id}
                    whileHover={{ x: 2 }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => runTest(scenario)}
                    disabled={phase !== 'select' || refCount === 0}
                    style={{ touchAction: 'manipulation' }}
                    className={`w-full flex items-center gap-4 p-4 rounded-xl border transition-all text-left ${
                      colorMap[scenario.color] || 'border-zinc-800 bg-zinc-900/50'
                    } hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    <span className="text-2xl flex-shrink-0">{scenario.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-semibold text-sm leading-tight">{scenario.label}</p>
                      <p className="text-zinc-500 text-xs mt-0.5 leading-snug truncate">{scenario.instruction}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <Badge color={scenario.type === 'anomaly' ? 'amber' : 'blue'}>
                        {scenario.type === 'anomaly' ? 'ANOMALY' : 'NORMAL'}
                      </Badge>
                      {lastRun && (
                        <span className={`text-[10px] font-bold ${lastRun.pass ? 'text-emerald-400' : 'text-red-400'}`}>
                          {lastRun.pass ? '✓ PASS' : '✗ FAIL'}
                        </span>
                      )}
                    </div>
                  </motion.button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Results History Table ───────────────────────────────────────────── */}
      {results.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-8"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-zinc-400 uppercase tracking-widest px-1">Test History</h2>
            <button
              onClick={() => { setResults([]); setLastResult(null); }}
              className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              Clear
            </button>
          </div>
          <div className="bg-zinc-900/40 rounded-2xl border border-white/5 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[480px]">
                <thead>
                  <tr className="border-b border-white/5 text-zinc-500 uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5 font-medium">Scenario</th>
                    <th className="text-left px-3 py-2.5 font-medium">Expected</th>
                    <th className="text-left px-3 py-2.5 font-medium">Detected</th>
                    <th className="text-right px-4 py-2.5 font-medium">Conf</th>
                    <th className="text-center px-3 py-2.5 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence>
                    {[...results].reverse().map((r, i) => (
                      <motion.tr
                        key={r.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="border-b border-white/5 last:border-0 hover:bg-white/3 transition-colors"
                      >
                        <td className="px-4 py-3 text-zinc-300 max-w-[140px] truncate">{r.scenario}</td>
                        <td className="px-3 py-3">
                          <Badge color={r.expected === 'ANOMALY' ? 'amber' : 'blue'}>{r.expected}</Badge>
                        </td>
                        <td className="px-3 py-3">
                          <span className="text-zinc-400 text-[10px]">{r.detectedLabel.substring(0, 20)}</span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-zinc-400">
                          {(r.confidence * 100).toFixed(1)}%
                        </td>
                        <td className="px-3 py-3 text-center">
                          {r.pass
                            ? <CheckCircle2 className="w-4 h-4 text-emerald-400 mx-auto" />
                            : <XCircle className="w-4 h-4 text-red-400 mx-auto" />
                          }
                        </td>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          </div>
        </motion.div>
      )}

      {/* ── Info Box ───────────────────────────────────────────────────────── */}
      <div className="mt-8 p-4 bg-zinc-900/40 rounded-xl border border-white/5">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 text-zinc-500 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-zinc-500 space-y-1">
            <p className="font-medium text-zinc-400">How this works</p>
            <p>Each test records 4 seconds of audio, computes a 145-dimensional Log-Mel spectral embedding, and compares it against all {refCount} reference patterns using cosine similarity.</p>
            <p>A detection requires: similarity ≥ 0.72 <em>and</em> margin over 2nd-best ≥ 0.04 (dual-gate to prevent false positives).</p>
            <p>For best results, play audio samples from the Supabase bucket directly into your phone speaker near the microphone.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
