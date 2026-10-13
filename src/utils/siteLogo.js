// The hotel logo for exported files (PDF / Excel). PDF and Excel can embed PNG and JPEG;
// the upload page converts every picture to PNG, so older uploads in another
// format simply export without a logo instead of failing.
const fs = require('fs');
const path = require('path');
const { getSetting } = require('./appSettings');
const { uploadsDir } = require('./appPaths');

function pngSize(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504E47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xC0 && m <= 0xC3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

// -> { path, buffer, ext: 'png'|'jpeg', width, height } or null
function getExportLogo() {
  const name = getSetting('site_logo');
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const file = path.join(uploadsDir, name);
  try {
    const buffer = fs.readFileSync(file);
    const png = pngSize(buffer);
    if (png) return { path: file, buffer, ext: 'png', ...png };
    const jpg = jpegSize(buffer);
    if (jpg) return { path: file, buffer, ext: 'jpeg', ...jpg };
  } catch (e) { /* missing file: export without a logo */ }
  return null;
}

module.exports = { getExportLogo };
