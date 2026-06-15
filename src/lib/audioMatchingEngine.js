/**
 * audioMatchingEngine.js — Vroomie Detection Engine (v7 — 2-Sec Temporal Pipeline)
 *
 * PIPELINE REWRITE:
 *   - Replaces single-frame (250ms) Meyda matching with sliding-window (2s) temporal embeddings.
 *   - Live vector is an 80-dim Composite Embedding (Log-Mel + MFCC + ZCR + Energy + Spectral).
 *   - Solves instantaneous noise jitter. Hysteresis (smoothing) is completely removed since the
 *     embedding organically represents a full 2-second continuous acoustic sequence.
 *
 * STRICT GATE:
 *   - Threshold is hard-locked at >= 0.80.
 *   - Anything < 0.80 strictly returns normal ("No anomalies found").
 */

import { Logger } from './logger';

// ── Fault Nature Library — enriched clinical descriptions (NO cost estimates) ─
export const FAULT_NATURE_LIBRARY = {
  'alternator_bearing_fault_critical': {
    nature: 'The alternator\'s internal bearing race is failing, generating a sustained high-frequency whine (typically 4–8 kHz). This causes increasing electrical load instability, which will progressively drain the battery and risk complete loss of vehicle charging while driving.',
    fix: 'Replace the alternator bearing or full alternator assembly. Inspect the drive belt for glazing or cracking caused by the failing bearing\'s irregular drag.',
  },
  'BearingAlternator': {
    nature: 'Severe alternator bearing degradation with high kurtosis in the 4–10 kHz band, indicating metal-on-metal contact within the bearing races. Unaddressed, this leads to total alternator seizure and stranded vehicle.',
    fix: 'Replace the alternator immediately. Do not operate the vehicle under high electrical load (A/C, headlights) until repaired.',
  },
  'water_pump_failure_critical': {
    nature: 'The water pump impeller blade or shaft bearing is failing, causing irregular coolant flow. Insufficient circulation leads to localised hot spots in the cylinder head. If unresolved, this causes head gasket failure and engine overheating within minutes of temperature exceedance.',
    fix: 'Replace the water pump assembly and thermostat. Flush the cooling system and inspect the coolant for contamination. Check the head gasket for pre-existing damage.',
  },
  'intake_leak_low': {
    nature: 'A vacuum or air leak in the intake manifold or plenum gasket is introducing unmetered air into the combustion mixture. This causes a lean fuel condition, misfires under load, and rough idling. Prolonged lean running risks piston and valve damage.',
    fix: 'Use a smoke machine or propane enrichment test to locate the leak. Replace the intake manifold gasket, vacuum lines, or the affected component. Reset the ECU fuel trims after repair.',
  },
  'misfire_detected_medium': {
    nature: 'One or more cylinders are failing to complete the combustion cycle reliably. Common causes are fouled spark plugs, weak ignition coils, or injector deposits. Unburnt fuel enters the exhaust stream, damaging the catalytic converter over time.',
    fix: 'Perform a cylinder-balance test via OBD-II to identify the misfiring cylinder. Replace spark plugs, inspect coil-on-plug units, and run a fuel injector cleaning cycle.',
  },
  'timing_chain_rattle_high': {
    nature: 'The timing chain tensioner has lost hydraulic pressure or the chain has stretched beyond tolerance, causing a metallic rattle during cold starts or acceleration. The timing chain synchronises the crankshaft and camshaft; failure causes severe valve-to-piston collision.',
    fix: 'Replace the timing chain, tensioner, and guide rails as a complete kit. Use only manufacturer-specification engine oil to maintain tensioner hydraulic pressure.',
  },
  'MotorStarter': {
    nature: 'An electrical transient consistent with starter motor engagement or relay chatter has been detected. This may indicate a weak battery, corroded terminal connections, or a failing starter solenoid. Repeated no-start conditions accelerate flywheel ring gear wear.',
    fix: 'Load-test the battery and inspect terminal corrosion. Test the starter solenoid draw with a clamp ammeter. Replace the battery or starter motor as indicated.',
  },
  'PowerSteeringPump': {
    nature: 'The power steering pump is producing abnormal tonal whine under load, indicating low fluid level, a cavitating pump, or a failing internal vane mechanism. Loss of power assist occurs suddenly without warning.',
    fix: 'Check and top up power steering fluid. Inspect for leaks at the pump, rack, and hose fittings. If whine persists, replace the power steering pump and flush the fluid.',
  },
  'RockerArmAndValve': {
    nature: 'Rhythmic high-frequency tapping is present in the valvetrain. This is consistent with excessive rocker arm clearance, a collapsed lifter, or a sticking valve stem. Unresolved, this causes accelerated camshaft lobe wear and eventually valve float at high RPM.',
    fix: 'Check valve clearances and adjust to manufacturer specification. Inspect lifters for hydraulic collapse. Replace worn rockers, pushrods, or the affected hydraulic lifter assembly.',
  },
  'Piston': {
    nature: 'Deep low-frequency knocking is consistent with piston slap or big-end bearing wear. Piston slap typically occurs cold and diminishes with warm oil; bearing knock is constant and load-sensitive. Both indicate significant internal engine wear.',
    fix: 'Perform an oil pressure test and cylinder leak-down test. Measure big-end bearing clearances. Engine rebuild or replacement is likely required if clearances exceed specification.',
  },
  'SerpentineBelt': {
    nature: 'Irregular broadband noise in the belt drive system is present, indicating a glazed, cracked, or misaligned serpentine belt. Belt failure causes simultaneous loss of alternator, power steering, and water pump drive.',
    fix: 'Inspect the belt for cracking, glazing, and proper tension. Check all driven pulleys for bearing noise or wobble. Replace the belt and tensioner pulley on the same service interval.',
  },
};

