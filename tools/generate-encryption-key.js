#!/usr/bin/env node
// Generates the symmetric key used to encrypt/decrypt .lic license files.
// Unlike the Ed25519 signing keypair (private half stays only with you), this
// key must be embedded in BOTH the vendor tool (to encrypt) and every client
// deployment (to decrypt an uploaded file) — it's not a secret from clients,
// just an obfuscation layer so the file isn't plain readable text. The real
// tamper-proofing is still the Ed25519 signature inside the license.
//
// Run once, then paste the printed value into src/utils/licenseCrypto.js as
// FILE_ENCRYPTION_KEY_HEX. Only re-run this if you want to invalidate every
// .lic file you've issued so far (they'd fail to decrypt with a new key).

const crypto = require('crypto');
console.log('Paste this into src/utils/licenseCrypto.js as FILE_ENCRYPTION_KEY_HEX:\n');
console.log(crypto.randomBytes(32).toString('hex'));
