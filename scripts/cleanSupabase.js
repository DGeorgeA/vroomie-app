import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function cleanDB() {
  console.log('Cleaning anomaly_embeddings table...');
  const { data, error } = await supabase
    .from('anomaly_embeddings')
    .delete()
    .or('label.ilike.%Issue_with%,label.ilike.%power_steering%,label.ilike.%serpentine_belt%,label.ilike.%low_oil%');

  if (error) {
    console.error('Error deleting rows:', error.message);
  } else {
    console.log('Successfully deleted contaminated rows');
  }
}

cleanDB();
