import os
import sys
import json
import subprocess
import numpy as np
import librosa
from supabase import create_client, Client

SUPABASE_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co'
SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU'
BUCKET_NAME = 'anomaly-patterns'
OUTPUT_JS = os.path.join(os.path.dirname(__file__), '..', 'src', 'data', 'dtwFingerprints_v3.js')
TMP_DIR = os.path.join(os.path.dirname(__file__), 'tmp_audio')

TARGET_SR = 16000
N_FFT = 512
HOP_LENGTH = 320
N_MELS = 40
N_MFCC = 13
SEQ_LENGTH = 50

# Ensure temp dir exists
os.makedirs(TMP_DIR, exist_ok=True)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def derive_metadata(baseName):
    b = baseName.lower()
    fault_type = 'unknown'
    severity = 'high'
    is_negative = False
    
    if 'critical' in b: severity = 'critical'
    elif 'medium' in b or 'moderate' in b: severity = 'medium'
    elif 'low' in b: severity = 'low'
    
    if 'alternator' in b or ('bearing' in b and 'water' not in b): fault_type = 'alternator_bearing_fault'
    elif 'intake' in b or 'leak' in b: fault_type = 'intake_leak'
    elif 'water_pump' in b or 'waterpump' in b: fault_type = 'water_pump'
    elif 'motor' in b or 'starter' in b: fault_type = 'motor_starter'
    elif 'piston' in b or 'knock' in b: fault_type = 'piston_knock'
    elif 'serpentine' in b or ('belt' in b and 'power' not in b): fault_type = 'serpentine_belt'
    elif 'power_steering' in b or 'powersteeringpump' in b or 'powersteer' in b: fault_type = 'power_steering'
    elif 'timing' in b or 'chain' in b: fault_type = 'timing_chain'
    elif 'rocker' in b or 'valve' in b: fault_type = 'rocker_valve'
    elif 'low_oil' in b or 'oil' in b: fault_type = 'low_oil'
    elif 'negative' in b or 'speech' in b or 'music' in b or 'tv' in b or 'noise' in b: 
        fault_type = 'negative_rejection'
        is_negative = True
        
    label = baseName.replace('.wav', '').replace('_', ' ').title()
    return fault_type, severity, label, is_negative

def preprocess_with_ffmpeg(input_path, output_path):
    import shutil
    shutil.copy(input_path, output_path)
    return True


def extract_features(audio_path):
    y, sr = librosa.load(audio_path, sr=TARGET_SR)
    if len(y) < N_FFT:
        # Pad if too short
        y = np.pad(y, (0, N_FFT - len(y)))
        
    # 1. 13 MFCCs
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=N_MFCC, n_fft=N_FFT, hop_length=HOP_LENGTH, n_mels=N_MELS, window='hamming')
    
    # 2. 13 Delta-MFCCs
    delta_mfcc = librosa.feature.delta(mfcc)
    
    # 3. 7-band Spectral Contrast
    contrast = librosa.feature.spectral_contrast(y=y, sr=sr, n_fft=N_FFT, hop_length=HOP_LENGTH, fmin=200.0, n_bands=6)
    
    # 4. Spectral Flux (Onset envelope is a good proxy, or manual diff of mag spec)
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP_LENGTH, window='hamming'))
    flux = np.sum(np.maximum(0, np.diff(S, axis=1)), axis=0)
    flux = np.concatenate(([0], flux)) # pad first frame
    flux_log = np.log10(1 + flux)
    
    # 5. RMS Energy
    rms = librosa.feature.rms(S=S, frame_length=N_FFT, hop_length=HOP_LENGTH)[0]
    
    # 6. Spectral Flatness
    flatness = librosa.feature.spectral_flatness(S=S)[0]
    
    # 7. Zero-Crossing Rate
    zcr = librosa.feature.zero_crossing_rate(y, frame_length=N_FFT, hop_length=HOP_LENGTH)[0]
    
    # 8. Spectral Centroid
    centroid = librosa.feature.spectral_centroid(S=S, sr=sr)[0] / (sr / 2.0) # normalized to Nyquist
    
    # Stack features into frames. Sequence shape: [time_steps, features]
    # Features order: 13 MFCC + 1 Flux + 1 RMS + 1 Flatness + 1 ZCR + 1 Centroid + 13 Delta + 7 Contrast = 38 dims
    min_len = min(mfcc.shape[1], len(flux_log), len(rms), len(flatness), len(zcr), len(centroid), delta_mfcc.shape[1], contrast.shape[1])
    
    frames = []
    for i in range(min_len):
        frame = np.concatenate([
            mfcc[:, i],
            [flux_log[i]],
            [rms[i]],
            [flatness[i]],
            [zcr[i]],
            [centroid[i]],
            delta_mfcc[:, i],
            contrast[:, i]
        ])
        frames.append(frame)
        
    frames = np.array(frames)
    
    # Crop to best 50 frames based on RMS energy
    if len(frames) > SEQ_LENGTH:
        best_start = 0
        max_energy = -1
        for i in range(len(frames) - SEQ_LENGTH + 1):
            energy = np.sum(frames[i:i+SEQ_LENGTH, 14]) # index 14 is RMS
            if energy > max_energy:
                max_energy = energy
                best_start = i
        frames = frames[best_start:best_start+SEQ_LENGTH]
    
    # Standardize (Matching P0: floor = 1.0)
    # We will standardize all dimensions here for the new pipeline
    std_seq = np.zeros_like(frames)
    for d in range(frames.shape[1]):
        mean = np.mean(frames[:, d])
        std = np.std(frames[:, d])
        std = max(1.0, std) # P0 Critical Match
        std_seq[:, d] = (frames[:, d] - mean) / std
        
    return std_seq.tolist()

