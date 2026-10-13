// Local history of every license this tool has generated. A simple JSON file
// is enough here — this is a single-operator local tool, not a multi-user app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_PATH = require('./paths').storePath;

function loadAll() {
  if (!fs.existsSync(STORE_PATH)) return [];
  let records;
  try {
    records = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    return [];
  }

  // Self-heal: records saved before recordId existed have none — backfill
  // and persist so their download link works too.
  let changed = false;
  records.forEach(r => {
    if (!r.recordId) { r.recordId = crypto.randomUUID(); changed = true; }
  });
  if (changed) fs.writeFileSync(STORE_PATH, JSON.stringify(records, null, 2));

  return records;
}

// Note: `record.id` is the human-entered license ID (e.g. "GH-0001") — the
// generated recordId below is this store's own internal row identifier and
// is deliberately a different field so the two never collide.
function saveRecord(record) {
  const all = loadAll();
  const recordId = crypto.randomUUID();
  all.push({ recordId, ...record });
  fs.writeFileSync(STORE_PATH, JSON.stringify(all, null, 2));
  return recordId;
}

function getByRecordId(recordId) {
  return loadAll().find(r => r.recordId === recordId);
}

// True if no existing license already uses this ID (case-insensitive,
// trimmed) — the ID is manually typed, so it needs an explicit uniqueness
// check rather than relying on auto-generation to avoid collisions.
function isLicenseIdTaken(id) {
  const normalized = id.trim().toLowerCase();
  return loadAll().some(r => (r.id || '').trim().toLowerCase() === normalized);
}

// Derives a short hotel code from the site name: initials of each word
// ("Grand Hotel" -> "GH"), or the first 3 letters if that's too short
// ("Sunset" -> "SUN").
function shortenSiteName(site) {
  const words = site.trim().split(/\s+/).filter(Boolean);
  const initials = words.map(w => w[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (initials.length >= 2) return initials;
  return site.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'HTL';
}

// Builds a serial number like "OSA-GH-2609-0001": OSA + short hotel code +
// YYMM + a sequence that resets each month, scoped per hotel code so two
// different hotels licensed in the same month don't share a counter. This is
// always auto-generated — separate from the manually-typed License ID.
function generateSerialNumber(site) {
  const now = new Date();
  const yymm = String(now.getFullYear()).slice(-2) + String(now.getMonth() + 1).padStart(2, '0');
  const code = shortenSiteName(site);
  const prefix = `OSA-${code}-${yymm}-`;
  const count = loadAll().filter(r => (r.sn || '').startsWith(prefix)).length;
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
}

// Adds computed fields (days remaining, expired flag) without mutating storage.
function listWithStatus() {
  const today = new Date().toISOString().slice(0, 10);
  const msPerDay = 24 * 60 * 60 * 1000;
  return loadAll()
    .map(r => {
      const expired = today > r.expires;
      const daysRemaining = Math.ceil((new Date(r.expires) - new Date(today)) / msPerDay);
      return { ...r, expired, daysRemaining };
    })
    .sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
}

module.exports = { saveRecord, listWithStatus, getByRecordId, generateSerialNumber, isLicenseIdTaken };
