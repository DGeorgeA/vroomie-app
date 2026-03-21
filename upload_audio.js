import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

function generateSineWaveWav(frequency, durationSec, sampleRate = 44100) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const buffer = Buffer.alloc(44 + numSamples * 2);
  
  // RIFF Chunk Descriptor
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4); // ChunkSize
  buffer.write("WAVE", 8);
  
  // "fmt " sub-chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  buffer.writeUInt16LE(1, 22); // NumChannels = 1
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buffer.writeUInt16LE(2, 32); // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample
  
  // "data" sub-chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(numSamples * 2, 40); // Subchunk2Size
  
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Add some noise + overtones so it's not a pure sine wave (makes Meyda's MFCC grab a unique profile)
    let sample = Math.sin(2 * Math.PI * frequency * t);
    sample += 0.5 * Math.sin(2 * Math.PI * frequency * 2 * t);
    sample += Math.random() * 0.2; // noise floor
    
    // Normalize and clamp
    sample = Math.max(-1, Math.min(1, sample)) * 32767 * 0.8; 
    buffer.writeInt16LE(Math.round(sample), offset);
    offset += 2;
  }
  
  return buffer;
}

const anomaliesToUpload = [
  { name: 'engine_knocking_high.wav', freq: 120 },          // Low rumble + knock
  { name: 'alternator_bearing_fault_critical.wav', freq: 3000 }, // High-pitched squeal
  { name: 'timing_chain_rattle_high.wav', freq: 600 },      // Mid-high metallic rattle
  { name: 'misfire_detected_medium.wav', freq: 40 },        // Sub-bass heavy thud
  { name: 'water_pump_failure_critical.wav', freq: 1500 },  // Mid squeal
  { name: 'intake_leak_low.wav', freq: 5000 },              // High-frequency hiss
  { name: 'pulley_misalignment_medium.wav', freq: 850 },     // Harmonic wobbles
  { name: 'exhaust_resonance_low.wav', freq: 250 },          // Mid-low drone
];

async function uploadFiles() {
  console.log('Generating and uploading 8 structurally unique engine anomaly .wav variants...');
  
  for (const anomaly of anomaliesToUpload) {
    try {
      console.log(`Building -> ${anomaly.name} @ ${anomaly.freq}Hz`);
      const wavBuffer = generateSineWaveWav(anomaly.freq, 2.0); // 2 seconds each
      
      const { data, error } = await supabase.storage
        .from('anomaly-patterns')
        .upload(anomaly.name, wavBuffer, {
          contentType: 'audio/wav',
          upsert: true, // Overwrite if exists
        });
        
      if (error) {
        console.error(`Failed to upload ${anomaly.name}:`, error.message);
      } else {
        console.log(`✅ Uploaded ${anomaly.name} successfully!`);
      }
    } catch (e) {
      console.error(`Crash on ${anomaly.name}:`, e.message);
    }
  }
  
  console.log('\nAll audio signatures mapped to Supabase Storage Successfully!');
}

uploadFiles();
