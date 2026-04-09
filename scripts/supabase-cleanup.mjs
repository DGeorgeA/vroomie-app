import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const supabase = createClient(supabaseUrl, supabaseKey);

// Test using the Supabase REST API via rpc if rpc exists or direct fetch
const MANAGEMENT_URL = `${supabaseUrl}/rest/v1/`;

async function main() {
  console.log('=== Testing Supabase Connection ===\n');

  // Test 1: Try inserting a test record to check if table exists
  console.log('1. Testing analyses table via insert...');
  const { data: insertData, error: insertErr } = await supabase
    .from('analyses')
    .insert([{
      confidence_score: 99.0,
      status: 'test',
      notes: 'Schema test - safe to delete',
      anomalies_detected: [],
    }])
    .select()
    .single();

  if (insertErr) {
    console.log('   ❌ Insert failed:', insertErr.message);
    console.log('   Code:', insertErr.code);
    console.log('\n   👉 ACTION REQUIRED: The analyses table does not exist.');
    console.log('   Please run this SQL in your Supabase Dashboard → SQL Editor:');
    console.log('\n' + '─'.repeat(60));
    printSQL();
    console.log('─'.repeat(60));
  } else {
    console.log('   ✅ Table exists! Test record inserted:', insertData?.id);
    
    // Clean up test record
    await supabase.from('analyses').delete().eq('id', insertData.id);
    console.log('   ✅ Test record cleaned up.');
    
    // Now delete old mock records
    console.log('\n2. Deleting old mock analyses...');
    const { error: delErr, count } = await supabase
      .from('analyses')
      .delete({ count: 'exact' })
      .gte('created_at', '2000-01-01');

    if (delErr) {
      console.log('   ❌ Delete error:', delErr.message);
    } else {
      console.log(`   ✅ Cleared ${count ?? 0} old record(s).`);
    }
  }

  // Test storage
  console.log('\n3. Checking anomaly-patterns storage bucket...');
  const { data: files, error: stErr } = await supabase.storage
    .from('anomaly-patterns')
    .list('', { limit: 100 });

  if (stErr) {
    console.log('   ❌ Storage error:', stErr.message);
  } else if (files.length === 0) {
    console.log('   ⚠️  Bucket is empty. No .wav reference files found.');
    console.log('   Upload your engine fault .wav files to: anomaly-patterns bucket');
  } else {
    console.log(`   ✅ Found ${files.length} file(s):`);
    files.forEach(f => console.log(`   - ${f.name}`));
  }
}

function printSQL() {
  console.log(`
create table if not exists public.analyses (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  vehicle_id       text,
  audio_file_url   text,
  duration_seconds integer,
  status           text default 'completed',
  confidence_score numeric(5,2),
  anomalies_detected jsonb default '[]'::jsonb,
  analysis_result  jsonb,
  detection_mode   text default 'basic',
  detection_source text,
  ml_confidence    numeric(5,4),
  signal_similarity numeric(5,4),
  final_decision   text,
  processed_at     timestamptz,
  notes            text
);

alter table public.analyses enable row level security;

create policy "Public read"   on public.analyses for select using (true);
create policy "Public insert" on public.analyses for insert with check (true);
create policy "Public delete" on public.analyses for delete using (true);

create index if not exists analyses_created_at_idx on public.analyses (created_at desc);
`);
}

main();
