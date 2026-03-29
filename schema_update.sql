-- =========================================================================
-- Vroomie Advanced Audio Pipeline: Supabase Schema Update
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
-- =========================================================================

-- 1. Enable pgvector extension for ML embedding distances
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create the advanced anomaly_references table
-- This replaces the need to download and decode audio on every app load.
CREATE TABLE IF NOT EXISTS anomaly_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  category TEXT DEFAULT 'Anomaly',
  source_file TEXT,
  embedding_vector vector(1024), -- YAMNet output is 1024-d
  spectrogram_url TEXT, -- URL to a cached JSON / PNG of the spectrogram
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Set up Row Level Security (Read-Only for Public/Users, Admin for writes)
ALTER TABLE anomaly_references ENABLE ROW LEVEL SECURITY;

-- Allow anyone (or authenticated users) to read the reference library
CREATE POLICY "Public Read Access" on anomaly_references FOR SELECT USING (true);

-- (Optional Admin Policy) 
-- CREATE POLICY "Admin Write Access" on anomaly_references FOR ALL USING (auth.role() = 'service_role');

-- 4. Enable Fast Cosine Distance querying via IVFFlat index 
-- (optional, but good if the dataset grows > 1000 items)
CREATE INDEX ON anomaly_references USING ivfflat (embedding_vector vector_cosine_ops) WITH (lists = 100);

-- =========================================================================
-- QUICK CHECK:
-- To insert your first reference (done via the app or API):
-- INSERT INTO anomaly_references (label, source_file, embedding_vector) 
-- VALUES ('piston_knock', 'piston_knock.wav', '[0.123, 0.456, ...]');
-- =========================================================================
