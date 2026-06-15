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
  if (n === 0 || m === 0) return Infinity;

  const dtw = Array.from({length: n + 1}, () => new Float32Array(m + 1).fill(Infinity));
  dtw[0][0] = 0;

  const window = Math.max(Math.abs(n - m), 2);
  
  for (let i = 1; i <= n; i++) {
    const start = Math.max(1, i - window);
    const end = Math.min(m, i + window);
    for (let j = start; j <= end; j++) {
      const cost = euclideanDistance(seqA[i - 1], seqB[j - 1]);
      dtw[i][j] = cost + Math.min(
        dtw[i - 1][j],
        dtw[i][j - 1],
        dtw[i - 1][j - 1]
      );
    }
  }
  
  return dtw[n][m] / (n + m);
}

// Generate Standardized Random Noise (mean 0, var 1)
const noise = Array.from({length: 50}, () => {
  const arr = new Float32Array(14);
  for (let i=0; i<14; i++) {
    // simple Box-Muller for std normal
    let u = 0, v = 0;
    while(u === 0) u = Math.random();
    while(v === 0) v = Math.random();
    arr[i] = Math.sqrt( -2.0 * Math.log( u ) ) * Math.cos( 2.0 * Math.PI * v );
  }
  return arr;
});

for (const fp of fingerprints) {
  const dist = computeDTW(noise, fp.dtw_sequence);
  console.log(`${fp.id}: Noise Dist = ${dist.toFixed(3)}`);
}
