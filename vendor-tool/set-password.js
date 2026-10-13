#!/usr/bin/env node
// Sets (or changes) the password for the vendor-only license tool.
// Usage: node vendor-tool/set-password.js "your-new-password"

const { setPassword } = require('./password');

try {
  const where = setPassword(process.argv[2]);
  console.log(`Password set. Saved (hashed) to ${where}.`);
} catch (e) {
  console.error('Usage: node vendor-tool/set-password.js "your-new-password"');
  console.error(e.message);
  process.exit(1);
}
