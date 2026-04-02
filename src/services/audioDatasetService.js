import { supabase } from '../lib/supabase';
import { Logger } from '../lib/logger';
import { initializeCNN, fileNameToClass } from '../lib/cnnClassifier';
import { openDB } from 'idb';

export let referenceIndex = [];

// Initialize IndexedDB for resilient offline operations
const initDB = async () => {
  return openDB('vroomie-db', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('anomaly_references')) {
        db.createObjectStore('anomaly_references', { keyPath: 'id' });
      }
    },
  });
};

export async function initializeAudioDataset() {
  referenceIndex = [];
  const cnnTrainingData = [];
  
  Logger.info("Starting ML Reference Extraction (Offline-First IDB)...");
  
  try {
    const db = await initDB();
    let dbRefs = [];

    // 1. Attempt to sync fresh metadata and pre-computed embeddings from DB
    try {
      const { data, error } = await supabase.from('anomaly_references').select('*');
      if (error) throw new Error(`Supabase DB Error: ${error.message}`);
      
      if (data && data.length > 0) {
        dbRefs = data;
        // Cache to IndexedDB
        const tx = db.transaction('anomaly_references', 'readwrite');
        await tx.store.clear();
        for (const ref of data) {
          await tx.store.put(ref);
        }
        await tx.done;
        Logger.info(`Synced ${dbRefs.length} references to local IndexedDB cache.`);
      }
    } catch (networkErr) {
      Logger.warn("Network fetch failed or Timeout. Falling back to Local IndexedDB Cache...", networkErr);
      // Seamlessly fall back to local IDB
      dbRefs = await db.getAll('anomaly_references');
      
      if (dbRefs && dbRefs.length > 0) {
        Logger.info(`Revived ${dbRefs.length} references from local IndexedDB cache.`);
      }
    }
    
    if (!dbRefs || dbRefs.length === 0) {
      Logger.warn(
        "No reference anomalies found in Supabase DB or local IndexedDB cache. " +
        "Ensure the 'anomaly_references' table has rows with populated 'embedding_vector' columns. " +
        "The acoustic matching engine will remain inactive until references are loaded."
      );
      return;
    }
    
    // 2. Load into memory index
    for (const ref of dbRefs) {
      if (ref.embedding_vector) {
        // Parse the embedding vector. Depending on the SQL client, it might be a string '[0.1, ...]' or an array.
        let parsedVector = ref.embedding_vector;
        if (typeof parsedVector === 'string') {
          try {
            parsedVector = JSON.parse(parsedVector);
          } catch (e) {
            Logger.error(`Failed to parse embedding vector for ${ref.label}`, e);
            continue;
          }
        }
        
        referenceIndex.push({
          label: ref.label,
          category: ref.category,
          source: 'supabase_db',
          embedding_vector: parsedVector,
          spectrogram: ref.spectrogram_url ? null : null, // If we store spectrogram json, we can fetch it here
          audioBufferPath: ref.source_file
        });
      }
    }
    
    Logger.info(`Reference library loaded: ${referenceIndex.length} patterns.`);
    
    // Note: CNN initialization is skipped here since we moved to YAMNet. 
    // If the legacy CNN is still active, we'd need spectrograms.
    
  } catch (err) {
    Logger.error("Dataset initialization failed", err);
  }
}
