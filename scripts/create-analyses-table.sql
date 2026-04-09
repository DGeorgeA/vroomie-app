-- =========================================================
-- Vroomie Supabase Schema Setup
-- Run this in: Supabase Dashboard → SQL Editor
-- =========================================================

-- 1. Create the analyses table
create table if not exists public.analyses (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),      -- server-side UTC, immutable
  vehicle_id    text,                                    -- optional, nullable for now
  audio_file_url text,                                   -- public URL of uploaded webm
  duration_seconds integer,
  status        text default 'completed',               -- 'completed' | 'flagged'
  confidence_score numeric(5,2),
  anomalies_detected jsonb default '[]'::jsonb,
  analysis_result    jsonb,
  detection_mode     text default 'basic',
  detection_source   text,
  ml_confidence      numeric(5,4),
  signal_similarity  numeric(5,4),
  final_decision     text,
  processed_at  timestamptz,
  notes         text
);

-- 2. Enable Row Level Security (RLS) — allow public reads/inserts for MVP
alter table public.analyses enable row level security;

-- Allow anyone to read (so the app can fetch history without auth)
create policy "Public read access" on public.analyses
  for select using (true);

-- Allow anyone to insert (recording completion writes here)
create policy "Public insert access" on public.analyses
  for insert with check (true);

-- Allow anyone to delete (for the Clear History button)
create policy "Public delete access" on public.analyses
  for delete using (true);

-- 3. Create index for ordering performance
create index if not exists analyses_created_at_idx on public.analyses (created_at desc);

-- =========================================================
-- Verification: check the table was created correctly
-- =========================================================
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'analyses' and table_schema = 'public'
order by ordinal_position;
