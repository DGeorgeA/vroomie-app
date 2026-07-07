import { Logger } from './logger';
import { supabase } from './supabase';

// Reference set = EVERY .wav in the Supabase Storage bucket 'anomaly-patterns'.
// The bucket is listed at runtime, so uploading a new sample to the bucket adds
// it to the matcher on the next fingerprint (re)generation — no code change.
// v8: dynamic bucket listing (was a hardcoded 6-file subset), grouped labels.
const CACHE_KEY = 'vroomie_yamnet_fingerprints_v8';
const BUCKET = 'anomaly-patterns';
const SUPABASE_BUCKET_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';

// Cap fingerprint chunks per file so the 44-sample power-steering set doesn't
// dominate compute/localStorage. Chunks are picked evenly across the file.
const MAX_CHUNKS_PER_FILE = 3;

// Fallback only if the bucket listing API call fails (e.g. offline first run).
const FALLBACK_FILES = [
  'alternator_bearing_fault_critical.wav',
  'BearingAlternator.wav',
  'intake_leak_low.wav',
  'misfire_detected_medium.wav',
  'MotorStarter.wav',
  'Piston.wav'
];

async function listBucketWavFiles() {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).list('', {
      limit: 500,
      sortBy: { column: 'name', order: 'asc' }
    });
    if (error) throw error;
    const wavs = (data || [])
      .map(o => o.name)
      .filter(n => n.toLowerCase().endsWith('.wav'));
    if (wavs.length === 0) throw new Error('bucket listing returned no wav files');
    Logger.info(`[Dataset] Bucket listing: ${wavs.length} wav files in '${BUCKET}'`);
    return wavs;
  } catch (err) {
    Logger.warn(`[Dataset] Bucket listing failed (${err.message}) — using fallback file list`);
    return FALLBACK_FILES;
  }
}

export function deriveMetadata(filename) {
  const baseName = filename.replace(/\.wav$/i, '');
  // Numbered variants of the same recording set (e.g. ..._serpentine_belt_10)
  // collapse into ONE anomaly category — the file name determines the anomaly.
  const groupName = baseName.replace(/_\d+$/, '');
  const b = groupName.toLowerCase();
  let fault_type = groupName;
  let severity   = 'high';

  if (b.includes('critical')) severity = 'critical';
  else if (b.includes('medium') || b.includes('moderate')) severity = 'medium';
  else if (b.includes('low') && !b.includes('low_oil') && !b.includes('low oil')) severity = 'low';

  if (b.includes('power_steering') || b.includes('powersteeringpump') || b.includes('powersteer'))
    fault_type = 'power_steering';
  else if (b.includes('alternator') || (b.includes('bearing') && !b.includes('water')))
    fault_type = 'alternator_bearing_fault';
  else if (b.includes('intake') || b.includes('leak'))
    fault_type = 'intake_leak';
  else if (b.includes('water_pump') || b.includes('waterpump'))
    fault_type = 'water_pump';
  else if (b.includes('motor') || b.includes('starter'))
    fault_type = 'motor_starter';
  else if (b.includes('piston') || b.includes('knock'))
    fault_type = 'piston_knock';
  else if (b.includes('serpentine') || (b.includes('belt') && !b.includes('power')))
    fault_type = 'serpentine_belt';
  else if (b.includes('timing') || b.includes('chain'))
    fault_type = 'timing_chain';
  else if (b.includes('rocker') || b.includes('valve'))
    fault_type = 'rocker_valve';
  else if (b.includes('low_oil') || b.includes('oil'))
    fault_type = 'low_oil';

  return {
    label: groupName.replace(/_/g, ' '),
    fault_type,
    severity
  };
}

