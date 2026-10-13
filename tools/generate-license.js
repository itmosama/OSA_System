#!/usr/bin/env node
// Run this on your own machine (needs license-private-key.pem, created once
// by generate-keypair.js) to issue a license string to hand to a client.
//
// Usage:
//   node tools/generate-license.js --site "Grand Hotel" --expires 2027-01-01 [--id GH-0001] [--key ./license-private-key.pem]

const fs = require('fs');
const path = require('path');
const { buildLicenseString } = require('../src/utils/licenseCrypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const keyPath = args.key || path.join(__dirname, '..', 'license-private-key.pem');

if (!args.site || !args.expires) {
  console.error('Usage: node tools/generate-license.js --site "Hotel Name" --expires YYYY-MM-DD [--id LICENSE-ID] [--key path/to/private-key.pem]');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(args.expires)) {
  console.error('--expires must be in YYYY-MM-DD format.');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`Private key not found at ${keyPath}. Run tools/generate-keypair.js first.`);
  process.exit(1);
}

const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
const payload = {
  site: args.site,
  id: args.id || null,
  issued: new Date().toISOString().slice(0, 10),
  expires: args.expires,
};

const licenseString = buildLicenseString(payload, privateKeyPem);

console.log('\nLicense generated:\n');
console.log(licenseString);
console.log(`\nSite: ${payload.site}`);
if (payload.id) console.log(`License ID: ${payload.id}`);
console.log(`Issued: ${payload.issued}`);
console.log(`Expires: ${payload.expires}`);
console.log('\nHand the license string above to the client to paste into Admin → License.');
