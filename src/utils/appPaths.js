const path = require('path');

// Where the app keeps files that must survive restarts (database, photos,
// settings). Normally that is the project folder. When the app is packaged into
// a single .exe, __dirname points inside the read-only bundle, so these live in
// the folder next to the .exe instead.
const packaged = !!process.pkg;
const baseDir = packaged ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');

module.exports = {
  packaged,
  baseDir,
  dataDir: path.join(baseDir, 'data'),
  uploadsDir: path.join(baseDir, 'uploads'),
  envPath: path.join(baseDir, '.env'),
};
