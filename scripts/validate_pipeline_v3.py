import os
import json
import numpy as np

# A simple fast DTW implementation mimicking the JS worker
def compute_dtw(seqA, seqB):
    n, m = len(seqA), len(seqB)
    if n == 0 or m == 0: return float('inf')
    
    dtw = np.full((n + 1, m + 1), float('inf'))
    dtw[0, 0] = 0
    window = max(abs(n - m), 2)
    
    for i in range(1, n + 1):
        start = max(1, i - window)
        end = min(m + 1, i + window + 1)
        for j in range(start, end):
            # Euclidean distance on first 14 dims matching worker
            diff = np.array(seqA[i-1][:14]) - np.array(seqB[j-1][:14])
            cost = np.sqrt(np.sum(diff**2))
            
            dtw[i, j] = cost + min(
                dtw[i-1, j],
                dtw[i, j-1],
                dtw[i-1, j-1]
            )
            
    return dtw[n, m] / (n + m)

def main():
    js_path = os.path.join(os.path.dirname(__file__), '..', 'src', 'data', 'dtwFingerprints_v3.js')
    if not os.path.exists(js_path):
        print("Error: dtwFingerprints_v3.js not found. Run generate_references_v3.py first.")
        return
        
    with open(js_path, 'r') as f:
        content = f.read()
        
    # Extract JSON part
    start_idx = content.find('[')
    end_idx = content.rfind(']') + 1
    if start_idx == -1 or end_idx == 0:
        print("Error parsing JSON array.")
        return
        
    data = json.loads(content[start_idx:end_idx])
    
    positives = [d for d in data if d.get('fault_type') != 'negative_rejection']
    negatives = [d for d in data if d.get('fault_type') == 'negative_rejection']
    
    print(f"Loaded {len(positives)} positive templates and {len(negatives)} negative templates.")
    
    # 1. Intra-class (Positive vs Positive)
    print("\n--- Positive vs Positive ---")
    pos_dists = []
    for i in range(len(positives)):
        for j in range(i+1, len(positives)):
            dist = compute_dtw(positives[i]['dtw_sequence'], positives[j]['dtw_sequence'])
            pos_dists.append(dist)
    
    mean_pos = np.mean(pos_dists) if pos_dists else 0
    max_pos = np.max(pos_dists) if pos_dists else 0
    print(f"Mean intra-positive DTW: {mean_pos:.3f}")
    print(f"Max intra-positive DTW: {max_pos:.3f}")
    
    # 2. Inter-class (Positive vs Negative)
    print("\n--- Positive vs Negative ---")
    neg_dists = []
    for p in positives:
        for n in negatives:
            dist = compute_dtw(p['dtw_sequence'], n['dtw_sequence'])
            neg_dists.append(dist)
            
    mean_neg = np.mean(neg_dists) if neg_dists else 0
    min_neg = np.min(neg_dists) if neg_dists else 0
    print(f"Mean pos-vs-neg DTW: {mean_neg:.3f}")
    print(f"Min pos-vs-neg DTW: {min_neg:.3f}")
    
    print("\n--- Validation Result ---")
    if min_neg > max_pos:
        print("SUCCESS: Perfect linear separability between positive and negative classes.")
    else:
        print("WARNING: Overlap exists between positive and negative classes. Worker ambiguity logic will handle edge cases.")
        
    recommended_thresh = (max_pos + min_neg) / 2 if (max_pos > 0 and min_neg > 0) else max_pos * 1.5
    print(f"Recommended maxDtwDistance threshold: {recommended_thresh:.3f}")
    
    # Generate Confusion Matrix based on recommended threshold
    print("\n--- Confusion Matrix (Threshold = {:.3f}) ---".format(recommended_thresh))
    true_positive = sum(1 for d in pos_dists if d <= recommended_thresh)
    false_negative = sum(1 for d in pos_dists if d > recommended_thresh)
    true_negative = sum(1 for d in neg_dists if d > recommended_thresh)
    false_positive = sum(1 for d in neg_dists if d <= recommended_thresh)
    
    print(f"               Predicted Positive | Predicted Negative")
    print(f"Actual Positive |      {true_positive:<14} | {false_negative:<14}")
    print(f"Actual Negative |      {false_positive:<14} | {true_negative:<14}")
    
    precision = true_positive / (true_positive + false_positive) if (true_positive + false_positive) > 0 else 0
    recall = true_positive / (true_positive + false_negative) if (true_positive + false_negative) > 0 else 0
    print(f"\nEstimated Precision: {precision:.2f}")
    print(f"Estimated Recall:    {recall:.2f}")

if __name__ == "__main__":
    main()
