const db = require('../db');

const OPEN_STATUSES = ['Open', 'In Progress', 'On Hold'];

function getSlaMap() {
  const rows = db.prepare('SELECT * FROM priority_slas').all();
  const map = {};
  rows.forEach(r => { map[r.priority] = r.minutes; });
  return map;
}

// SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" — convert to a real Date.
function sqliteDateToUtc(sqliteDate) {
  if (!sqliteDate) return null;
  return new Date(sqliteDate.replace(' ', 'T') + 'Z');
}

function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Adds SLA-related fields to a ticket row (mutates & returns it):
//   createdAtIso, dueAtIso, finishedAtIso, isFinished, isOverdue, slaMinutes,
//   slaStatus: 'green' (on track) | 'yellow' (nearing due) | 'red' (overdue/late) | null (no SLA set)
function attachSlaInfo(ticket, slaMap) {
  const minutes = slaMap[ticket.priority];
  const createdAt = sqliteDateToUtc(ticket.created_at);
  let dueAt = null;
  if (minutes && createdAt) {
    dueAt = new Date(createdAt.getTime() + minutes * 60 * 1000);
  }
  const isFinished = !OPEN_STATUSES.includes(ticket.status);
  const finishedAt = ticket.status === 'Resolved' ? sqliteDateToUtc(ticket.resolved_at)
    : ticket.status === 'Closed' ? sqliteDateToUtc(ticket.closed_at)
    : null;

  ticket.slaMinutes = minutes || null;
  ticket.createdAtIso = createdAt ? createdAt.toISOString() : null;
  ticket.dueAtIso = dueAt ? dueAt.toISOString() : null;
  ticket.finishedAtIso = finishedAt ? finishedAt.toISOString() : null;
  ticket.isFinished = isFinished;
  ticket.isOverdue = false;
  ticket.slaStatus = null;

  const referenceTime = isFinished ? finishedAt : new Date();

  if (dueAt && createdAt && referenceTime) {
    const totalWindow = dueAt.getTime() - createdAt.getTime();
    const elapsed = referenceTime.getTime() - createdAt.getTime();
    const percent = totalWindow > 0 ? elapsed / totalWindow : 1;
    ticket.isOverdue = referenceTime.getTime() > dueAt.getTime();
    if (ticket.isOverdue) ticket.slaStatus = 'red';
    else if (percent >= 0.75) ticket.slaStatus = 'yellow';
    else ticket.slaStatus = 'green';
  }

  return ticket;
}

module.exports = { OPEN_STATUSES, getSlaMap, sqliteDateToUtc, attachSlaInfo, formatMinutes };
