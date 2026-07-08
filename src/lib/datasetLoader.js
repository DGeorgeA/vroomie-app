import { Logger } from './logger';

/**
 * Reference set loader — v9 architecture.
 *
 * References are NO LONGER generated in the browser. They are built offline by
 * scripts/build_reference_fingerprints.mjs (QC + loudness normalization +
 * mic/room augmentation + YAMNet embedding, int8-quantized) and shipped as a
 * versioned static artifact in public/fingerprints_v9.json.
 *
 * The artifact contains two populations:
 *   faults  — augmented embeddings of every QC-passing bucket recording,
 *             labeled by source file name
 *   anchors — healthy-engine and interferer embeddings ("compared to what?"),
 *             used by the margin decision rule in mlEmbeddingEngine.js
 *
 * To update references: change the bucket, re-run the factory script, commit
 * the regenerated JSON.
 */
const ARTIFACT_URL = `${import.meta.env.BASE_URL || '/'}fingerprints_v9.json`;

let cachedSet = null;
let loadPromise = null;

function dequantize(q) {
  const bin = atob(q.b64);
  const emb = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) emb[i] = q.min + bin.charCodeAt(i) * q.scale;
  return emb;
}

export async function loadReferenceSet() {
  if (cachedSet) return cachedSet;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    // Legacy in-browser fingerprint caches are obsolete — reclaim the space
    ['vroomie_yamnet_fingerprints_v7', 'vroomie_yamnet_fingerprints_v8'].forEach(k => {
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    });

    const res = await fetch(ARTIFACT_URL);
    if (!res.ok) throw new Error(`Reference artifact fetch failed: HTTP ${res.status}`);
    const art = await res.json();

    const faults = art.faults.map(f => ({
      label: f.label,
      fault_type: f.fault_type,
      severity: f.severity,
      source_file: f.source_file,
      emb: dequantize(f.q)
    }));
    const anchors = art.anchors.map(a => ({ kind: a.kind, emb: dequantize(a.q) }));

    cachedSet = { version: art.version, faults, anchors };
    Logger.info(`[Dataset] Reference set ${art.version}: ${faults.length} fault embeddings, ${anchors.length} anchors (${anchors.filter(a => a.kind === 'healthy').length} healthy)`);
    return cachedSet;
  })().catch(err => {
    loadPromise = null; // allow retry on next session
    throw err;
  });

  return loadPromise;
}
