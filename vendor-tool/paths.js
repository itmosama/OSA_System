const path = require('path');

// When packaged into an .exe, __dirname points inside the read-only bundle, so
// the files that must persist (password, issued-license history, private key)
// live in the folder next to the .exe instead. In normal `npm run
// license-tool` use they stay where they always were.
const packaged = !!process.pkg;
const dataDir = packaged ? path.dirname(process.execPath) : __dirname;

module.exports = {
  packaged,
  dataDir,
  envPath: path.join(dataDir, '.env'),
  storePath: path.join(dataDir, 'licenses.json'),
  keyPath: process.env.VENDOR_TOOL_PRIVATE_KEY_PATH
    || (packaged ? path.join(dataDir, 'license-private-key.pem') : path.join(__dirname, '..', 'license-private-key.pem')),
  viewsDir: path.join(__dirname, 'views'),
};
