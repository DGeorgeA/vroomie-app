/**
 * compute_and_embed_fingerprints.cjs
 *
 * Downloads ALL WAV files from Supabase, generates V6 log10 fingerprints,
 * and writes them to a JS file embedded directly in the client bundle.
 * 
 * This bypasses Supabase RLS (anon key cannot write to storage).
 * The embedded fingerprints are loaded instantly with zero network requests.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const BUCKET = 'anomaly-patterns';
const OUTPUT = path.join(__dirname, '..', 'src', 'data', 'embeddedFingerprints.js');

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── V6 FFT constants — MUST match AudioV6_Calibrator.worker.js EXACTLY ──────
const TARGET_SR  = 44100;
const FFT_SIZE   = 4096;
const HOP        = FFT_SIZE >> 1;
const BIN_4KHZ   = Math.round(4000  * FFT_SIZE / TARGET_SR); // 371
const BIN_12KHZ  = Math.round(12000 * FFT_SIZE / TARGET_SR); // 1114
const VECTOR_LEN = BIN_12KHZ - BIN_4KHZ;                     // 743
const SS_ALPHA   = 1.5;
const SS_BETA    = 0.01;

// ── WAV Parser (robust — handles float32 + non-standard headers) ──────────────
function parseWav(buffer) {
  const RIFF = buffer.slice(0,4).toString('ascii');
  if (RIFF !== 'RIFF') throw new Error(`Not a WAV: got "${RIFF}"`);

  const audioFormat   = buffer.readUInt16LE(20);
  const numChannels   = buffer.readUInt16LE(22);
  const sampleRate    = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);

  if (audioFormat !== 1 && audioFormat !== 3)
    throw new Error(`Unsupported format ${audioFormat}`);

  // Scan ALL chunks to find 'data' (handles fmt size=18, fact chunks, etc.)
  let pos = 12, dataPos = -1;
  while (pos < buffer.length - 8) {
    const id = buffer.slice(pos, pos+4).toString('ascii');
    let   sz = buffer.readUInt32LE(pos + 4);
    if (id === 'data') { dataPos = pos + 8; break; }
    if (sz === 0 || sz > buffer.length) sz = 4; // sentinel — skip 4 bytes
    pos += 8 + sz + (sz % 2); // WAV chunks are padded to even byte boundary
  }

  if (dataPos < 0) throw new Error('data chunk not found');

  const bytesPerSample = bitsPerSample >> 3;
  const dataLen        = buffer.length - dataPos;
  const numSamples     = Math.floor(dataLen / (bytesPerSample * numChannels));
  if (numSamples <= 0) throw new Error(`No samples: dataPos=${dataPos}`);

  const out = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    let mono = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const bp = dataPos + (i * numChannels + ch) * bytesPerSample;
      if (bp + bytesPerSample > buffer.length) break;
      let s = 0;
      if (audioFormat === 3 && bitsPerSample === 32) s = buffer.readFloatLE(bp);
      else if (bitsPerSample === 16) s = buffer.readInt16LE(bp) / 32768.0;
      else if (bitsPerSample === 24) {
        const b0=buffer[bp],b1=buffer[bp+1],b2=buffer[bp+2];
        let v=(b2<<16)|(b1<<8)|b0; if(v>=0x800000)v-=0x1000000; s=v/8388608.0;
      } else if (bitsPerSample === 8) s=(buffer[bp]-128)/128.0;
      mono += s;
    }
    out[i] = mono / numChannels;
  }
  return { samples: out, sampleRate, numChannels, bitsPerSample, numSamples };
}

// ── Resampler ─────────────────────────────────────────────────────────────────
function resample(sig, fromSR, toSR) {
  if (fromSR === toSR) return sig;
  const ratio  = fromSR / toSR;
  const newLen = Math.floor(sig.length / ratio);
  const out    = new Float64Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio, lo = Math.floor(idx), hi = Math.min(lo+1, sig.length-1);
    out[i] = sig[lo] * (1-(idx-lo)) + sig[hi] * (idx-lo);
  }
  return out;
}

// ── Hanning window ─────────────────────────────────────────────────────────────
function applyHanning(signal) {
  const out = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++)
    out[i] = signal[i] * (0.5 * (1 - Math.cos((2*Math.PI*i)/(FFT_SIZE-1))));
  return out;
}

// ── FFT ───────────────────────────────────────────────────────────────────────
function fft(signal) {
  const N = FFT_SIZE;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < Math.min(signal.length, N); i++) re[i] = signal[i];
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2*Math.PI/len, wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < len/2; k++) {
        const uRe=re[i+k], uIm=im[i+k];
        const vRe=re[i+k+len/2]*cRe-im[i+k+len/2]*cIm, vIm=re[i+k+len/2]*cIm+im[i+k+len/2]*cRe;
        re[i+k]=uRe+vRe; im[i+k]=uIm+vIm; re[i+k+len/2]=uRe-vRe; im[i+k+len/2]=uIm-vIm;
        const nRe=cRe*wRe-cIm*wIm; cIm=cRe*wIm+cIm*wRe; cRe=nRe;
      }
    }
  }
  return { re, im };
}

// ── Generate V6 cosine_vec — IDENTICAL to worker ──────────────────────────────
function generateCosineVec(samples, inputSR) {
  let s = inputSR !== TARGET_SR ? resample(samples, inputSR, TARGET_SR) : samples;
  
  // Peak normalize
  let mx = 0; for (let i=0;i<s.length;i++) { const a=Math.abs(s[i]); if(a>mx) mx=a; }
  if (mx < 1e-9) return null;
  const norm = new Float64Array(s.length);
  for (let i=0;i<s.length;i++) norm[i] = s[i]/mx;

  // Noise profile (first 100ms)
  const NOISE_LEN = Math.round(TARGET_SR*0.1);
  const noiseM    = new Float64Array(FFT_SIZE>>1);
  let nf = 0;
  for (let off=0; off+FFT_SIZE<=NOISE_LEN&&off+FFT_SIZE<=norm.length; off+=HOP) {
    const { re, im } = fft(applyHanning(norm.subarray(off,off+FFT_SIZE)));
    for (let i=0;i<FFT_SIZE>>1;i++) noiseM[i] += Math.sqrt(re[i]*re[i]+im[i]*im[i]);
    nf++;
  }
  if (nf>0) for (let i=0;i<FFT_SIZE>>1;i++) noiseM[i]/=nf;

  // Accumulate log10(cleanMag) — same as V6 processFrame()
  const accum = new Float64Array(VECTOR_LEN);
  let fc = 0;
  for (let off=0; off+FFT_SIZE<=norm.length; off+=HOP) {
    const slice = norm.subarray(off,off+FFT_SIZE);
    let maxS=0; for(const v of slice){const a=Math.abs(v);if(a>maxS)maxS=a;}
    if(maxS>0.98) continue; // skip clipped

    const { re, im } = fft(applyHanning(slice));
    for (let i=BIN_4KHZ; i<BIN_12KHZ; i++) {
      const raw   = Math.sqrt(re[i]*re[i]+im[i]*im[i]);
      const rawP  = raw*raw, nP = noiseM[i]*noiseM[i];
      const cleanP = Math.max(rawP - SS_ALPHA*nP, SS_BETA*rawP);
      accum[i-BIN_4KHZ] += Math.log10(Math.max(Number.EPSILON, Math.sqrt(cleanP)));
    }
    fc++;
  }

  if (fc < 2) return null;
  return Array.from(accum).map(v => v/fc);
}

// ── Metadata derivation ───────────────────────────────────────────────────────
function deriveMetadata(baseName) {
  const b = baseName.toLowerCase();
  let fault_type = 'unknown', severity = 'high';

  if (b.includes('critical')) severity = 'critical';
  else if (b.includes('medium')||b.includes('moderate')) severity = 'medium';
  else if (b.includes('low')) severity = 'low';

  if (b.includes('alternator')||(b.includes('bearing')&&!b.includes('water'))) fault_type='alternator_bearing_fault';
  else if (b.includes('intake')||b.includes('leak')) fault_type='intake_leak';
  else if (b.includes('water_pump')||b.includes('waterpump')) fault_type='water_pump';
  else if (b.includes('motor')||b.includes('starter')) fault_type='motor_starter';
  else if (b.includes('piston')||b.includes('knock')) fault_type='piston_knock';
  else if (b.includes('serpentinebelt')||b.includes('serpentine')||(b.includes('belt')&&!b.includes('power'))) fault_type='serpentine_belt';
  else if (b.includes('power_steering')||b.includes('powersteeringpump')||b.includes('powersteer')) fault_type='power_steering';
  else if (b.includes('timing')||b.includes('chain')) fault_type='timing_chain';
  else if (b.includes('rocker')||b.includes('valve')) fault_type='rocker_valve';
  else if (b.includes('low_oil')||b.includes('oil')) fault_type='low_oil';

  // Display label: clean up the filename to readable form
  const displayLabel = baseName
    .replace(/_failure_type_\d+$/, '')
    .replace(/_failure_0*\d+$/, '')
    .replace(/_\d+$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();

  return { label: displayLabel, fault_type, severity };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('📥 Fetching WAV files from Supabase...');
  const { data: files, error } = await sb.storage.from(BUCKET).list('', { limit: 500 });
  if (error) { console.error('List error:', error.message); process.exit(1); }

  const wavFiles = files.filter(f => f.name.toLowerCase().endsWith('.wav'));
  console.log(`Processing ${wavFiles.length} WAV files → embedding into client bundle\n`);

  const results = [];
  let ok=0, fail=0;

  for (const f of wavFiles) {
    const baseName = f.name.replace(/\.wav$/i, '');
    process.stdout.write(`⚙️  ${f.name.padEnd(60)} `);

    try {
      const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(f.name);
      if (dlErr || !blob) { console.log('❌ download fail'); fail++; continue; }

      const abuf = await blob.arrayBuffer();
      const buf  = Buffer.from(abuf);

      let parsed;
      try {
        parsed = parseWav(buf);
      } catch(e) {
        // Try assuming standard 44-byte PCM header as fallback
        try {
          const sr   = buf.readUInt32LE(24);
          const ch   = buf.readUInt16LE(22);
          const bits = buf.readUInt16LE(34);
          const bps  = bits >> 3;
          const skip = 44;
          const ns   = Math.floor((buf.length - skip) / (bps * ch));
          if (ns <= 0) throw new Error('zero samples');
          const samples = new Float64Array(ns);
          for (let i=0;i<ns;i++) {
            let m=0;
            for (let c=0;c<ch;c++) {
              const bp = skip+(i*ch+c)*bps;
              if (bits===16) m+=buf.readInt16LE(bp)/32768;
              else if(bits===8) m+=(buf[bp]-128)/128;
            }
            samples[i]=m/ch;
          }
          parsed = { samples, sampleRate: sr, numChannels: ch, bitsPerSample: bits, numSamples: ns };
        } catch(e2) {
          console.log(`❌ parse fail: ${e.message}`); fail++; continue;
        }
      }

      const vec = generateCosineVec(parsed.samples, parsed.sampleRate);
      if (!vec) { console.log('❌ too short'); fail++; continue; }

      const negCount = vec.filter(v=>v<0).length;
      const mean = vec.reduce((a,b)=>a+b,0)/vec.length;
      const { label, fault_type, severity } = deriveMetadata(baseName);

      console.log(`✅ mean=${mean.toFixed(3)} neg=${negCount}/${vec.length} type=${fault_type}`);

      results.push({
        id: baseName,
        label,
        fault_type,
        severity,
        source_file: f.name,
        cosine_vec: vec.map(v => parseFloat(v.toFixed(6))), // 6dp precision = sufficient
      });
      ok++;
    } catch(e) {
      console.log(`❌ ${e.message}`); fail++;
    }
  }

  console.log(`\n✅ ${ok} fingerprints generated, ❌ ${fail} failed`);

  // Write JS module
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const js = `/**
 * embeddedFingerprints.js — AUTO-GENERATED by compute_and_embed_fingerprints.cjs
 * 
 * Pipeline: v6-log10-exact
 * Vector space: log10(cleanMag), bins [${BIN_4KHZ}–${BIN_12KHZ}] = ${VECTOR_LEN} dims at ${TARGET_SR}Hz/FFT${FFT_SIZE}
 * All values are negative (log10 space). Cosine similarity with V6 worker output.
 * 
 * Generated: ${new Date().toISOString()}
 * Sources: ${ok} WAV files from Supabase anomaly-patterns bucket
 * 
 * DO NOT EDIT MANUALLY. Regenerate with: node scripts/compute_and_embed_fingerprints.cjs
 */

export const EMBEDDED_FINGERPRINTS = ${JSON.stringify(results, null, 0)};
`;

  fs.writeFileSync(OUTPUT, js, 'utf8');
  console.log(`\n📦 Written: ${OUTPUT}`);
  console.log(`   Size: ${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB`);

  // Print fault type distribution
  const byType = {};
  results.forEach(r => { byType[r.fault_type] = (byType[r.fault_type]||0)+1; });
  console.log('\nFault type distribution:');
  Object.entries(byType).sort((a,b)=>b[1]-a[1]).forEach(([t,c])=>console.log(`  ${String(c).padStart(3)}x  ${t}`));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
