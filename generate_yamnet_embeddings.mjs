import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import * as tf from '@tensorflow/tfjs';

// Configuration
const YAMNET_MODEL_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';
const supabaseUrl = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const sb = createClient(supabaseUrl, supabaseAnonKey);

const TARGET_SR = 16000;
const DURATION_S = 3; 

// Simple DSP Functions
function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio = oldSr / newSr, newLen = Math.floor(signal.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio, l = Math.floor(idx), r = Math.min(l + 1, signal.length - 1);
    out[i] = signal[l] * (1 - (idx - l)) + signal[r] * (idx - l);
  }
  return out;
}

function biquad(sig, b0, b1, b2, a1, a2) {
  const out = new Float32Array(sig.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const x0 = sig[i], y0 = b0*x0 + b1*x1 + b2*x2 - a1*y1 - a2*y2;
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function applyBandpass(signal, sr) {
  const wH = 2*Math.PI*50/sr, cH = Math.cos(wH), sH = Math.sin(wH)/1.414, a0H = 1+sH;
  let s = biquad(signal, (1+cH)/2/a0H, -(1+cH)/a0H, (1+cH)/2/a0H, -2*cH/a0H, (1-sH)/a0H);
  const wL = 2*Math.PI*5000/sr, cL = Math.cos(wL), sL = Math.sin(wL)/1.414, a0L = 1+sL;
  return biquad(s, (1-cL)/2/a0L, (1-cL)/a0L, (1-cL)/2/a0L, -2*cL/a0L, (1-sL)/a0L);
}

function rmsNorm(signal, target) {
  let sq = 0; for (let i = 0; i < signal.length; i++) sq += signal[i]*signal[i];
  const rms = Math.sqrt(sq/signal.length); if (rms < 1e-8) return signal;
  const gain = target/rms; const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.max(-1, Math.min(1, signal[i]*gain));
  return out;
}

function decodeWav(buf) {
  const dv = new DataView(buf);
  const sampleRate = dv.getUint32(24, true);
  const bitsPerSample = dv.getUint16(34, true);
  const numChannels = dv.getUint16(22, true);
  let dataOffset = 44;
  for (let i = 12; i < buf.byteLength - 8; i++) {
    if (dv.getUint8(i) === 0x64 && dv.getUint8(i+1) === 0x61 &&
        dv.getUint8(i+2) === 0x74 && dv.getUint8(i+3) === 0x61) {
      dataOffset = i + 8; break;
    }
  }
  const numSamples = Math.floor((buf.byteLength - dataOffset) / (bitsPerSample / 8) / numChannels);
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    let val = 0;
    const off = dataOffset + i * numChannels * (bitsPerSample / 8);
    if (bitsPerSample === 16) val = dv.getInt16(off, true) / 32768;
    else if (bitsPerSample === 32) val = dv.getFloat32(off, true);
    else if (bitsPerSample === 8) val = (dv.getUint8(off) - 128) / 128;
    samples[i] = val;
  }
  return { samples, sampleRate, numChannels };
}

function preprocess(samples, sampleRate) {
  let mono;
  if (samples.length === 0) return new Float32Array(TARGET_SR * DURATION_S);
  // Assume already mono if not channel-interleaved here, handled in loop
  let resampled = linearResample(samples, sampleRate, TARGET_SR);
  resampled = applyBandpass(resampled, TARGET_SR);
  resampled = rmsNorm(resampled, 0.1);
  
  // Fixed duration padding/truncation
  const fixedLen = TARGET_SR * DURATION_S;
  const out = new Float32Array(fixedLen);
  out.set(resampled.slice(0, fixedLen));
  return out;
}

async function main() {
  console.log('Loading YAMNet model...');
  const model = await tf.loadGraphModel(YAMNET_MODEL_URL, { fromTFHub: true });
  console.log('Model loaded.');

  const { data: files } = await sb.storage.from('anomaly-patterns').list('', { limit: 100 });
  const audioFiles = files.filter(f => f.name.endsWith('.wav'));
  
  let sql = `
CREATE EXTENSION IF NOT EXISTS vector;

DROP TABLE IF EXISTS anomaly_embeddings;

CREATE TABLE anomaly_embeddings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  label TEXT NOT NULL,
  source_file TEXT NOT NULL,
  embedding VECTOR(1024),
  created_at TIMESTAMP DEFAULT now()
);

`;

  console.log(`Processing ${audioFiles.length} files...`);

  for (const file of audioFiles) {
    const { data: bufData } = await sb.storage.from('anomaly-patterns').download(file.name);
    const arrayBuffer = await bufData.arrayBuffer();
    
    try {
      const { samples, sampleRate, numChannels } = decodeWav(arrayBuffer);
      let mono;
      if (numChannels === 1) { mono = samples; }
      else {
        mono = new Float32Array(Math.floor(samples.length / numChannels));
        for (let i = 0; i < mono.length; i++) {
          let s = 0; for (let c = 0; c < numChannels; c++) s += samples[i*numChannels+c]; mono[i] = s/numChannels;
        }
      }
      
      const processed = preprocess(mono, sampleRate);
      
      const tensor = tf.tensor1d(processed);
      const [scores, embeddings, spec] = model.predict(tensor);
      
      const meanEmbedding = tf.mean(embeddings, 0).dataSync();
      
      tf.dispose([tensor, scores, embeddings, spec]);
      
      const embArray = Array.from(meanEmbedding);
      const label = file.name.replace(/\.wav$/, '');
      
      sql += `INSERT INTO anomaly_embeddings (label, source_file, embedding) VALUES ('${label}', '${file.name}', '[${embArray.join(',')}]');\n`;
      console.log(`✅ Processed ${file.name}`);
    } catch (e) {
      console.error(`❌ Failed ${file.name}: ${e.message}`);
    }
  }

  fs.writeFileSync('seed_embeddings.sql', sql);
  console.log('Generated seed_embeddings.sql. Please run this in your Supabase SQL Editor.');
  process.exit(0);
}

main();
