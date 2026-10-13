const fs = require('fs');
const bcrypt = require('bcryptjs');
const { envPath } = require('./paths');

// Hashes the password and stores it in the tool's .env, replacing any previous
// one. Shared by `node vendor-tool/set-password.js` and `license-tool.exe set-password`.
function setPassword(password) {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  const hash = bcrypt.hashSync(password, 10);

  let lines = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf8').split('\n').filter(l => !l.startsWith('VENDOR_TOOL_PASSWORD_HASH='));
  }
  lines.push(`VENDOR_TOOL_PASSWORD_HASH=${hash}`);
  fs.writeFileSync(envPath, lines.filter(Boolean).join('\n') + '\n');
  return envPath;
}

module.exports = { setPassword };
