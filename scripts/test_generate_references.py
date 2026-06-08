import os
import json
import pytest
import numpy as np
import soundfile as sf
import subprocess

from generate_references_v3 import preprocess_with_ffmpeg, extract_features

TARGET_SR = 16000
TMP_DIR = os.path.join(os.path.dirname(__file__), 'tmp_test_audio')

@pytest.fixture(scope="session", autouse=True)
def setup_teardown():
    os.makedirs(TMP_DIR, exist_ok=True)
    yield
    # We could clean up TMP_DIR here, but for debugging we'll leave it for now.

def test_preprocessing_ffmpeg():
    # 1. Generate a dummy 44.1kHz stereo WAV
    dummy_path = os.path.join(TMP_DIR, 'dummy_44k.wav')
    out_path = os.path.join(TMP_DIR, 'dummy_preprocessed.wav')
    
    sr = 44100
    t = np.linspace(0, 1.0, sr, False)
    # Loud sine wave
    sine = 0.8 * np.sin(2 * np.pi * 440 * t)
    stereo = np.column_stack((sine, sine))
    sf.write(dummy_path, stereo, sr)
    
    # Run preprocessing
    success = preprocess_with_ffmpeg(dummy_path, out_path)
    assert success == True
    
    # Assert output is 16kHz mono and loudnorm applied
    data, out_sr = sf.read(out_path)
    assert out_sr == 16000
    assert len(data.shape) == 1  # Mono
    # Ensure it's not silent
    assert np.max(np.abs(data)) > 0.1

def test_feature_extraction_shapes():
    # Provide a valid preprocessed 16kHz file
    dummy_path = os.path.join(TMP_DIR, 'dummy_16k.wav')
    sr = 16000
    t = np.linspace(0, 2.0, sr * 2, False)
    sine = 0.5 * np.sin(2 * np.pi * 1000 * t)
    sf.write(dummy_path, sine, sr)
    
    seq = extract_features(dummy_path)
    
    # Assert dimensions
    assert isinstance(seq, list)
    assert len(seq) == 50  # SEQ_LENGTH
    assert len(seq[0]) == 38  # 13 MFCC + 13 Delta + 7 Contrast + 5 base
    
    # Assert standardisation (floor 1.0 constraint implies values won't explode to huge std)
    seq_np = np.array(seq)
    for i in range(38):
        std = np.std(seq_np[:, i])
        # After standardization with floor 1.0, the max std should be around 1.0
        # If the original std was < 1.0, it will be < 1.0. If it was >= 1.0, it will be 1.0.
        assert std <= 1.01

def test_schema_dtw_json():
    # Run the main script to generate synthetic ones at least
    js_path = os.path.join(os.path.dirname(__file__), '..', 'src', 'data', 'dtwFingerprints_v3.js')
    
    # Parse the JS file
    with open(js_path, 'r') as f:
        content = f.read()
    
    start_idx = content.find('[')
    end_idx = content.rfind(']') + 1
    assert start_idx != -1
    
    data = json.loads(content[start_idx:end_idx])
    
    # Verify fields
    for item in data:
        assert 'id' in item
        assert 'fault_type' in item
        assert 'dtw_sequence' in item
        assert len(item['dtw_sequence']) == 50
        assert len(item['dtw_sequence'][0]) == 38

    # Ensure negative classes exist
    negatives = [d for d in data if d['fault_type'] == 'negative_rejection']
    assert len(negatives) >= 3 # Silence, Speech, TV
