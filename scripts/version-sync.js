#!/usr/bin/env node
// Syncs version from package.json into both manifests. Run via npm `version` lifecycle hook.
const fs = require('fs');

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));

if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version)) {
  throw new Error(`Version "${version}" is not valid for browser extension stores (must be x.y.z or x.y.z.w).`);
}

for (const file of ['manifest.chrome.json', 'manifest.firefox.json']) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${file} → ${version}`);
}
