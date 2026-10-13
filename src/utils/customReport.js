// Custom ticket report: which tickets, which columns, how they are grouped and sorted.
// One definition feeds the on-screen preview, the PDF and the Excel export, so the
// three can never disagree.
const db = require('../db');
const { getSlaMap, sqliteDateToUtc, formatMinutes } = require('./sla');
const { reportTicketsSource } = require('./ticketAccess');
const { listPriorities } = require('./priorities');

const STATUSES = ['Open', 'In Progress', 'On Hold', 'Resolved', 'Closed'];

// key -> how to read it from a prepared row. `width` is a relative weight for PDF/Excel.
const COLUMNS = [
  { key: 'ticket_number', label: 'Ticket #', width: 11, get: r => r.ticket_number },
  { key: 'subject', label: 'Subject', width: 30, get: r => r.subject },
  { key: 'request_type', label: 'Request Type', width: 16, get: r => r.request_type || '' },
  { key: 'requested_dept', label: 'Requested Dept.', width: 16, get: r => r.requested_dept || '' },
  { key: 'submitted_dept', label: 'Submitted From', width: 16, get: r => r.submitted_dept || '' },
  { key: 'handling_dept', label: 'Handling Dept.', width: 16, get: r => r.handling_dept || '' },
  { key: 'priority', label: 'Priority', width: 9, get: r => r.priority },
  { key: 'status', label: 'Status', width: 11, get: r => r.status },
  { key: 'assigned_to', label: 'Assigned To (Staff)', width: 18, get: r => r.assigned_to || 'Unassigned' },
  { key: 'staff_dept', label: 'Staff Department', width: 16, get: r => r.staff_dept || '' },
  { key: 'room', label: 'Room', width: 8, get: r => r.room || '' },
  { key: 'created_by', label: 'Created By', width: 16, get: r => r.created_by || '' },
  { key: 'created_at', label: 'Created', width: 17, get: r => r.created_at || '' },
  { key: 'finished_at', label: 'Resolved / Closed', width: 17, get: r => r.finished_at || '' },
  { key: 'time_to_resolve', label: 'Time to Resolve', width: 13, get: r => (r.minutes == null ? '' : formatMinutes(r.minutes)) },
  { key: 'sla', label: 'Within SLA', width: 10, get: r => r.sla },
];
const DEFAULT_COLUMNS = ['ticket_number', 'subject', 'requested_dept', 'priority', 'status', 'assigned_to', 'created_at'];

const GROUPS = [
  { key: '', label: 'No grouping' },
  { key: 'requested_dept', label: 'Requested department' },
  { key: 'submitted_dept', label: 'Submitted-from department' },
  { key: 'assigned_to', label: 'Staff member' },
  { key: 'staff_dept', label: 'Staff department' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'request_type', label: 'Request type' },
  { key: 'month', label: 'Month created' },
];

