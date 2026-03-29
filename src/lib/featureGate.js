/**
 * Feature Gate — Controls access to premium features based on subscription
 */

let _isPro = false;
let _listeners = [];

export function isPro() {
  return _isPro;
}

export function setProStatus(status) {
  _isPro = !!status;
  _listeners.forEach(cb => cb(_isPro));
}

export function onProStatusChange(callback) {
  _listeners.push(callback);
  return () => {
    _listeners = _listeners.filter(cb => cb !== callback);
  };
}

/**
 * Feature definitions
 */
export const FEATURES = {
  BASIC_DETECTION: { free: true, pro: true, label: 'Basic Anomaly Detection' },
  ML_DETECTION: { free: false, pro: true, label: 'AI/ML Detection Engine' },
  SPECTROGRAM_DTW: { free: false, pro: true, label: 'Spectrogram Analysis' },
  ADVANCED_REPORTS: { free: false, pro: true, label: 'Advanced Diagnostics Reports' },
  VOICE_ALERTS: { free: true, pro: true, label: 'Voice Alerts' },
  CNN_CLASSIFIER: { free: false, pro: true, label: 'CNN Classifier' },
  HYBRID_ENGINE: { free: false, pro: true, label: 'Hybrid Fusion Engine' }
};

export function canAccess(featureKey) {
  const feature = FEATURES[featureKey];
  if (!feature) return false;
  return _isPro ? feature.pro : feature.free;
}
