/**
 * verify_v5_dataset.mjs
 * 
 * Verifies that the audioDatasetService can correctly fetch and parse
 * the v5 JSON fingerprints from the Supabase bucket.
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function verifyDataset() {
  console.log('🔍 Verifying v5 JSON fingerprints in Supabase...');
  
  const { data: files, error: listError } = await supabase.storage
    .from('anomaly-patterns')
    .list('', { limit: 100 });

  if (listError) {
    console.error('❌ Failed to list bucket:', listError.message);
    return;
  }

  const jsonFiles = files.filter(f => f.name.endsWith('.json'));
  console.log(`Found ${jsonFiles.length} JSON files in bucket.`);

  if (jsonFiles.length === 0) {
    console.error('❌ No JSON files found! Matching will fall back to mock data.');
    return;
  }

  // Test downloading the first JSON file
  const testFile = jsonFiles[0].name;
  console.log(`Testing download for: ${testFile}...`);
  
  const { data: fileData, error: downloadError } = await supabase.storage
    .from('anomaly-patterns')
    .download(testFile);

  if (downloadError) {
    console.error(`❌ Failed to download ${testFile}:`, downloadError.message);
    return;
  }

  const text = await fileData.text();
  try {
    const pattern = JSON.parse(text);
    console.log('✅ Successfully parsed JSON.');
    console.log('--- Metadata ---');
    console.log(`Label: ${pattern.label}`);
    console.log(`Fault Type: ${pattern.fault_type}`);
    console.log(`Cosine Vector Length: ${pattern.cosine_vec?.length}`);
    console.log(`Pipeline: ${pattern.pipeline}`);
    
    if (pattern.cosine_vec?.length === 743) {
      console.log('✅ Vector length matches v5 expectation (743 bins).');
    } else {
      console.error(`❌ Vector length mismatch! Expected 743, got ${pattern.cosine_vec?.length}`);
    }

  } catch (e) {
    console.error('❌ JSON Parse Error:', e.message);
  }
}

verifyDataset();