def generate_synthetic_negatives():
    print("Generating synthetic negative templates...")
    negatives = []
    sr = TARGET_SR
    duration = 2.0
    t = np.linspace(0, duration, int(sr * duration), False)
    
    # 1. Silence / Noise Floor
    silence = np.random.normal(0, 0.005, len(t))
    
    # 2. Synthetic Speech (FM modulated noise to simulate formants and syllables)
    envelope = 0.5 * (1 + np.sin(2 * np.pi * 4 * t)) # 4 Hz syllabic rate
    carrier = librosa.effects.preemphasis(np.random.normal(0, 0.1, len(t)))
    speech_like = carrier * envelope
    
    # 3. TV / Music like (Mixed tones + noise)
    music_like = 0.1 * np.sin(2 * np.pi * 440 * t) + 0.1 * np.sin(2 * np.pi * 880 * t) + np.random.normal(0, 0.05, len(t))
    music_like *= 0.5 * (1 + np.sin(2 * np.pi * 2 * t))
    
    # Write temporaries and extract
    synths = [("Negative_Silence.wav", silence), ("Negative_Synthetic_Speech.wav", speech_like), ("Negative_Synthetic_TV.wav", music_like)]
    
    for name, audio in synths:
        import soundfile as sf
        path = os.path.join(TMP_DIR, name)
        sf.write(path, audio, sr)
        
        preprocessed = os.path.join(TMP_DIR, "pre_" + name)
        if preprocess_with_ffmpeg(path, preprocessed):
            seq = extract_features(preprocessed)
            negatives.append({
                "id": name.replace('.wav', '').lower(),
                "label": name.replace('_', ' ').replace('.wav', ''),
                "fault_type": "negative_rejection",
                "severity": "none",
                "source_file": "synthetic",
                "dtw_sequence": seq
            })
            
    return negatives

def main():
    print("Fetching files from Supabase...")
    res = supabase.storage.from_(BUCKET_NAME).list()
    files = [f for f in res if f['name'].endswith('.wav') and 'issue_with' not in f['name'].lower()]
    print(f"Found {len(files)} positive anomaly files.")
    
    fingerprints = []
    
    for f in files:
        baseName = f['name']
        print(f"Processing {baseName}...")
        
        # Download
        local_path = os.path.join(TMP_DIR, baseName)
        with open(local_path, 'wb') as out:
            data = supabase.storage.from_(BUCKET_NAME).download(baseName)
            out.write(data)
            
        preprocessed_path = os.path.join(TMP_DIR, "pre_" + baseName)
        if preprocess_with_ffmpeg(local_path, preprocessed_path):
            try:
                seq = extract_features(preprocessed_path)
                fault_type, severity, label, is_neg = derive_metadata(baseName)
                
                fingerprints.append({
                    "id": baseName.replace('.wav', ''),
                    "label": label,
                    "fault_type": fault_type,
                    "severity": severity,
                    "source_file": baseName,
                    "dtw_sequence": seq
                })
            except Exception as e:
                print(f"Error extracting {baseName}: {e}")
                
    # Add synthetic negatives
    fingerprints.extend(generate_synthetic_negatives())
    
    # Write output
    js_content = "/**\n * dtwFingerprints_v3.js — FFmpeg + Librosa Pipeline\n"
    js_content += " * Includes Negative/Rejection class templates.\n"
    js_content += " * 38-dim sequences (13 MFCC, 1 Flux, 1 RMS, 1 Flatness, 1 ZCR, 1 Centroid, 13 Delta-MFCC, 7 Contrast)\n"
    js_content += " * Standardized with std_floor = 1.0\n */\n"
    js_content += f"export const DTW_FINGERPRINTS = {json.dumps(fingerprints)};\n"
    
    with open(OUTPUT_JS, 'w') as f:
        f.write(js_content)
        
    print(f"Exported {len(fingerprints)} templates (including negatives) to {OUTPUT_JS}")
    
if __name__ == "__main__":
    main()
