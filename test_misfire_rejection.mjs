import fs from 'fs';
import * as tf from '@tensorflow/tfjs';
import { initializeEmbeddingEngine, getAudioAnalysis, findBestMatch, isEngineReady } from './src/lib/mlEmbeddingEngine.js';
import pkg from 'wavefile';
const { WaveFile } = pkg;

async function run() {
  console.log('1. Initializing Embedding Engine (Loads v9 static references + YAMNet)...');
  await initializeEmbeddingEngine();
  console.log('Engine Ready?', isEngineReady());

  console.log('2. Downloading misfire anomaly from Supabase...');
  const res = await fetch('https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/misfire_detected_medium.wav');
  const arrayBuffer = await res.arrayBuffer();
  
  console.log('3. Decoding WAV...');
  const wav = new WaveFile(new Uint8Array(arrayBuffer));
  wav.toSampleRate(16000);
  wav.toBitDepth('32f');
  const samples = wav.getSamples(false, Float32Array);
  
  console.log('4. Running pipeline on 1-second chunks (simulating audioFeatureExtractor.js)...');
  const windowSamples = 16000;
  const step = windowSamples; // 1 second non-overlapping for test
  
  for (let start = 0; start <= samples.length - windowSamples; start += step) {
    const chunk = new Float32Array(windowSamples);
    chunk.set(samples.subarray(start, start + windowSamples));
    
    // RMS gate
    let rmsSq = 0;
    for (let i = 0; i < windowSamples; i++) rmsSq += chunk[i] * chunk[i];
    const rms = Math.sqrt(rmsSq / windowSamples);
    
    if (rms < 0.01) {
      console.log(`[Chunk ${start/16000}s] REJECTED (RMS < 0.01) rms=${rms.toFixed(3)}`);
      continue;
    }
    
    const analysis = await getAudioAnalysis(chunk);
    if (!analysis) continue;
    
    const { embedding, meanScores } = analysis;
    const match = findBestMatch(embedding, meanScores);
    
    console.log(`[Chunk ${start/16000}s] RMS=${rms.toFixed(3)} -> status=${match.status} | reason=${match.reason || match.anomaly} | conf=${match.confidence}`);
  }
}

run().catch(console.error);
