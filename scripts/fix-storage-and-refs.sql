-- =========================================================
-- Fix Storage RLS: Allow anon key to list & read the anomaly-patterns bucket
-- Run in Supabase Dashboard → SQL Editor
-- =========================================================

-- Allow anon to list and download files from the anomaly-patterns bucket
insert into storage.buckets (id, name, public)
values ('anomaly-patterns', 'anomaly-patterns', true)
on conflict (id) do update set public = true;

-- Drop conflicting policies if they exist  
drop policy if exists "Public anomaly-patterns read" on storage.objects;
drop policy if exists "Public anomaly-patterns list" on storage.objects;

-- Allow public SELECT (list + download) on anomaly-patterns
create policy "Public anomaly-patterns read"
on storage.objects for select
using (bucket_id = 'anomaly-patterns');

-- =========================================================
-- Create the anomaly_references table for the embedding engine
-- =========================================================
create table if not exists public.anomaly_references (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  label           text not null,           -- e.g. 'engine_knocking_high'
  category        text,                    -- e.g. 'engine_knock'
  severity        text default 'medium',   -- 'low' | 'medium' | 'high' | 'critical'
  source_file     text,                    -- original .wav filename
  storage_path    text,                    -- full path in anomaly-patterns bucket
  public_url      text,                    -- precomputed public URL
  embedding_vector jsonb,                  -- YAMNet 1024-dim embedding stored as JSON array
  spectrogram_url text,                    -- JSON spectrogram blob URL (optional)
  duration_ms     integer,
  notes           text
);

alter table public.anomaly_references enable row level security;

create policy "Public read refs"   on public.anomaly_references for select using (true);
create policy "Public insert refs" on public.anomaly_references for insert with check (true);
create policy "Public delete refs" on public.anomaly_references for delete using (true);

-- Verify both tables exist
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('analyses', 'anomaly_references');
