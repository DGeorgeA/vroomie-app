import { loadOrGenerateFingerprints } from './lib/datasetLoader';
import { initializeEmbeddingEngine, getAudioEmbedding, calculateCosineSimilarity } from './lib/mlEmbeddingEngine';
import { Logger } from './lib/logger';

function remoteLog(msg) {
  console.log(msg);
  fetch('http://localhost:3001/log', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: msg
  }).catch(() => {});
}

export async function runDiagnosticTest() {
  remoteLog("==================================================");
  remoteLog("STARTING VROOMIE DIAGNOSTIC TEST (PHASE 1-5)");
  remoteLog("==================================================");

  try {
    await initializeEmbeddingEngine();
    
    // We will test BearingAlternator.wav directly
    const filename = 'BearingAlternator.wav';
    const url = `https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/${filename}`;
    
    remoteLog(`1. Fetching ${filename}...`);
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    
    // METHOD A: Full file decoding (What datasetLoader does)
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decodedBuffer = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
    await tempCtx.close();
    
    const duration = decodedBuffer.duration;
    const targetLength = Math.ceil(duration * 16000);
    const offlineCtx = new OfflineAudioContext(1, targetLength, 16000);
    const source = offlineCtx.createBufferSource();
    source.buffer = decodedBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const renderedBuffer = await offlineCtx.startRendering();
    const fullPcm = renderedBuffer.getChannelData(0);
    
    remoteLog(`2. Decoded full reference: ${fullPcm.length} samples (${duration.toFixed(2)}s)`);
    
    const referenceEmbedding = await getAudioEmbedding(fullPcm);
    remoteLog(`3. Reference Embedding generated (Length: ${referenceEmbedding.length})`);
    
    // METHOD B: 1-second chunking (What audioFeatureExtractor does)
    remoteLog("4. Simulating live mic processing (1-second chunks)...");
    const windowSamples = 16000;
    const chunks = [];
    
    for (let i = 0; i < fullPcm.length - windowSamples; i += windowSamples / 2) { // 50% overlap
      const chunk = new Float32Array(windowSamples);
      chunk.set(fullPcm.subarray(i, i + windowSamples));
      chunks.push(chunk);
    }
    
    remoteLog(`   Generated ${chunks.length} chunks (1s each, 50% overlap).`);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let rmsSq = 0;
      for (let j = 0; j < chunk.length; j++) rmsSq += chunk[j] * chunk[j];
      const rms = Math.sqrt(rmsSq / chunk.length);
      
      if (rms < 0.01) {
        remoteLog(`   Chunk ${i}: REJECTED BY RMS GATE (rms=${rms.toFixed(4)})`);
        continue;
      }
      
      const chunkEmbedding = await getAudioEmbedding(chunk);
      const similarity = calculateCosineSimilarity(chunkEmbedding, referenceEmbedding);
      
      remoteLog(`   Chunk ${i}: RMS=${rms.toFixed(4)} | Cosine Similarity to Ref: ${similarity.toFixed(4)}`);
      if (similarity < 0.75) {
         remoteLog(`      => FALSE NEGATIVE (Fails 0.75 threshold)`);
      } else {
         remoteLog(`      => TRUE POSITIVE (Matches reference)`);
      }
    }
    
    // Let's also check against ALL references
    const fingerprints = JSON.parse(localStorage.getItem('vroomie_yamnet_fingerprints_v6') || '[]');
    remoteLog(`5. Testing against cache references (${fingerprints.length} loaded)...`);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkEmbedding = await getAudioEmbedding(chunk);
      
      let bestScore = -1;
      let bestLabel = null;
      for (const ref of fingerprints) {
        const score = calculateCosineSimilarity(chunkEmbedding, ref.yamnet_embedding);
        if (score > bestScore) {
          bestScore = score;
          bestLabel = ref.label;
        }
      }
      
      remoteLog(`   Chunk ${i} top match: ${bestLabel} (${bestScore.toFixed(4)})`);
    }

    remoteLog("==================================================");
    remoteLog("DIAGNOSTIC TEST COMPLETE");
    remoteLog("==================================================");

  } catch (err) {
    remoteLog("DIAGNOSTIC ERROR: " + err.message);
  }
}