export async function loadOrGenerateFingerprints(getAudioEmbeddingFn) {
  try { localStorage.removeItem('vroomie_yamnet_fingerprints_v7'); } catch (e) { /* ignore */ }
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.length > 0) {
        Logger.info(`Loaded ${parsed.length} YAMNet fingerprints from cache.`);
        return parsed;
      }
    } catch (e) {
      Logger.warn('Failed to parse cached fingerprints, regenerating...');
    }
  }

  Logger.info('Generating YAMNet fingerprints from Supabase bucket...');
  const filesToDownload = await listBucketWavFiles();
  const fingerprints = [];

  for (const filename of filesToDownload) {
    try {
      const url = `${SUPABASE_BUCKET_URL}${encodeURIComponent(filename)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${filename}`);
      const arrayBuffer = await response.arrayBuffer();

      // Use a temporary AudioContext ONLY for decoding, then resample to 16kHz deterministically
      const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
      const decodedBuffer = await tempCtx.decodeAudioData(arrayBuffer);
      await tempCtx.close();

      // Resample to exactly 16kHz using OfflineAudioContext
      const duration = decodedBuffer.duration;
      const targetLength = Math.ceil(duration * 16000);
      const offlineCtx = new OfflineAudioContext(1, targetLength, 16000);
      const source = offlineCtx.createBufferSource();
      source.buffer = decodedBuffer;
      source.connect(offlineCtx.destination);
      source.start(0);
      const renderedBuffer = await offlineCtx.startRendering();
      const fullPcm = renderedBuffer.getChannelData(0);

      // Chunk into 1-second windows (50% overlap) so reference embeddings have
      // the same temporal distribution as the live 1-second mic captures,
      // skip silent chunks, then keep an evenly-spaced subset per file.
      const windowSamples = 16000;
      const step = windowSamples / 2;
      const candidateStarts = [];
      for (let start = 0; start + windowSamples <= fullPcm.length; start += step) {
        let rmsSq = 0;
        for (let j = start; j < start + windowSamples; j++) rmsSq += fullPcm[j] * fullPcm[j];
        if (Math.sqrt(rmsSq / windowSamples) >= 0.01) candidateStarts.push(start);
      }
      let selectedStarts = candidateStarts;
      if (candidateStarts.length > MAX_CHUNKS_PER_FILE) {
        selectedStarts = [];
        for (let k = 0; k < MAX_CHUNKS_PER_FILE; k++) {
          selectedStarts.push(candidateStarts[Math.floor(k * (candidateStarts.length - 1) / (MAX_CHUNKS_PER_FILE - 1))]);
        }
      }

      const meta = deriveMetadata(filename);
      let chunksExtracted = 0;
      for (const start of selectedStarts) {
        const chunk = new Float32Array(windowSamples);
        chunk.set(fullPcm.subarray(start, start + windowSamples));
        const embedding = await getAudioEmbeddingFn(chunk);
        if (embedding) {
          fingerprints.push({
            id: `${filename}_chunk_${chunksExtracted}`,
            label: meta.label,
            fault_type: meta.fault_type,
            severity: meta.severity,
            source_file: filename,
            // 4-decimal rounding keeps the 55-file cache inside localStorage
            // limits; cosine similarity is unaffected at this precision.
            yamnet_embedding: embedding.map(v => Math.round(v * 1e4) / 1e4)
          });
          chunksExtracted++;
        }
      }

      Logger.info(`[Dataset] ✅ ${filename}: ${chunksExtracted} chunk fingerprints (label: ${meta.label})`);
      if (chunksExtracted === 0) {
        Logger.warn(`[Dataset] ⚠️ No chunks generated for ${filename} (too short or silent)`);
      }
    } catch (err) {
      Logger.error(`Failed to process ${filename}:`, err);
    }
  }

  if (fingerprints.length > 0) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(fingerprints));
      Logger.info(`Successfully cached ${fingerprints.length} YAMNet fingerprints.`);
    } catch (e) {
      Logger.warn('Could not save fingerprints to localStorage (quota) — will regenerate next session.');
    }
  }

  return fingerprints;
}