const SORTS = [
  { key: 'created_at', label: 'Date created' },
  { key: 'ticket_number', label: 'Ticket number' },
  { key: 'subject', label: 'Subject' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status' },
  { key: 'requested_dept', label: 'Requested department' },
  { key: 'assigned_to', label: 'Staff member' },
  { key: 'time_to_resolve', label: 'Time to resolve' },
];

function arr(v) {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map(x => String(x)).filter(x => x !== '');
}
function ints(v) { return arr(v).map(Number).filter(n => Number.isInteger(n) && n > 0); }
function oneOf(v, allowed, fallback) { return allowed.includes(String(v || '')) ? String(v) : fallback; }
function dateOnly(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : ''; }

// Normalises the raw query string into a safe options object.
function parseOptions(query) {
  const q = query || {};
  const cols = arr(q.columns).filter(k => COLUMNS.some(c => c.key === k));
  return {
    dateFrom: dateOnly(q.date_from),
    dateTo: dateOnly(q.date_to),
    requestedDepts: ints(q.department_id),
    submittedDepts: ints(q.submitted_dept_id),
    staffIds: arr(q.staff_id).filter(x => x === 'none' || /^\d+$/.test(x)),
    statuses: arr(q.status).filter(s => STATUSES.includes(s)),
    priorities: arr(q.priority),
    requestTypes: ints(q.request_type_id),
    columns: cols.length ? COLUMNS.map(c => c.key).filter(k => cols.includes(k)) : DEFAULT_COLUMNS,
    groupBy: oneOf(q.group_by, GROUPS.map(g => g.key), ''),
    sortBy: oneOf(q.sort_by, SORTS.map(s => s.key), 'created_at'),
    sortDir: q.sort_dir === 'asc' ? 'asc' : 'desc',
  };
}

function loadRows(user, perms, o) {
  const source = reportTicketsSource(user, perms);
  const where = ['1 = 1'];
  const params = [];
  if (o.dateFrom) { where.push('date(t.created_at) >= ?'); params.push(o.dateFrom); }
  if (o.dateTo) { where.push('date(t.created_at) <= ?'); params.push(o.dateTo); }
  if (o.requestedDepts.length) { where.push(`t.department_id IN (${o.requestedDepts.map(() => '?').join(',')})`); params.push(...o.requestedDepts); }
  if (o.submittedDepts.length) { where.push(`t.requester_department_id IN (${o.submittedDepts.map(() => '?').join(',')})`); params.push(...o.submittedDepts); }
  if (o.staffIds.length) {
    const ids = o.staffIds.filter(x => x !== 'none').map(Number);
    const parts = [];
    if (ids.length) { parts.push(`t.assigned_staff_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
    if (o.staffIds.includes('none')) parts.push('t.assigned_staff_id IS NULL');
    where.push(`(${parts.join(' OR ')})`);
  }
  if (o.statuses.length) { where.push(`t.status IN (${o.statuses.map(() => '?').join(',')})`); params.push(...o.statuses); }
  if (o.priorities.length) { where.push(`t.priority IN (${o.priorities.map(() => '?').join(',')})`); params.push(...o.priorities); }
  if (o.requestTypes.length) { where.push(`t.request_type_id IN (${o.requestTypes.map(() => '?').join(',')})`); params.push(...o.requestTypes); }

  const rows = db.prepare(`
    SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, t.created_at, t.resolved_at, t.closed_at,
           rt.name AS request_type, d.name AS requested_dept, rd.name AS submitted_dept, hd.name AS handling_dept,
           COALESCE(st.full_name, au.full_name) AS assigned_to, sd.name AS staff_dept,
           r.number AS room, cu.full_name AS created_by
    FROM ${source} t
    LEFT JOIN request_types rt ON rt.id = t.request_type_id
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN departments rd ON rd.id = t.requester_department_id
    LEFT JOIN departments hd ON hd.id = rt.handling_department_id
    LEFT JOIN staff_members st ON st.id = t.assigned_staff_id
    LEFT JOIN departments sd ON sd.id = st.department_id
    LEFT JOIN users au ON au.id = t.assigned_to
    LEFT JOIN rooms r ON r.id = t.room_id
    LEFT JOIN users cu ON cu.id = t.created_by
    WHERE ${where.join(' AND ')}
  `).all(...params);

  const sla = getSlaMap();
  return rows.map(r => {
    const finishedAt = r.status === 'Resolved' ? r.resolved_at : (r.status === 'Closed' ? (r.closed_at || r.resolved_at) : null);
    let minutes = null;
    let slaText = '';
    if (finishedAt) {
      const c = sqliteDateToUtc(r.created_at), f = sqliteDateToUtc(finishedAt);
      if (c && f) {
        minutes = Math.max(0, Math.round((f.getTime() - c.getTime()) / 60000));
        slaText = sla[r.priority] ? (minutes <= sla[r.priority] ? 'Yes' : 'No') : '';
      }
    }
    return { ...r, finished_at: finishedAt, minutes, sla: slaText };
  });
}

function sorter(o) {
  const rank = Object.fromEntries(listPriorities().map((p, i) => [p.priority, i]));
  const val = r => {
    switch (o.sortBy) {
      case 'priority': return rank[r.priority] ?? 99;
      case 'time_to_resolve': return r.minutes == null ? Number.MAX_SAFE_INTEGER : r.minutes;
      case 'assigned_to': return (r.assigned_to || 'zzzz').toLowerCase();
      default: return String(r[o.sortBy] || '').toLowerCase();
    }
  };
  const dir = o.sortDir === 'asc' ? 1 : -1;
  return (a, b) => {
    const x = val(a), y = val(b);
    if (x < y) return -1 * dir;
    if (x > y) return 1 * dir;
    return a.id - b.id;
  };
}

function groupKeyOf(row, groupBy) {
  if (groupBy === 'month') return (row.created_at || '').slice(0, 7) || 'Unknown';
  if (groupBy === 'assigned_to') return row.assigned_to || 'Unassigned';
  return row[groupBy] || 'Not set';
}

function summarize(rows) {
  const finished = rows.filter(r => r.minutes != null);
  const avg = finished.length ? Math.round(finished.reduce((s, r) => s + r.minutes, 0) / finished.length) : null;
  const tracked = finished.filter(r => r.sla);
  return {
    count: rows.length,
    finished: finished.length,
    open: rows.filter(r => ['Open', 'In Progress', 'On Hold'].includes(r.status)).length,
    avgTime: avg == null ? '' : formatMinutes(avg),
    slaRate: tracked.length ? Math.round(tracked.filter(r => r.sla === 'Yes').length / tracked.length * 100) : null,
  };
}

function describeFilters(o) {
  const names = (table, ids) => ids.map(id => (db.prepare(`SELECT ${table === 'staff_members' ? 'full_name' : 'name'} AS n FROM ${table} WHERE id = ?`).get(id) || {}).n).filter(Boolean);
  const out = [];
  if (o.dateFrom || o.dateTo) out.push(`Created: ${o.dateFrom || '…'} to ${o.dateTo || '…'}`);
  if (o.requestedDepts.length) out.push('Requested dept: ' + names('departments', o.requestedDepts).join(', '));
  if (o.submittedDepts.length) out.push('Submitted from: ' + names('departments', o.submittedDepts).join(', '));
  if (o.staffIds.length) {
    const ids = o.staffIds.filter(x => x !== 'none').map(Number);
    out.push('Staff: ' + [...names('staff_members', ids), ...(o.staffIds.includes('none') ? ['Unassigned'] : [])].join(', '));
  }
  if (o.statuses.length) out.push('Status: ' + o.statuses.join(', '));
  if (o.priorities.length) out.push('Priority: ' + o.priorities.join(', '));
  if (o.requestTypes.length) out.push('Request type: ' + names('request_types', o.requestTypes).join(', '));
  return out;
}

// -> { options, columns, groups: [{ label, rows, summary }], total, summary, filters, groupLabel }
function buildReport(user, perms, query) {
  const o = parseOptions(query);
  const rows = loadRows(user, perms, o).sort(sorter(o));
  const columns = o.columns.map(k => COLUMNS.find(c => c.key === k));
  let groups;
  if (!o.groupBy) {
    groups = [{ label: '', rows, summary: summarize(rows) }];
  } else {
    const map = new Map();
    rows.forEach(r => { const k = groupKeyOf(r, o.groupBy); if (!map.has(k)) map.set(k, []); map.get(k).push(r); });
    groups = [...map.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([label, list]) => ({ label, rows: list, summary: summarize(list) }));
  }
  return {
    options: o,
    columns,
    groups,
    total: rows.length,
    summary: summarize(rows),
    filters: describeFilters(o),
    groupLabel: (GROUPS.find(g => g.key === o.groupBy) || GROUPS[0]).label,
    sortLabel: `${(SORTS.find(s => s.key === o.sortBy) || SORTS[0]).label} (${o.sortDir === 'asc' ? 'A→Z / oldest first' : 'Z→A / newest first'})`,
  };
}

function filterChoices() {
  return {
    departments: db.prepare('SELECT id, name FROM departments ORDER BY name').all(),
    staff: db.prepare(`SELECT s.id, s.full_name, COALESCE(d.name, '') AS dept FROM staff_members s LEFT JOIN departments d ON d.id = s.department_id ORDER BY s.full_name`).all(),
    requestTypes: db.prepare('SELECT id, name FROM request_types ORDER BY name').all(),
    priorities: listPriorities().map(p => p.priority),
    statuses: STATUSES,
  };
}

module.exports = { COLUMNS, DEFAULT_COLUMNS, GROUPS, SORTS, buildReport, parseOptions, filterChoices };
