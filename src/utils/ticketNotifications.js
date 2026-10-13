// Ticket notifications: the bell list and the pop-up feed.
// A user is told about NEW tickets and about UPDATES (comments, status or
// assignment changes) on tickets that concern them: ones they raised, ones assigned
// to them, and ones tied to their own department (requested of it, raised from it,
// or routed to it by request type). Admins hear about every ticket.
const db = require('../db');
const { hasDepartmentView } = require('./ticketAccess');
const { getStates } = require('./notificationStates');

// SQL limiting alias `a` (a tickets row) to the tickets this user should hear about.
function notificationScope(user, perms, a = 't') {
  if (user.role === 'admin') return { sql: '1 = 1', params: [] };
  const own = [`${a}.created_by = ?`, `${a}.assigned_to = ?`];
  const params = [user.id, user.id];
  // A requester only gets department news if their group lets them see department tickets.
  const deptAllowed = user.role !== 'requester' || hasDepartmentView(user, perms);
  const d = Number(user.department_id);
  if (deptAllowed && Number.isInteger(d) && d > 0) {
    own.push(
      `${a}.department_id = ?`,
      `${a}.requester_department_id = ?`,
      `EXISTS (SELECT 1 FROM request_types nrt WHERE nrt.id = ${a}.request_type_id AND nrt.handling_department_id = ?)`
    );
    params.push(d, d, d);
  }
  return { sql: `(${own.join(' OR ')})`, params };
}

function snippet(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > 70 ? s.slice(0, 67) + '...' : s;
}

// Everything for the bell: recent events newest first, plus how many are unread.
function getTicketBell(user, perms, opts = {}) {
  const limit = opts.limit || 12;
  const days = Math.max(1, Math.min(90, Number(opts.days) || 7));
  const WINDOW = `-${days} days`;
  const scope = notificationScope(user, perms);
  const seenRow = db.prepare('SELECT notif_seen_at FROM users WHERE id = ?').get(user.id);
  let seenAt = seenRow && seenRow.notif_seen_at;
  if (!seenAt) { // first time for this account: start clean rather than flag a week of history
    markTicketBellRead(user.id);
    seenAt = '9999-12-31 00:00:00';
  }

  const events = db.prepare(`
    SELECT * FROM (
      SELECT 'new' AS kind, t.id AS ticket_id, t.ticket_number, t.subject, t.created_at AS at,
             cu.full_name AS actor, '' AS body
      FROM tickets t LEFT JOIN users cu ON cu.id = t.created_by
      WHERE ${scope.sql} AND t.created_by != ? AND t.created_at >= datetime('now', '${WINDOW}')
      UNION ALL
      SELECT 'update', t.id, t.ticket_number, t.subject, c.created_at, cu.full_name, c.body
      FROM ticket_comments c
      JOIN tickets t ON t.id = c.ticket_id
      LEFT JOIN users cu ON cu.id = c.user_id
      WHERE ${scope.sql} AND c.user_id != ? AND c.created_at >= datetime('now', '${WINDOW}')
    ) ORDER BY at DESC
  `).all(...scope.params, user.id, ...scope.params, user.id);

  const states = getStates(user.id);
  const shown = events
    .map(e => ({ ...e, key: `t:${e.ticket_id}:${e.kind}:${e.at}` }))
    .filter(e => { const st = states.get(e.key); return !st || (opts.includeArchived && st === 'archived'); });
  const unread = shown.filter(e => e.at > seenAt && !states.get(e.key)).length;
  const items = shown.slice(0, limit).map(e => ({
    key: e.key,
    archived: states.get(e.key) === 'archived',
    kind: e.kind,
    ticketId: e.ticket_id,
    ticketNumber: e.ticket_number,
    subject: e.subject,
    actor: e.actor || 'Someone',
    text: e.kind === 'new' ? 'New ticket' : snippet(e.body),
    at: e.at,
    unread: e.at > seenAt && !states.get(e.key),
  }));
  return { unread, items };
}

function markTicketBellRead(userId) {
  db.prepare("UPDATE users SET notif_seen_at = datetime('now') WHERE id = ?").run(userId);
}

