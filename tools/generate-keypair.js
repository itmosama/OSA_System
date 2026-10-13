#!/usr/bin/env node
// Run this ONCE, on your own machine — never on a client's server.
// Creates license-private-key.pem (KEEP THIS SECRET — back it up somewhere
// safe, never deploy it, never commit it) and prints the public key, which
// you paste into src/utils/license.js (PUBLIC_KEY_PEM) so every deployment
// of the app can verify licenses without ever needing the private key.
//
// Usage: node tools/generate-keypair.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outPath = path.join(__dirname, '..', 'license-private-key.pem');

if (fs.existsSync(outPath)) {
  console.error(`Refusing to overwrite existing ${outPath}.`);
  console.error('If you really want a new keypair, move or delete that file first —');
  console.error('but note this INVALIDATES every license you already issued.');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

fs.writeFileSync(outPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

console.log(`Private key written to: ${outPath}`);
console.log('Keep this file secret and back it up — anyone who has it can generate valid licenses.\n');
console.log('Paste the block below into src/utils/licenseCrypto.js as PUBLIC_KEY_PEM:\n');
console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString());
