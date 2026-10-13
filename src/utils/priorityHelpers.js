// Pure helpers for custom priorities (no database access, so they're easy to test).

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isValidHex(value) {
  return typeof value === 'string' && HEX_RE.test(value);
}

function hexToRgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

// Black or white text, whichever reads better on this background colour.
function textColorFor(hex) {
  const [r, g, b] = hexToRgb(isValidHex(hex) ? hex : '#6c757d');
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#212529' : '#ffffff';
}

// A coloured circle emoji that best matches the colour, for use inside
// <select> options (which can't show a real colour swatch).
function emojiForColor(hex) {
  const [r, g, b] = hexToRgb(isValidHex(hex) ? hex : '#6c757d').map(v => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  if (saturation < 0.2) return lightness < 0.2 ? '⚫' : '⚪';

  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;

  if (hue < 15 || hue >= 345) return '🔴';
  if (hue < 40) return '🟠';
  if (hue < 70) return '🟡';
  if (hue < 170) return '🟢';
  if (hue < 260) return '🔵';
  return '🟣';
}

// Validates a name typed for a new priority. Returns { ok, name } or { ok:false, error }.
function validatePriorityName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'Priority name is required.' };
  if (name.length > 30) return { ok: false, error: 'Priority name must be 30 characters or fewer.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(name)) {
    return { ok: false, error: 'Priority name can only use letters, numbers, spaces and hyphens.' };
  }
  return { ok: true, name };
}

module.exports = { isValidHex, textColorFor, emojiForColor, validatePriorityName };
