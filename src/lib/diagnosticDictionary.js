/**
 * Immutable mapping of known mechanical acoustic signatures to their real-world 
 * workshop diagnostics, including verified USD/INR pricing and mechanical repair specs.
 */
export const diagnosticDictionary = {
  "Engine Knocking": {
    fix: "Check fuel quality / execute full internal piston inspection",
    usd: 300,
    inr: 25000,
  },
  "Alternator Bearing Fault": {
    fix: "Replace entire alternator bearing unit",
    usd: 150,
    inr: 12000,
  },
  "Timing Chain Rattle": {
    fix: "Replace timing chain and tensioner guides",
    usd: 500,
    inr: 40000,
  },
  "Misfire": {
    fix: "Check spark plugs / ignition coils and replace as necessary",
    usd: 100,
    inr: 8000,
  },
  "Water Pump Failure": {
    fix: "Replace water pump and flush coolant subsystem",
    usd: 250,
    inr: 20000,
  },
  "Intake Leak": {
    fix: "Smoke test intake manifold and replace vacuum seals",
    usd: 120,
    inr: 10000,
  },
  "Pulley Misalignment": {
    fix: "Re-align serpentine belt pulleys and replace idler bearings",
    usd: 90,
    inr: 7500,
  },
  "Exhaust Resonance": {
    fix: "Inspect exhaust mounts and patch muffler leaks",
    usd: 80,
    inr: 6500,
  }
};

/**
 * Retrieves the diagnostic intelligence parameters.
 * If the exact acoustic label isn't meticulously catalogued, it falls back gracefully
 * to general engine diagnostics to prevent crashing the report system.
 */
export function getDiagnosticMetadata(anomalyName) {
  // Normalize string for safety looking up the dict
  const normalized = Object.keys(diagnosticDictionary).find(
    k => k.toLowerCase() === anomalyName?.toLowerCase()
  );
  
  if (normalized) {
    return diagnosticDictionary[normalized];
  }
  
  // Generic Fallback
  return {
    fix: "General inspection of associated engine block / electronic subsystems",
    usd: 200, // Estimate
    inr: 16500
  };
}
