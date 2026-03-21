import { supabase } from '../lib/supabase';
import { Logger } from '../lib/logger';
import { extractFeaturesFromBuffer } from '../lib/offlineAudioProcessor';

export let referenceIndex = [];

function calculateNorm(vec) {
  return Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
}

export async function initializeAudioDataset() {
  referenceIndex = [];
  Logger.info("Starting Multi-File Anomaly Pattern extraction from Supabase Storage...");
  
  try {
    // 1. Fetch ALL Files from Supabase Storage
    const { data: files, error: listError } = await supabase.storage.from('anomaly-patterns').list();
    if (listError) {
      Logger.error("Supabase Storage error listing bucket files", listError);
      return;
    }
    
    const audioFiles = files.filter(f => f.name.endsWith('.wav') || f.name.endsWith('.mp3'));
    Logger.info(`Discovered ${audioFiles.length} valid audio patterns in bucket.`);
    
    if (audioFiles.length === 0) {
      Logger.warn("No audio files found in anomaly-patterns bucket");
      return;
    }

    // 2. Load and Process ALL Reference Audio Files
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 16000, 16000);
    
    for (const file of audioFiles) {
      Logger.info(`Downloading and extracting features for: ${file.name}`);
      
      const { data: blob, error: downloadError } = await supabase.storage
        .from('anomaly-patterns')
        .download(file.name);
        
      if (downloadError) {
        Logger.error(`Failed to download ${file.name}`, downloadError);
        continue;
      }
      
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
      
      // 3. Ensure Feature Consistency mathematically via shared Meyda windowing slice
      const features = await extractFeaturesFromBuffer(audioBuffer);
      
      if (features) {
        referenceIndex.push({
          label: file.name.replace(/\.[^/.]+$/, ""), // Strip extension for clean label
          category: 'Anomaly',
          source: 'supabase_bucket',
          featureVector: {
            mfcc: features.mfcc,
            mfccNorm: calculateNorm(features.mfcc), // Precomputed for instant matching
            rms: features.rms,
            spectralCentroid: features.spectralCentroid
          },
          audioBufferPath: file.name
        });
      } else {
        Logger.warn(`Feature extraction yielded empty payload for ${file.name} (perhaps completely silent)`);
      }
    }
    
    Logger.info("====== MULTI-SOUND REFERENCE LIBRARY SUCCESSFULLY LOADED ======", { 
      totalProcessed: referenceIndex.length,
      patternsAdded: referenceIndex.map(r => r.label)
    });
    
  } catch (err) {
    Logger.error("Critical failure during Multi-File Dataset Initialization loop", err);
  }
}
