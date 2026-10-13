const db = require('../db');
const { parseAndVerify } = require('./licenseCrypto');

function getActiveLicense() {
  return db.prepare('SELECT * FROM license WHERE id = 1').get();
}

// The single function the rest of the app should call. Combines "is there an
// activated license at all", "is its signature still valid", and "has it
// expired" into one status object.
function getLicenseStatus() {
  const row = getActiveLicense();
  if (!row) {
    return { activated: false, valid: false, expired: false, daysRemaining: null };
  }

  const check = parseAndVerify(row.license_string);
  if (!check.ok) {
    return { activated: true, valid: false, expired: false, daysRemaining: null, error: check.error };
  }

  const today = new Date().toISOString().slice(0, 10);
  const expired = today > check.payload.expires;
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.ceil((new Date(check.payload.expires) - new Date(today)) / msPerDay);

  return {
    activated: true,
    valid: !expired,
    expired,
    daysRemaining,
    site: check.payload.site,
    licenseId: check.payload.id || null,
    serialNumber: check.payload.sn || null,
    issued: check.payload.issued || null,
    expires: check.payload.expires,
  };
}

// Activates a new license string: verifies it, then replaces whatever was
// stored before (single-row table — one active license at a time).
function activateLicense(licenseString, activatedByUserId) {
  const check = parseAndVerify(licenseString);
  if (!check.ok) return { ok: false, error: check.error };

  db.prepare('DELETE FROM license WHERE id = 1').run();
  db.prepare(`
    INSERT INTO license (id, license_string, site, license_id, issued_date, expires_date, activated_by)
    VALUES (1, ?, ?, ?, ?, ?, ?)
  `).run(
    licenseString, check.payload.site, check.payload.id || null,
    check.payload.issued || null, check.payload.expires, activatedByUserId
  );
  return { ok: true };
}

module.exports = { getActiveLicense, getLicenseStatus, activateLicense };
