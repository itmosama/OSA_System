# License Generator (Vendor Only)

**Never copy this folder, or `license-private-key.pem` from the project root, to any client's server.**
Doing so would hand them the private key and let them generate unlimited valid licenses for themselves.

## First-time setup

1. Generate the signing keypair, if you haven't already:
   ```bash
   node tools/generate-keypair.js
   ```
   This writes `license-private-key.pem` to the project root and prints a public key —
   that public key should already be in `src/utils/licenseCrypto.js`.

2. Set a password for this tool:
   ```bash
   node vendor-tool/set-password.js "your-password-here"
   ```
   This creates `vendor-tool/.env` with a hashed password. Never edit that file to add a plaintext password.

## Using it

```bash
npm run license-tool
```

Then open http://localhost:4100, sign in, and fill in the site name and expiry date. Copy the generated
license string and send it to the client to paste into their **Admin → License** page.

## What ships to clients vs. what doesn't

| Stays with you only | Goes to the client |
|---|---|
| `vendor-tool/` (this whole folder) | `src/`, `test/`, `package.json`, etc. |
| `license-private-key.pem` | `src/utils/licenseCrypto.js` (public key only) |
| `tools/generate-keypair.js`, `tools/generate-license.js` | Everything else |
