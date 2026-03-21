import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function listFiles() {
  const { data, error } = await supabase.storage.from('anomaly-patterns').list();
  if (error) {
    console.error('Error listing files:', error.message);
  } else {
    console.log('Files currently in anomaly-patterns bucket:');
    data.forEach(f => console.log(`- ${f.name} (${f.metadata?.size || 0} bytes)`));
  }
}
listFiles();
