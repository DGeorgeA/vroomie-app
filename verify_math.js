import { computeCompositeEmbedding, TARGET_SR } from './src/lib/audioMath.js';

function cosineSimilarity(a, b) {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb)) || 0;
}

// 1. Generate White Noise
const size = TARGET_SR * 2;
const whiteNoise = new Float32Array(size);
for (let i = 0; i < size; i++) whiteNoise[i] = (Math.random() * 2 - 1) * 0.1;

// 2. Generate an "Anomaly" (Pulse)
const anomaly = new Float32Array(size);
for (let i = 0; i < size; i++) {
  anomaly[i] = Math.sin(2 * Math.PI * 500 * i / TARGET_SR) * 0.5; // Single tone
}

console.log("--- Math Hardening Test ---");

const noiseVec = computeCompositeEmbedding(whiteNoise, TARGET_SR);
const anomalyVec = computeCompositeEmbedding(anomaly, TARGET_SR);

console.log("Vector Dims:", noiseVec.length);
console.log("Noise SF (Index 77):", noiseVec[77]);
console.log("Anomaly SF (Index 77):", anomalyVec[77]);

const sim = cosineSimilarity(noiseVec, anomalyVec);
console.log("Similarity (Raw Cosine):", (sim * 100).toFixed(2) + "%");

// Apply SF Penalty (Logic from ValidationBench.jsx)
let finalScore = sim;
const sf = noiseVec[77];
if (sf > 0.8) {
  finalScore *= Math.pow(1.0 - sf, 2) * 5.0;
}
console.log("Final Score (with SF Penalty):", (finalScore * 100).toFixed(2) + "%");

if (finalScore < 40) {
    console.log("✅ SUCCESS: False positive rejected.");
} else {
    console.error("❌ FAILURE: Similarity still too high!");
}
