const { createClient } = require('@supabase/supabase-js');
const { dot, norm } = require('mathjs');
const WebSocket = require('ws');
require('dotenv').config();

// -- CONFIGURATION --
const PORT = 8080;

// -- SUPABASE CONNECTION --
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// -- SIMULATION UTILS --

// Simulate an embedding extraction model (e.g., VGGish or OpenL3)
// Returns a 384-dimensional vector
function extractEmbedding(audioBuffer) {
    // In a real app, this would use a native binding or call a Python microservice.
    // Here, we return a normalized random vector to simulate "feature extraction"
    const dim = 384;
    const vector = Array.from({ length: dim }, () => Math.random() - 0.5);
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    return vector.map(val => val / magnitude);
}

// Memory Cache for Reference Embeddings
let referenceCache = [];

async function loadReferences() {
    console.log("🔄 Loading Anomaly References from Supabase...");
    const { data, error } = await supabase
        .from('anomaly_references')
        .select('*');

    if (error) {
        console.error("❌ Error loading references:", error.message);
        return;
    }

    if (!data || data.length === 0) {
        console.warn("⚠️ No references found in DB. Matches will be random/low confidence.");
        // Fallback mock data if DB is empty for demo purposes
        referenceCache = [
            { name: "Engine Knock", embedding: extractEmbedding(null), confidence_threshold: 0.6 },
            { name: "Belt Squeal", embedding: extractEmbedding(null), confidence_threshold: 0.65 }
        ];
    } else {
        // Parse vector strings if needed (pgvector returns string representation usually)
        referenceCache = data.map(ref => ({
            ...ref,
            embedding: typeof ref.embedding === 'string' ? JSON.parse(ref.embedding) : ref.embedding
        }));
    }

    console.log(`✅ Loaded ${referenceCache.length} references.`);
}

function cosineSimilarity(vecA, vecB) {
    return dot(vecA, vecB) / (norm(vecA) * norm(vecB));
}

// -- MAIN LOGIC --

async function matchChunk(audioChunkBuffer) {
    const inputEmbedding = extractEmbedding(audioChunkBuffer);
    let bestMatch = null;
    let maxScore = -1;

    for (const ref of referenceCache) {
        const score = cosineSimilarity(inputEmbedding, ref.embedding);
        if (score > maxScore) {
            maxScore = score;
            bestMatch = ref;
        }
    }

    // Determine result based on threshold
    if (bestMatch && maxScore >= bestMatch.confidence_threshold) {
        return {
            status: 'anomaly_detected',
            anomaly: bestMatch.name,
            confidence: maxScore
        };
    } else if (bestMatch) {
        // Soft match (below threshold but close)
        return {
            status: 'uncertain',
            possible_anomaly: bestMatch.name,
            confidence: maxScore
        };
    }

    return { status: 'healthy', confidence: 1.0 - maxScore };
}

// -- WEBSOCKET SERVER --

async function startServer() {
    await loadReferences();

    const wss = new WebSocket.Server({ port: PORT });
    console.log(`🚀 WebSocket Server running on ws://localhost:${PORT}`);

    wss.on('connection', (ws) => {
        console.log('🔌 Client connected');

        ws.on('message', async (message) => {
            try {
                // message is a Buffer
                const result = await matchChunk(message);

                // Send back JSON result
                ws.send(JSON.stringify(result));

                // Logging
                if (result.status === 'anomaly_detected') {
                    console.log(`⚠️ Anomaly: ${result.anomaly} (${(result.confidence * 100).toFixed(1)}%)`);
                }
            } catch (err) {
                console.error("Processing error:", err);
                ws.send(JSON.stringify({ status: 'error', message: 'Internal processing error' }));
            }
        });

        ws.on('close', () => {
            console.log('Client disconnected');
        });
    });
}

// -- ENTRY POINT --
startServer();
