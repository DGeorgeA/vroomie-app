import fs from 'fs';
import * as tf from '@tensorflow/tfjs';

const YAMNET_MODEL_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';

function decodeWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(pos + 8, true), channels: dv.getUint16(pos + 10, true), sampleRate: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) };
    else if (id === 'data') { dataOff = pos + 8; dataLen = size; }
    pos += 8 + size + (size % 2);
  }
  const bytesPer = fmt.bits / 8;
  const frames = Math.floor(Math.min(dataLen, dv.byteLength - dataOff) / (bytesPer * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const off = dataOff + (i * fmt.channels + c) * bytesPer;
      let v;
      if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(off, true);
      else if (fmt.bits === 16) v = dv.getInt16(off, true) / 32768;
      else v = dv.getInt32(off, true) / 2147483648;
      acc += v;
    }
    out[i] = acc / fmt.channels;
  }
  if (fmt.sampleRate === 16000) return out;
  const ratio = fmt.sampleRate / 16000, outLen = Math.floor(out.length / ratio);
  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio, l = Math.floor(x), r = Math.min(l + 1, out.length - 1);
    res[i] = out[l] * (1 - (x - l)) + out[r] * (x - l);
  }
  return res;
}

const csv = fs.readFileSync('scripts/yamnet_class_map.csv', 'utf8');
const CLASSES = csv.trim().split('\n').slice(1).map(raw => {
  const l = raw.replace(/\r$/, '');
  const m = l.match(/^\d+,[^,]+,(.*)$/);
  let n = m[1].trim();
  if (n.startsWith('"') && n.endsWith('"')) n = n.slice(1, -1);
  return n;
});

const VEHICLE_MECH_NAMES = [
  'Vehicle', 'Motor vehicle (road)', 'Car', 'Vehicle horn, car horn, honking', 'Car alarm',
  'Power windows, electric windows', 'Skidding', 'Tire squeal', 'Car passing by',
  'Race car, auto racing', 'Truck', 'Air brake', 'Air horn, truck horn', 'Reversing beeps',
  'Bus', 'Motorcycle', 'Traffic noise, roadway noise',
  'Engine', 'Light engine (high frequency)', 'Medium engine (mid frequency)',
  'Heavy engine (low frequency)', 'Engine knocking', 'Engine starting', 'Idling',
  'Accelerating, revving, vroom', 'Lawn mower', 'Chainsaw',
  'Mechanisms', 'Ratchet, pawl', 'Gears', 'Pulleys', 'Sewing machine',
  'Tools', 'Hammer', 'Jackhammer', 'Sawing', 'Power tool', 'Drill',
  'Rattle', 'Squeak', 'Squeal', 'Whir', 'Hum', 'Vibration', 'Throbbing', 'Rumble',
  'Clicking', 'Tick', 'Clatter', 'Creak', 'Scrape', 'Grind'
];
const VEH = new Set(VEHICLE_MECH_NAMES.map(n => CLASSES.indexOf(n)).filter(i => i >= 0));
const INTF = (() => {
  const s = new Set();
  for (let i = 0; i < CLASSES.indexOf('Animal'); i++) s.add(i);
  for (let i = CLASSES.indexOf('Music'); i < CLASSES.indexOf('Wind'); i++) s.add(i);
  ['Television', 'Radio', 'Silence', 'Whistling', 'Whistle'].forEach(n => { const i = CLASSES.indexOf(n); if (i >= 0) s.add(i); });
  return s;
})();

function gate(sc) {
  let t1 = 0, veh = 0, intf = 0;
  for (let i = 0; i < sc.length; i++) {
    if (sc[i] > sc[t1]) t1 = i;
    if (VEH.has(i) && sc[i] > veh) veh = sc[i];
    if (INTF.has(i) && sc[i] > intf) intf = sc[i];
  }
  // Calibration: Allow if top1 is vehicle, OR if vehicle > interferer,
  // OR if it's just a generic sound (not an interferer) and not absolute silence.
  const isInterferer = INTF.has(t1);
  const accepted = VEH.has(t1) || (!isInterferer && veh >= 0.001) || (veh >= 0.03 && veh > intf);
  return { accepted, t1: CLASSES[t1], veh, intf, t1Score: sc[t1] };
}

async function run() {
  const model = await tf.loadGraphModel(YAMNET_MODEL_URL, { fromTFHub: true });
  
  const anomalies = [
    'BearingAlternator.wav', 'Piston.wav', 'MotorStarter.wav', 
    'intake_leak_low.wav', 'misfire_detected_medium.wav', 'timing_chain_rattle_high.wav',
    'alternator_bearing_fault_critical.wav', 'water_pump_failure_critical.wav',
    'Issue_with_Power_steering_or_low_oil_or_serpentine_belt_2.wav'
  ];

  for (const file of anomalies) {
    const url = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/' + encodeURIComponent(file);
    const res = await fetch(url);
    if (!res.ok) {
      console.log('Skipping ' + file);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const pcm = decodeWav(buf);
    
    console.log(`\n--- Testing ${file} ---`);
    for (let start = 0; start + 16000 <= pcm.length; start += 16000) {
      const window = pcm.slice(start, start + 16000);
      let rmsSq = 0;
      for (let i = 0; i < window.length; i++) rmsSq += window[i] * window[i];
      const rms = Math.sqrt(rmsSq / window.length);
      if (rms < 0.01) continue;
      
      const sc = tf.tidy(() => {
        const [scores] = model.predict(tf.tensor1d(window));
        return Array.from(tf.mean(scores, 0).dataSync());
      });
      
      const res = gate(sc);
      console.log(`[${(start/16000).toFixed(1)}s] RMS=${rms.toFixed(3)} | Gate: ${res.accepted ? 'PASS' : 'REJECT'} | top1=${res.t1}(${res.t1Score.toFixed(3)}) veh=${res.veh.toFixed(3)} intf=${res.intf.toFixed(3)}`);
    }
  }
}

run().catch(console.error);
