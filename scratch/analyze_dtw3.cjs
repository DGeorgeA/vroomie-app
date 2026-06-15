const fs = require('fs');

const path = 'C:/Users/Deepak G A/DGeorgeA/vroomie-app/src/data/dtwFingerprints.js';
const data = fs.readFileSync(path, 'utf8');

const jsonStr = data.substring(data.indexOf('['), data.lastIndexOf(']') + 1);
const fingerprints = JSON.parse(jsonStr);

function euclideanDistance(vecA, vecB) {
  let sum = 0;
  const dims = Math.min(vecA.length, vecB.length, 14);
  for (let i = 0; i < dims; i++) {
    const diff = vecA[i] - vecB[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function computeDTW(seqA, seqB) {
  const n = seqA.length;
  const m = seqB.length;
  const dtw = Array.from({length: n + 1}, () => new Float32Array(m + 1).fill(Infinity));
  dtw[0][0] = 0;
  const window = Math.max(Math.abs(n - m), 2);
  for (let i = 1; i <= n; i++) {
    const start = Math.max(1, i - window);
    const end = Math.min(m, i + window);
    for (let j = start; j <= end; j++) {
      const cost = euclideanDistance(seqA[i - 1], seqB[j - 1]);
      dtw[i][j] = cost + Math.min(dtw[i - 1][j], dtw[i][j - 1], dtw[i - 1][j - 1]);
    }
  }
  return dtw[n][m] / (n + m);
}

// Generate Noise (tiny variance, like room hum)
const roomHum = Array.from({length: 50}, () => {
  const arr = new Float32Array(14);
  for (let i=0; i<14; i++) {
    let u = 0, v = 0;
    while(u === 0) u = Math.random();
    while(v === 0) v = Math.random();
    // Multiply by 0.05 to simulate tiny room hum
    arr[i] = 0.05 * Math.sqrt( -2.0 * Math.log( u ) ) * Math.cos( 2.0 * Math.PI * v );
  }
  return arr;
});

function standardize(seq) {
  const stdSeq = Array.from({length: 50}, () => new Float32Array(14));
  for (let d = 0; d < 14; d++) {
    let sum = 0, sumSq = 0;
    for (let f = 0; f < 50; f++) {
      sum += seq[f][d];
      sumSq += seq[f][d] * seq[f][d];
    }
    const mean = sum / 50;
    // TEST 1: Math.max(1.0, std) -> THIS CAUSES COLLAPSE
    // TEST 2: Math.max(1e-5, std) -> DOES THIS FIX IT?
    const std = Math.max(1e-5, Math.sqrt(Math.max(0, (sumSq / 50) - mean * mean)));
    for (let f = 0; f < 50; f++) {
      stdSeq[f][d] = (seq[f][d] - mean) / std;
    }
  }
  return stdSeq;
}

const stdHum = standardize(roomHum);

for (const fp of fingerprints) {
  const dist = computeDTW(stdHum, fp.dtw_sequence);
  console.log(`${fp.id}: StdHum Dist = ${dist.toFixed(3)}`);
}
