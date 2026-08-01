/**
 * ethanolScreening.js — Ethanol Contamination Check interpretation layer.
 *
 * ARCHITECTURAL BOUNDARY (do not cross):
 *   This module is a pure CONSUMER of the anomaly result the existing audio
 *   engine already produced. It performs NO audio capture, NO DSP, NO
 *   embedding, NO matching, and holds NO thresholds. It cannot influence
 *   detection — running it or not running it leaves the core anomaly
 *   classification bit-for-bit identical.
 *
 *   Everything here is synchronous, allocation-light and side-effect free.
 */

/**
 * Canonical fault-family IDs (the `fault_type` values already produced by the
 * reference factory and carried on every anomaly as `faultType`). Using these
 * stable IDs rather than display strings means renaming a reference file or
 * re-wording a label can never silently break the screening.
 */
export const ETHANOL_RELEVANT_FAULT_TYPES = Object.freeze([
  'piston_knock',    // Piston Knock
  'power_steering',  // Power Steering Pump
  'rocker_valve',    // Rocker Arm Valve
]);

/**
 * Fallback matcher for legacy records written before `faultType` existed.
 * Matches the display label defensively; stable IDs are always preferred.
 */
const LEGACY_LABEL_PATTERNS = Object.freeze([
  { faultType: 'piston_knock', re: /piston|knock/i },
  { faultType: 'power_steering', re: /power\s*steering/i },
  { faultType: 'rocker_valve', re: /rocker|valve/i },
]);

export const ETHANOL_STATUS = Object.freeze({
  POSSIBLE_RELEVANT_INDICATORS: 'POSSIBLE_RELEVANT_INDICATORS',
  NO_RELEVANT_AUDIO_INDICATORS: 'NO_RELEVANT_AUDIO_INDICATORS',
});

export const ETHANOL_DISCLAIMER =
  "Vroomie's Ethanol Contamination Check is an AI-assisted audio screening feature and is not a laboratory fuel test or professional mechanical diagnosis. Similar sound patterns can have causes unrelated to ethanol. A qualified vehicle inspection is required to determine the actual cause.";

/** Resolve an anomaly to its canonical family, tolerating legacy shapes. */
function resolveFaultType(anomaly) {
  if (!anomaly) return null;
  if (anomaly.faultType) return anomaly.faultType;
  const label = anomaly.rawLabel || anomaly.type || '';
  const hit = LEGACY_LABEL_PATTERNS.find(p => p.re.test(label));
  return hit ? hit.faultType : null;
}

/**
 * Screen an existing analysis result.
 *
 * @param {Array<object>} anomalies `anomalies_detected` from the analysis
 *        record — exactly as the core engine produced it.
 * @returns {{status: string, indicators: Array<{type: string, faultType: string}>, hasIndicators: boolean}}
 */
export function screenForEthanolIndicators(anomalies) {
  const list = Array.isArray(anomalies) ? anomalies : [];
  const indicators = [];
  const seen = new Set();

  for (const a of list) {
    const faultType = resolveFaultType(a);
    if (!faultType || !ETHANOL_RELEVANT_FAULT_TYPES.includes(faultType)) continue;
    if (seen.has(faultType)) continue; // list each relevant family once
    seen.add(faultType);
    indicators.push({
      type: a.type || a.rawLabel || faultType,
      faultType,
    });
  }

  return {
    status: indicators.length > 0
      ? ETHANOL_STATUS.POSSIBLE_RELEVANT_INDICATORS
      : ETHANOL_STATUS.NO_RELEVANT_AUDIO_INDICATORS,
    indicators,
    hasIndicators: indicators.length > 0,
  };
}

/**
 * Presentation copy for a screening result. Deliberately never asserts that
 * ethanol contamination was detected, and never issues a clean bill of health.
 */
export function buildEthanolScreeningCopy(result) {
  if (result.hasIndicators) {
    return {
      heading: 'POSSIBLE RELEVANT INDICATOR(S) DETECTED',
      lead: result.indicators.length === 1
        ? 'Observed sound pattern:'
        : 'Observed sound patterns:',
      explanation:
        'Vroomie detected one or more sound patterns that may be associated with mechanical conditions relevant to this screening. Audio analysis alone cannot determine whether ethanol contamination is the cause.',
      recommendation:
        'Please have the vehicle inspected by a qualified workshop at the earliest practical opportunity.',
      recommendationDetail:
        'Ask the technician to inspect the fuel system and relevant components for possible contamination, corrosion, leakage, deterioration or other mechanical causes.',
      disclaimer: ETHANOL_DISCLAIMER,
    };
  }
  return {
    heading: 'NO RELEVANT AUDIO INDICATORS DETECTED DURING THIS CHECK',
    lead: null,
    explanation:
      "This audio screening did not identify the selected sound patterns used by Vroomie's Ethanol Contamination Check.",
    recommendation:
      'This does not rule out ethanol contamination, fuel-system problems, corrosion, leakage or other vehicle issues.',
    recommendationDetail: null,
    disclaimer: ETHANOL_DISCLAIMER,
  };
}
