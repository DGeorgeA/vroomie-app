// Removed import of getAudioEmbedding to prevent circular dependency
import { Logger } from './logger';
import { supabase } from './supabase'; // if needed, but we can just use fetch

const CACHE_KEY = 'vroomie_yamnet_fingerprints_v2';
const SUPABASE_BUCKET_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';

const FILES_TO_DOWNLOAD = [
  'alternator_bearing_fault_critical.wav',
  'BearingAlternator.wav',
  'intake_leak_low.wav',
  'misfire_detected_medium.wav',
  'MotorStarter.wav',
  'Piston.wav'
];

function deriveMetadata(baseName) {
  const b = baseName.toLowerCase();
  let fault_type = baseName;
  let severity   = 'high';

  if (b.includes('critical')) severity = 'critical';
  else if (b.includes('medium') || b.includes('moderate')) severity = 'medium';
  else if (b.includes('low'))  severity = 'low';

  if (b.includes('alternator') || (b.includes('bearing') && !b.includes('water')))
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
  else if (b.includes('power_steering') || b.includes('powersteeringpump') || b.includes('powersteer'))
    fault_type = 'power_steering';
  else if (b.includes('timing') || b.includes('chain'))
    fault_type = 'timing_chain';
  else if (b.includes('rocker') || b.includes('valve'))
    fault_type = 'rocker_valve';
  else if (b.includes('low_oil') || b.includes('oil'))
    fault_type = 'low_oil';

  return { 
    label: baseName.replace('.wav', '').replace(/_/g, ' '), 
    fault_type, 
    severity 
  };
}

export async function loadOrGenerateFingerprints(getAudioEmbeddingFn) {
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
  const fingerprints = [];

  // Use OfflineAudioContext to decode WAV files in the browser
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

  for (const filename of FILES_TO_DOWNLOAD) {
    try {
      const response = await fetch(`${SUPABASE_BUCKET_URL}${filename}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const pcm = audioBuffer.getChannelData(0);
      
      const embedding = await getAudioEmbeddingFn(pcm);
      if (embedding) {
        const meta = deriveMetadata(filename);
        fingerprints.push({
          id: filename,
          label: meta.label,
          fault_type: meta.fault_type,
          severity: meta.severity,
          source_file: filename,
          yamnet_embedding: embedding
        });
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
      Logger.warn('Could not save to localStorage (maybe too large?)');
    }
  }

  return fingerprints;
}
