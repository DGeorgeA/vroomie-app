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
    fix: "Replace affected bearing assembly ΓÇö alternator, idler, or tensioner"
  },
  "Belt Issue": {
    fix: "Inspect and replace serpentine belt; check tensioner and idler pulleys"
  }
};

/**
 * Retrieves the diagnostic intelligence parameters.
 */
export function getDiagnosticMetadata(anomalyName) {
  const normalized = Object.keys(diagnosticDictionary).find(
    k => k.toLowerCase() === anomalyName?.toLowerCase()
  );
  
  if (normalized) {
    return diagnosticDictionary[normalized];
  }
  
  return {
    fix: "General inspection of associated engine block / electronic subsystems"
  };
}
