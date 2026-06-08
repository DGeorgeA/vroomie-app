import { performance } from 'perf_hooks';
import { DTW_FINGERPRINTS } from '../src/data/dtwFingerprints_v3.js';
// We simulate the worker's DTW loop to audit its pure JS performance
// This isolates the mathematical and logic overhead from the browser environment.

function computeDTW(seqA, seqB) {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return Infinity;
  
  const dtw = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  dtw[0][0] = 0;
  const window = Math.max(Math.abs(n - m), 2);
  
  for (let i = 1; i <= n; i++) {
    const start = Math.max(1, i - window);
    const end = Math.min(m, i + window);
    for (let j = start; j <= end; j++) {
      let sum = 0;
      const dims = Math.min(seqA[i - 1].length, seqB[j - 1].length, 14);
      for (let k = 0; k < dims; k++) {
        const diff = seqA[i - 1][k] - seqB[j - 1][k];
        sum += diff * diff;
      }
      const cost = Math.sqrt(sum);
      dtw[i][j] = cost + Math.min(
        dtw[i - 1][j],
        dtw[i][j - 1],
        dtw[i - 1][j - 1]
      );
    }
  }
  return dtw[n][m] / (n + m);
}

async function runAudit() {
  console.log("Starting E2E Pipeline Performance Audit...");
  
  // 1. Data Type Integrity Check
  console.log("Checking Payload parsing integrity...");
  if (!Array.isArray(DTW_FINGERPRINTS)) throw new Error("Fingerprints is not an array");
  if (DTW_FINGERPRINTS.length === 0) throw new Error("No fingerprints loaded");
  console.log(`Loaded ${DTW_FINGERPRINTS.length} fingerprints.`);
  
  // Create a simulated 18-dim standardized live sequence
  const liveSeq = Array.from({length: 50}, () => new Float32Array(18).fill(Math.random()));

  const CYCLES = 1000;
  const latencies = [];
  let rejectNegativeCount = 0;
  let rejectAmbiguousCount = 0;
  let acceptCount = 0;

  console.log(`Simulating ${CYCLES} evaluation cycles...`);

  const startTotal = performance.now();

  for (let c = 0; c < CYCLES; c++) {
    const startCycle = performance.now();
    
    const posResults = [];
    const negResults = [];

    // DTW vs All
    for (const ref of DTW_FINGERPRINTS) {
      if (!ref.dtw_sequence || ref.dtw_sequence.length === 0) continue;
      const dist = computeDTW(liveSeq, ref.dtw_sequence);
      if (ref.fault_type === 'negative_rejection') {
        negResults.push({ ref, dist });
      } else {
        posResults.push({ ref, dist });
      }
    }

    posResults.sort((a, b) => a.dist - b.dist);
    negResults.sort((a, b) => a.dist - b.dist);

    const bestPosDist = posResults.length > 0 ? posResults[0].dist : Infinity;
    const bestNegDist = negResults.length > 0 ? negResults[0].dist : Infinity;

    // Gating Logic
    if (bestNegDist < bestPosDist) {
      rejectNegativeCount++;
    } else if (bestNegDist < Infinity && (bestPosDist / bestNegDist) > 0.8) {
      rejectAmbiguousCount++;
    } else {
      acceptCount++;
    }

    const endCycle = performance.now();
    latencies.push(endCycle - startCycle);
  }

  const endTotal = performance.now();
  const totalTime = endTotal - startTotal;
  const avgLatency = totalTime / CYCLES;
  const maxLatency = Math.max(...latencies);

  console.log("\n--- Audit Results ---");
  console.log(`Total Time: ${totalTime.toFixed(2)}ms`);
  console.log(`Average Cycle Latency: ${avgLatency.toFixed(2)}ms`);
  console.log(`Maximum Cycle Latency: ${maxLatency.toFixed(2)}ms`);
  console.log(`Negative Rejects: ${rejectNegativeCount}`);
  console.log(`Ambiguous Rejects: ${rejectAmbiguousCount}`);
  console.log(`Accepts: ${acceptCount}`);

  if (avgLatency > 50) {
    console.error(`❌ FAILURE: Average latency (${avgLatency.toFixed(2)}ms) exceeds 50ms budget.`);
    process.exit(1);
  } else {
    console.log(`✅ SUCCESS: Pipeline performance is well within the 50ms budget.`);
  }
}

runAudit().catch(console.error);
