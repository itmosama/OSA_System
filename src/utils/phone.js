// Mobile numbers are kept in international format (+<country code><number>), which is
// the form WhatsApp and SMS services expect. Spaces, dashes, dots and brackets are
// removed; a leading 00 becomes +. Qatar (+974) is the default country:
//   normalizePhone('+974 5512 3456') -> '+97455123456'
//   normalizePhone('5512 3456')      -> '+97455123456'   (local 8-digit number: +974 added)
//   normalizePhone('+974')           -> ''               (only the country code = no number)
//   normalizePhone('+971 50 123 4567') -> '+971501234567' (another country is kept)
//   normalizePhone('12ab')           -> null             (not a valid number)
const DEFAULT_COUNTRY = '974';

function normalizePhone(input, country = DEFAULT_COUNTRY) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return '';
  s = s.replace(/[\s().\-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s === '+' + country || s === country) return '';          // just the code, no number typed
  if (!/^\+?\d{7,15}$/.test(s)) return null;
  if (s.startsWith('+')) return s;
  if (/^\d{8}$/.test(s)) return '+' + country + s;              // local Qatar number
  return '+' + s;                                                // digits that already include a country code
}

module.exports = { normalizePhone, DEFAULT_COUNTRY };
