const fs = require('fs');

const path = 'C:/Users/Deepak G A/DGeorgeA/vroomie-app/src/data/dtwFingerprints.js';
const data = fs.readFileSync(path, 'utf8');

const jsonStr = data.substring(data.indexOf('['), data.lastIndexOf(']') + 1);
const fingerprints = JSON.parse(jsonStr);

for (const fp of fingerprints) {
  console.log(`${fp.id}: Length ${fp.dtw_sequence.length}`);
}
