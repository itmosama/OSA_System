const crypto = require('crypto');

// This is the PUBLIC half of the signing key only — safe to ship inside the
// app. It can verify a license signature but cannot create one. The PRIVATE
// key that actually generates licenses lives only in license-private-key.pem
// on the vendor's own machine (see tools/generate-keypair.js) and must never
// be copied into a client deployment.
//
// Replace this placeholder by running `node tools/generate-keypair.js` once
// and pasting the "PUBLIC KEY" block it prints here.
const PUBLIC_KEY_PEM = process.env.LICENSE_PUBLIC_KEY_PEM || `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2O11nMAl8vaixzlGp5XTVS8zLjOI/B9Cm3w+Kqz3zj8=
-----END PUBLIC KEY-----`;

// Symmetric key for encrypting/decrypting .lic license FILES. Unlike the
// signing keypair above, this key ships in every deployment (the app needs
// it to decrypt an uploaded file) — it is not secret from clients, it's an
// obfuscation layer so a .lic file isn't plain readable text if opened in an
// editor. The real tamper-proofing is still the Ed25519 signature verified
// in parseAndVerify() below, which runs on the decrypted contents regardless
// of how the license arrived (pasted string or uploaded file).
// Generated once via tools/generate-encryption-key.js.
const FILE_ENCRYPTION_KEY_HEX = process.env.LICENSE_FILE_KEY_HEX
  || '9ed5d0e814275f82a06d0b7201f48e9f8a3ea773e1daf1704a7c8d6ed06542ab';
const FILE_KEY = Buffer.from(FILE_ENCRYPTION_KEY_HEX, 'hex');

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Builds the exact string a license consists of: base64url(payload JSON) +
// "." + base64url(signature over that same payload segment). Shared by both
// the generator tool and the app's verifier so they can never drift apart.
function buildLicenseString(payload, privateKeyPem) {
  const payloadSegment = base64url(JSON.stringify(payload));
  const signature = crypto.sign(null, Buffer.from(payloadSegment), privateKeyPem);
  return `${payloadSegment}.${signature.toString('base64url')}`;
}

// Verifies a license string's signature and shape. Does NOT check the date —
// that's a separate, simpler check so "expired" and "invalid/tampered" can be
// reported distinctly.
function parseAndVerify(licenseString) {
  if (!licenseString || typeof licenseString !== 'string' || !licenseString.includes('.')) {
    return { ok: false, error: 'License is not in a recognizable format.' };
  }
  const [payloadSegment, sigSegment] = licenseString.trim().split('.');
  if (!payloadSegment || !sigSegment) {
    return { ok: false, error: 'License is not in a recognizable format.' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch (e) {
    return { ok: false, error: 'License payload could not be read.' };
  }

  let signatureValid;
  try {
    signatureValid = crypto.verify(
      null,
      Buffer.from(payloadSegment),
      PUBLIC_KEY_PEM,
      Buffer.from(sigSegment, 'base64url')
    );
  } catch (e) {
    return { ok: false, error: 'License signature could not be verified.' };
  }

  if (!signatureValid) {
    return { ok: false, error: 'License signature is invalid — this license was not issued for this software, or has been altered.' };
  }
  if (!payload.expires || !payload.site) {
    return { ok: false, error: 'License is missing required fields.' };
  }

  return { ok: true, payload };
}

// Encrypts a license string into a binary .lic file: [12-byte IV][16-byte
// auth tag][ciphertext]. AES-256-GCM gives us tamper-detection on the file
// wrapper itself too (on top of the signature already inside the payload).
function encryptLicenseFile(licenseString) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', FILE_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(licenseString, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

// Reverses encryptLicenseFile(). Throws if the file is corrupt, wasn't
// encrypted with this key, or has been tampered with.
function decryptLicenseFile(fileBuffer) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length < 29) {
    throw new Error('File is too small to be a valid license file.');
  }
  const iv = fileBuffer.subarray(0, 12);
  const authTag = fileBuffer.subarray(12, 28);
  const ciphertext = fileBuffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', FILE_KEY, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { buildLicenseString, parseAndVerify, encryptLicenseFile, decryptLicenseFile };
