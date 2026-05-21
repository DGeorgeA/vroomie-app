import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DTW_FINGERPRINTS } from './src/data/dtwFingerprints.js';

function euclideanDistance(vecA, vecB) {
  let sum = 0;
  for (let i = 0; i < vecA.length; i++) {
    const diff = vecA[i] - vecB[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function computeDTW(seqA, seqB) {
  const n = seqA.length;
  const m = seqB.length;
  const dtw = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  dtw[0][0] = 0;
  
  // Sakoe-Chiba band (optional, but good for speed/preventing pathological warping)
  const window = Math.max(Math.abs(n - m), Math.floor(Math.max(n, m) * 0.2));
  
  for (let i = 1; i <= n; i++) {
    const start = Math.max(1, i - window);
    const end = Math.min(m, i + window);
    for (let j = start; j <= end; j++) {
      const cost = euclideanDistance(seqA[i - 1], seqB[j - 1]);
      dtw[i][j] = cost + Math.min(
        dtw[i - 1][j],    // insertion
        dtw[i][j - 1],    // deletion
        dtw[i - 1][j - 1] // match
      );
    }
  }
  
  return dtw[n][m] / (n + m); // Normalized distance
}

function runTest() {
  console.log('--- DTW OFFLINE VALIDATION ---');
  
  const piston = DTW_FINGERPRINTS.find(f => f.fault_type === 'piston_knock');
  const belt = DTW_FINGERPRINTS.find(f => f.fault_type === 'serpentine_belt');
  const power = DTW_FINGERPRINTS.find(f => f.fault_type === 'power_steering');

  if (!piston || !belt || !power) {
    console.error('Missing references!');
    return;
  }

  // Create a shifted version of piston (simulate temporal shift in mic pickup)
  const livePiston = piston.dtw_sequence.slice(5).concat(piston.dtw_sequence.slice(0, 5));
  
  console.log('Test 1: Live Piston vs Reference Piston (Self-Similarity with temporal shift)');
  const distPiston = computeDTW(livePiston, piston.dtw_sequence);
  console.log(`Distance: ${distPiston.toFixed(4)}`);
  
  console.log('\nTest 2: Live Piston vs Reference Belt (Cross-Similarity)');
  const distBelt = computeDTW(livePiston, belt.dtw_sequence);
  console.log(`Distance: ${distBelt.toFixed(4)}`);
  
  console.log('\nTest 3: Live Piston vs Reference Power Steering (Cross-Similarity)');
  const distPower = computeDTW(livePiston, power.dtw_sequence);
  console.log(`Distance: ${distPower.toFixed(4)}`);
  
  console.log('\nConclusion:');
  if (distPiston < distBelt && distPiston < distPower) {
    console.log('✅ PASS: DTW successfully aligns the shifted sequence and provides maximum separability.');
  } else {
    console.log('❌ FAIL: DTW could not separate the classes.');
  }
}

runTest();
