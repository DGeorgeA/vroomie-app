import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function probe() {
  console.log('Probing anomaly_references schema...\n');

  // 1. Insert with a 1024-dim vector (zeros) to match pgvector column
  const vec1024 = new Array(1024).fill(0.0);
  const { data, error } = await supabase
    .from('anomaly_references')
    .insert([{ label: '_probe_', category: '_test_', embedding_vector: vec1024 }])
    .select()
    .single();
  
  if (error) {
    console.log('Insert with 1024-dim vector failed:', error.message);
    
    // Try without embedding_vector
    const { data: d2, error: e2 } = await supabase
      .from('anomaly_references')
      .insert([{ label: '_probe_', category: '_test_' }])
      .select()
      .single();
    
    if (e2) {
      console.log('Minimal insert also failed:', e2.message);
    } else {
      console.log('✅ Columns (from minimal row):', Object.keys(d2).join(', '));
      await supabase.from('anomaly_references').delete().eq('id', d2.id);
    }
  } else {
    console.log('✅ Columns available:', Object.keys(data).join(', '));
    console.log('   embedding_vector type: VECTOR(1024) confirmed');
    await supabase.from('anomaly_references').delete().eq('id', data.id);
    console.log('Probe row removed.');
  }
}

probe();
