import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://bdldmkhcdtlqxaopxlam.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU'
);

const { data, error } = await supabase
  .from('analyses')
  .select('id, created_at, processed_at')
  .order('created_at', { ascending: false })
  .limit(10);

if (error) {
  console.error('DB Error:', error.message);
  process.exit(1);
}

console.log('\n=== TIMESTAMP AUDIT (Latest 10 rows) ===\n');
data.forEach((r, i) => {
  console.log(
    `${i + 1}. id=${r.id?.substring(0, 8)} | created_at=${r.created_at} | processed_at=${r.processed_at}`
  );
});

// Check for duplicates
const timestamps = data.map(r => r.created_at);
const unique = new Set(timestamps);
console.log(`\nTotal rows: ${data.length} | Unique created_at timestamps: ${unique.size}`);
if (unique.size === data.length) {
  console.log('✅ PASS: All timestamps are UNIQUE');
} else {
  console.log('❌ FAIL: Duplicate timestamps detected!');
  // Find the duplicates
  const seen = {};
  timestamps.forEach(ts => { seen[ts] = (seen[ts] || 0) + 1; });
  Object.entries(seen).filter(([, v]) => v > 1).forEach(([ts, count]) => {
    console.log(`   DUPLICATE: ${ts} appears ${count} times`);
  });
}