// Lost & Found news. Staff who work with lost property (admins, agents, or a group that
// can manage/delete items) hear about every new item and every update; anyone else
// only hears about updates on items they logged themselves.
function getLostFoundBell(user, perms, opts = {}) {
  const limit = opts.limit || 8;
  const days = Math.max(1, Math.min(90, Number(opts.days) || 7));
  const WINDOW = `-${days} days`;
  const seesAll = user.role === 'admin' || user.role === 'agent' || perms.can_manage_lost_found || perms.can_edit_delete_lost_found;
  const seenRow = db.prepare('SELECT notif_seen_at FROM users WHERE id = ?').get(user.id);
  const seenAt = (seenRow && seenRow.notif_seen_at) || '9999-12-31 00:00:00';
  const scope = seesAll ? '1 = 1' : 'i.created_by = ?';
  const scopeParams = seesAll ? [] : [user.id];

  const events = db.prepare(`
    SELECT * FROM (
      SELECT 'new' AS kind, i.id AS item_id, i.serial_number, i.item_description, i.created_at AS at,
             cu.full_name AS actor, '' AS body
      FROM lost_found_items i LEFT JOIN users cu ON cu.id = i.created_by
      WHERE ${seesAll ? '1 = 1' : '0 = 1'} AND i.created_by != ? AND i.created_at >= datetime('now', '${WINDOW}')
      UNION ALL
      SELECT 'update', i.id, i.serial_number, i.item_description, c.created_at, cu.full_name, c.body
      FROM lost_found_comments c
      JOIN lost_found_items i ON i.id = c.item_id
      LEFT JOIN users cu ON cu.id = c.user_id
      WHERE ${scope} AND c.user_id != ? AND c.created_at >= datetime('now', '${WINDOW}')
    ) ORDER BY at DESC
  `).all(user.id, ...scopeParams, user.id);

  const states = getStates(user.id);
  const shown = events
    .map(e => ({ ...e, key: `l:${e.item_id}:${e.kind}:${e.at}` }))
    .filter(e => { const st = states.get(e.key); return !st || (opts.includeArchived && st === 'archived'); });
  return {
    unread: shown.filter(e => e.at > seenAt && !states.get(e.key)).length,
    items: shown.slice(0, limit).map(e => ({
      key: e.key, archived: states.get(e.key) === 'archived',
      kind: e.kind, itemId: e.item_id, serial: e.serial_number || ('#' + e.item_id), name: e.item_description,
      actor: e.actor || 'Someone',
      text: e.kind === 'new' ? 'New item logged' : snippet(e.body),
      at: e.at, unread: e.at > seenAt && !states.get(e.key),
    })),
  };
}

// Maintenance tasks that need attention: overdue, or due within a week, for tasks
// assigned to the user or to their department (admins see all).
function getMaintenanceAlerts(user, perms, opts = {}) {
  const limit = opts.limit || 20;
  const params = [];
  let scope = '1 = 1';
  if (user.role !== 'admin') {
    const d = Number(user.department_id);
    const hasDept = Number.isInteger(d) && d > 0;
    scope = '(t.assigned_to = ?' + (hasDept ? ' OR t.department_id = ?' : '') + ')';
    params.push(user.id);
    if (hasDept) params.push(d);
  }
  const rows = db.prepare(`
    SELECT t.id, t.task_number, t.equipment_area, t.task_description, t.next_due_date,
           CAST(julianday(t.next_due_date) - julianday(date('now')) AS INTEGER) AS days_left
    FROM maintenance_tasks t
    WHERE t.status != 'Completed' AND t.next_due_date <= date('now', '+7 days') AND ${scope}
    ORDER BY t.next_due_date ASC LIMIT ?
  `).all(...params, limit);
  const states = getStates(user.id);
  return rows
    .map(r => ({ ...r, key: `m:${r.id}:${r.next_due_date}` }))
    .filter(r => { const st = states.get(r.key); return !st || (opts.includeArchived && st === 'archived'); })
    .map(r => ({
    key: r.key, archived: states.get(r.key) === 'archived',
    id: r.id, number: r.task_number, name: r.equipment_area, text: r.task_description,
    dueDate: r.next_due_date, overdue: r.days_left < 0, daysLeft: r.days_left,
  }));
}

module.exports = { getLostFoundBell, getMaintenanceAlerts, notificationScope, getTicketBell, markTicketBellRead, snippet };
