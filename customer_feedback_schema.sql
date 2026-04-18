-- ─────────────────────────────────────────────────────────────────────────────
-- Vroomie: customer_feedback table
-- Run this ONCE in the Supabase SQL Editor for the project:
--   https://supabase.com/dashboard/project/bdldmkhcdtlqxaopxlam/sql/new
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_feedback (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rating     INT    CHECK (rating >= 1 AND rating <= 10),
  comment    TEXT,
  user_name  TEXT   DEFAULT NULL,
  created_at TIMESTAMP DEFAULT now()
);

-- Enable Row Level Security (keeps data safe)
ALTER TABLE customer_feedback ENABLE ROW LEVEL SECURITY;

-- Allow anonymous inserts (the anonymous Supabase key lets the app insert)
CREATE POLICY "Allow anonymous inserts" ON customer_feedback
  FOR INSERT
  WITH CHECK (true);

-- Optionally: restrict reads to authenticated users only (uncomment to activate)
-- CREATE POLICY "Authenticated users can read feedback" ON customer_feedback
--   FOR SELECT
--   TO authenticated
--   USING (true);
