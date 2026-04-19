import { createClient } from '@supabase/supabase-js';
const supabase = createClient('https://bdldmkhcdtlqxaopxlam.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU');

async function test() {
  const { data } = await supabase.from('anomaly_references').select('*');
  console.log("Anomaly References Total entries:", data?.length);
  if (data && data.length > 0) {
    let vec = data[0].embedding_vector || data[0].features || data[0].vector;
    if (typeof vec === 'string') vec = JSON.parse(vec);
    console.log("Anomaly References Vector length:", vec?.length);
  }
}
test();
