import { computeCompositeEmbedding, TARGET_SR } from './src/lib/audioMath.js';

// Create a pseudo-random PCM buffer (5 seconds at 16kHz)
const size = 16000 * 5;
const buffer = new Float32Array(size);
for (let i = 0; i < size; i++) {
  buffer[i] = Math.sin(2 * Math.PI * 440 * i / 16000) * 0.5 + (Math.random() - 0.5) * 0.1;
}

console.log("--- Embedding Test ---");
try {
  const start = Date.now();
  const embedding = computeCompositeEmbedding(buffer, TARGET_SR);
  const end = Date.now();

  console.log("Vector Dims:", embedding.length);
  console.log("First 5 values:", embedding.slice(0, 5));
  console.log("Last 5 values:", embedding.slice(-5));
  console.log("Time taken:", end - start, "ms");
  
  if (embedding.length === 80) {
    console.log("✅ SUCCESS: Correct dimensionality.");
  } else {
    console.error("❌ FAILURE: Wrong dimensionality:", embedding.length);
  }
} catch (err) {
  console.error("❌ ERROR running test:", err);
}
