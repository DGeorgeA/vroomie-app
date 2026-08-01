/**
 * Immutable mapping of known mechanical acoustic signatures to their real-world 
 * workshop diagnostics. Financial data (USD/INR) has been purged to eliminate liability.
 */
export const diagnosticDictionary = {
  "Engine Knocking": {
    fix: "Check fuel quality / execute full internal piston inspection"
  },
  "Alternator Bearing Fault": {
    fix: "Replace entire alternator bearing unit"
  },
  "Timing Chain Rattle": {
    fix: "Replace timing chain and tensioner guides"
  },
  "Misfire": {
    fix: "Check spark plugs / ignition coils and replace as necessary"
  },
  "Water Pump Failure": {
    fix: "Replace water pump and flush coolant subsystem"
  },
  "Intake Leak": {
    fix: "Smoke test intake manifold and replace vacuum seals"
  },
  "Pulley Misalignment": {
    fix: "Re-align serpentine belt pulleys and replace idler bearings"
  },
  "Exhaust Resonance": {
    fix: "Inspect exhaust mounts and patch muffler leaks"
  },
  "Bearing Fault": {
    fix: "Replace affected bearing assembly — alternator, idler, or tensioner"
  },
  "Belt Issue": {
    fix: "Inspect and replace serpentine belt; check tensioner and idler pulleys"
  }
};

/**
 * Retrieves the diagnostic intelligence parameters.
 */
export function getDiagnosticMetadata(anomalyName) {
  if (!anomalyName) {
    return { fix: "General inspection of associated engine block / electronic subsystems" };
  }
  // Exact match first. Engine labels are derived from reference file names
  // ("BearingAlternator", "Timing chain rattle high") and never equalled these
  // human-written keys, so an exact-only lookup always fell through to the
  // generic text. Fall back to separator-insensitive LONGEST partial match.
  const exact = Object.keys(diagnosticDictionary).find(
    k => k.toLowerCase() === anomalyName.toLowerCase()
  );
  if (exact) return diagnosticDictionary[exact];

  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
  const target = norm(anomalyName);
  let bestKey = null;
  let bestLen = -1;
  for (const k of Object.keys(diagnosticDictionary)) {
    // Match on the key's significant words in any order (e.g. "Alternator
    // Bearing Fault" <-> "BearingAlternator")
    const words = k.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.length && words.every(w => target.includes(w))) {
      const kn = norm(k);
      if (kn.length > bestLen) { bestLen = kn.length; bestKey = k; }
    }
  }
  if (bestKey) return diagnosticDictionary[bestKey];

  return {
    fix: "General inspection of associated engine block / electronic subsystems"
  };
}
