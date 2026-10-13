const db = require('../db');

// Builds serials like "T-2509-0001" (Ticket, year 25, month 09, sequence) or
// "L-2509-0001" (Lost & Found). The sequence resets each calendar month, and
// the letter tells you at a glance which system the number belongs to.
function generateSerial(letter, table, column) {
  const now = new Date();
  const yymm = String(now.getFullYear()).slice(-2) + String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `${letter}-${yymm}-`;
  const row = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${column} LIKE ?`).get(`${prefix}%`);
  const next = (row.c || 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

// Builds serials like "ITR-2026-0001" — a fixed text prefix (not just a single
// letter), year in full (not short), sequence resetting each calendar year.
function generateYearlySerial(prefix, table, column) {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-`;
  const row = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${column} LIKE ?`).get(`${like}%`);
  const next = (row.c || 0) + 1;
  return `${like}${String(next).padStart(4, '0')}`;
}

module.exports = { generateSerial, generateYearlySerial };