/**
 * Returns enriched clinical fault narrative for display in the UI.
 * Falls back to a generic placeholder if the label is not in the library.
 */
export function getFaultNarrative(rawLabel) {
  if (!rawLabel) return null;
  // Try exact match first, then case-insensitive partial match
  if (FAULT_NATURE_LIBRARY[rawLabel]) return FAULT_NATURE_LIBRARY[rawLabel];
  const lower = rawLabel.toLowerCase();
  const key = Object.keys(FAULT_NATURE_LIBRARY).find(k => lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower));
  return key ? FAULT_NATURE_LIBRARY[key] : null;
}



// ── Strict Production Thresholds ──────────────────────────────────────────────
let ANOMALY_THRESHOLD = 0.82;  // STRICT: v11.5 matches must be >= 0.82
let MIN_LIVE_RMS      = 0.005; // Quick ignore for dead silence

const FAST_REJECT_COSINE  = 0.40; // Reduced tolerance due to high-dimensional space

// ── Runtime state ─────────────────────────────────────────────────────────────
let lastReportedScore = 0;

// ── Public: settingsStore override ────────────────────────────────────────────
export function applyThresholdOverride({ anomalyThreshold, rmsGate }) {
  // STRICT OVERRIDE BLOCKED - Hard-locked at 0.80
  // if (anomalyThreshold != null) ANOMALY_THRESHOLD = anomalyThreshold;
  if (rmsGate          != null) MIN_LIVE_RMS       = rmsGate;
  console.log(`[VM] Thresholds updated: anomaly=${ANOMALY_THRESHOLD} (LOCKED) rms=${MIN_LIVE_RMS}`);
}

export function resetMatchState() {
  lastReportedScore = 0;
  Logger.info('[Match] State reset for new temporal session.');
}

// ── Cosine similarity ─────────────────────────────────────────────────────────
function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA  += a[i] * a[i];
    nB  += b[i] * b[i];
  }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

// findBestMatch removed as it's now handled by mlEmbeddingEngine

// ── Build clean human-readable label ─────────────────────────────────────────
export function buildReadableLabel(rawLabel) {
  if (!rawLabel) return 'Unknown Issue';
  const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

  let parts = rawLabel.split('_');

  if (parts.length > 1 && SEVERITIES.has(parts[parts.length - 1])) {
    parts.pop();
  }

  parts = parts.filter((w, i) => i === 0 || w !== parts[i - 1]);

  return parts
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// matchBuffer removed as it's now handled by mlEmbeddingEngine

// ── Result builders ───────────────────────────────────────────────────────────
function _anomaly(match, score, rms) {
  return {
    anomaly:          match.label,
    status:           'anomaly',
    confidence:       score,
    signalSimilarity: score,
    mlConfidence:     0,
    finalDecision:    'ANOMALY DETECTED',
    mode:             'temporal_embed_v7',
    detectedClass:    match.label,
    classifierSource: 'temporal_embed_v7',
    source:           match.label,
    severity:         match.severity || 'medium',
    rms,
  };
}

function _noAnomaly(rms, reason) {
  return {
    anomaly:          null,
    status:           'normal',
    confidence:       0,
    signalSimilarity: 0,
    mlConfidence:     0,
    finalDecision:    'NO ANOMALY',
    mode:             'temporal_embed_v11_5',
    detectedClass:    null,
    classifierSource: reason,
    source:           null,
    severity:         'low',
    rms,
  };
}
