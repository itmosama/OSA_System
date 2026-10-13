const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const { dataDir } = require('../utils/appPaths');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const rawDb = new DatabaseSync(path.join(dataDir, 'ticketing.db'));
rawDb.exec('PRAGMA journal_mode = WAL');
rawDb.exec('PRAGMA foreign_keys = ON');
// Without this, two concurrent writes (e.g. two staff polling notifications
// at once) can throw "database is locked" immediately instead of waiting
// briefly for the other write to finish.
rawDb.exec('PRAGMA busy_timeout = 5000');

const PRIORITY_DEFAULTS = require('./priorityDefaults');

// One definition used both for fresh installs and for the one-time rebuild of
// an older table (see the "custom priorities" migration further down).
// `priority` is the name; names are unique ignoring upper/lower case.
function prioritySlasDdl(nameClause) {
  return `CREATE TABLE ${nameClause} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  priority TEXT NOT NULL UNIQUE COLLATE NOCASE,
  hours REAL NOT NULL DEFAULT 0,
  minutes REAL,
  color TEXT NOT NULL DEFAULT '#6c757d',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_builtin INTEGER NOT NULL DEFAULT 0
)`;
}

const schema = `
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  default_priority TEXT NOT NULL DEFAULT 'Medium',
  handling_department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

${prioritySlasDdl('IF NOT EXISTS priority_slas')};

CREATE TABLE IF NOT EXISTS room_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  floor TEXT,
  room_type_id INTEGER REFERENCES room_types(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permission_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  can_manage_tickets INTEGER NOT NULL DEFAULT 0,
  can_edit_delete_tickets INTEGER NOT NULL DEFAULT 0,
  can_edit_tickets INTEGER NOT NULL DEFAULT 0,
  can_delete_tickets INTEGER NOT NULL DEFAULT 0,
  can_edit_maintenance INTEGER NOT NULL DEFAULT 0,
  can_delete_maintenance INTEGER NOT NULL DEFAULT 0,
  can_manage_lost_found INTEGER NOT NULL DEFAULT 0,
  can_edit_delete_lost_found INTEGER NOT NULL DEFAULT 0,
  can_manage_settings INTEGER NOT NULL DEFAULT 0,
  can_manage_users INTEGER NOT NULL DEFAULT 0,
  can_view_reports INTEGER NOT NULL DEFAULT 0,
  can_submit_access_requests INTEGER NOT NULL DEFAULT 0,
  can_approve_as_hod INTEGER NOT NULL DEFAULT 0,
  can_approve_as_hr INTEGER NOT NULL DEFAULT 0,
  can_approve_as_it_manager INTEGER NOT NULL DEFAULT 0,
  can_approve_as_gm INTEGER NOT NULL DEFAULT 0,
  can_fulfil_access_requests INTEGER NOT NULL DEFAULT 0,
  can_manage_access_systems INTEGER NOT NULL DEFAULT 0,
  can_manage_maintenance INTEGER NOT NULL DEFAULT 0,
  can_edit_delete_maintenance INTEGER NOT NULL DEFAULT 0,
  can_submit_workflow_requests INTEGER NOT NULL DEFAULT 0,
  can_review_workflow_as_hod INTEGER NOT NULL DEFAULT 0,
  can_approve_workflow_as_finance INTEGER NOT NULL DEFAULT 0,
  can_fulfil_workflow_requests INTEGER NOT NULL DEFAULT 0,
  can_view_department_tickets INTEGER NOT NULL DEFAULT 0,
  can_submit_tickets INTEGER NOT NULL DEFAULT 0,
  can_view_all_staff INTEGER NOT NULL DEFAULT 0,
  can_view_all_department_reports INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','agent','requester')),
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  group_id INTEGER REFERENCES permission_groups(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In Progress','On Hold','Resolved','Closed')),
  priority TEXT NOT NULL DEFAULT 'Medium',
  request_type_id INTEGER REFERENCES request_types(id) ON DELETE SET NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  room_occupancy TEXT CHECK (room_occupancy IN ('Vacant','Occupied - Guest In','Occupied - Guest Out')),
  reported_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES ticket_comments(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id);

CREATE TABLE IF NOT EXISTS lost_found_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_number TEXT UNIQUE,
  item_description TEXT NOT NULL,
  location TEXT,
  found_by_name TEXT,
  found_at TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'In Storage' CHECK (status IN ('In Storage','Returned to Guest','Disposed')),
  guest_contacted INTEGER NOT NULL DEFAULT 0,
  contact_notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lost_found_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES lost_found_items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lost_found_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES lost_found_items(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES lost_found_comments(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lf_attachments_item ON lost_found_attachments(item_id);
CREATE INDEX IF NOT EXISTS idx_lf_comments_item ON lost_found_comments(item_id);
CREATE INDEX IF NOT EXISTS idx_lf_items_status ON lost_found_items(status);

CREATE TABLE IF NOT EXISTS maintenance_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_number TEXT UNIQUE,
  equipment_area TEXT NOT NULL,
  task_description TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('Daily','Weekly','Monthly','Quarterly','Semi-Annually','Annually')),
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  next_due_date TEXT NOT NULL,
  last_completed_date TEXT,
  status TEXT NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled','Completed')),
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_status ON maintenance_tasks(status);
CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_due ON maintenance_tasks(next_due_date);
CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_department ON maintenance_tasks(department_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_comments_task ON maintenance_task_comments(task_id);

-- Workflow Requests: HR -> Head of Department -> Finance (only if there is a cost) -> IT.
-- Status is validated in code (src/utils/workflowRequestFlow.js), not by a CHECK rule.
CREATE TABLE IF NOT EXISTS workflow_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'Draft',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  requested_for TEXT,
  priority TEXT NOT NULL DEFAULT 'Medium',
  needed_by TEXT,
  has_cost INTEGER NOT NULL DEFAULT 0,
  cost_amount REAL,
  cost_note TEXT,
  hod_comments TEXT,
  finance_comments TEXT,
  returned_reason TEXT,
  returned_by_step TEXT,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completion_notes TEXT,
  completed_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_requests_status ON workflow_requests(status);
CREATE INDEX IF NOT EXISTS idx_workflow_requests_created_by ON workflow_requests(created_by);
CREATE INDEX IF NOT EXISTS idx_workflow_requests_department ON workflow_requests(department_id);

CREATE TABLE IF NOT EXISTS workflow_request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES workflow_requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_request_log_request ON workflow_request_log(request_id);

CREATE TABLE IF NOT EXISTS workflow_request_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES workflow_requests(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_request_attachments_request ON workflow_request_attachments(request_id);

-- Single-row table: only one license is active at a time. Activating a new
-- one replaces this row entirely (see src/utils/license.js).
CREATE TABLE IF NOT EXISTS license (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  license_string TEXT NOT NULL,
  site TEXT,
  license_id TEXT,
  issued_date TEXT,
  expires_date TEXT,
  activated_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS access_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT,
  gm_always INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS access_system_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL REFERENCES access_systems(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_admin_level INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_access_system_levels_system ON access_system_levels(system_id);

CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN (
    'Draft','Submitted','Pending HOD','Pending HR','Pending IT Manager',
    'Pending GM','Approved','In Progress','Awaiting User Acknowledgment',
    'Closed','Rejected','Cancelled'
  )),
  gm_required INTEGER NOT NULL DEFAULT 0,

  -- Employee details (HR)
  employee_full_name TEXT NOT NULL,
  employee_id TEXT,
  job_title TEXT,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  reporting_manager TEXT,
  mobile_number TEXT,
  employment_type TEXT NOT NULL CHECK (employment_type IN ('Permanent','Contract','Intern','Temporary')),
  contract_end_date TEXT,
  start_date TEXT NOT NULL,

  -- Hardware & equipment
  hw_device_type TEXT CHECK (hw_device_type IN ('New','Existing')),
  hw_asset_tag TEXT,
  hw_phone_extension_needed INTEGER NOT NULL DEFAULT 0,
  hw_phone_extension TEXT,
  hw_mobile_radio INTEGER NOT NULL DEFAULT 0,
  hw_printer_needed INTEGER NOT NULL DEFAULT 0,
  hw_printer_location TEXT,
  hw_monitor_peripherals TEXT,

  -- User acknowledgment
  ack_confirmed INTEGER NOT NULL DEFAULT 0,
  ack_at TEXT,

  -- Rejection / cancellation
  rejection_reason TEXT,

  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);
CREATE INDEX IF NOT EXISTS idx_access_requests_created_by ON access_requests(created_by);
CREATE INDEX IF NOT EXISTS idx_access_requests_department ON access_requests(department_id);

CREATE TABLE IF NOT EXISTS access_request_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
  system_id INTEGER NOT NULL REFERENCES access_systems(id),
  required INTEGER NOT NULL DEFAULT 0,
  level_id INTEGER REFERENCES access_system_levels(id) ON DELETE SET NULL,
  remarks TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_request_items_request ON access_request_items(request_id);

CREATE TABLE IF NOT EXISTS access_request_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
  step TEXT NOT NULL CHECK (step IN ('HOD','HR','IT Manager','GM')),
  approver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision TEXT CHECK (decision IN ('Approved','Rejected')),
  comments TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_access_request_approvals_request ON access_request_approvals(request_id);

CREATE TABLE IF NOT EXISTS access_request_checklist (
  request_id INTEGER PRIMARY KEY REFERENCES access_requests(id) ON DELETE CASCADE,
  accounts_created TEXT,
  equipment_issued INTEGER NOT NULL DEFAULT 0,
  asset_register_updated INTEGER NOT NULL DEFAULT 0,
  credentials_handed_over INTEGER NOT NULL DEFAULT 0,
  user_briefed INTEGER NOT NULL DEFAULT 0,
  closing_notes TEXT,
  completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS access_request_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_access_request_audit_request ON access_request_audit(request_id);

CREATE TABLE IF NOT EXISTS deletion_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type TEXT NOT NULL,
  item_label TEXT NOT NULL,
  reason TEXT NOT NULL,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deletion_log_deleted_at ON deletion_log(deleted_at);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_department ON tickets(department_id);
CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments(ticket_id);
`;

rawDb.exec(schema);

// --- Lightweight migrations: add columns that may not exist yet on a database
// created before this feature was added (CREATE TABLE IF NOT EXISTS won't do this). ---
function columnExists(table, column) {
  const cols = rawDb.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

if (!columnExists('request_types', 'handling_department_id')) {
  rawDb.exec(`ALTER TABLE request_types ADD COLUMN handling_department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL`);
}
if (!columnExists('tickets', 'room_occupancy')) {
  rawDb.exec(`ALTER TABLE tickets ADD COLUMN room_occupancy TEXT`);
}
// SLA targets moved from hours to minutes for finer control. Backfill minutes
// from any existing hours values so previously-set targets aren't lost.
if (!columnExists('priority_slas', 'minutes')) {
  rawDb.exec(`ALTER TABLE priority_slas ADD COLUMN minutes REAL`);
  rawDb.exec(`UPDATE priority_slas SET minutes = hours * 60 WHERE minutes IS NULL`);
}
if (!columnExists('rooms', 'room_type_id')) {
  rawDb.exec(`ALTER TABLE rooms ADD COLUMN room_type_id INTEGER REFERENCES room_types(id) ON DELETE SET NULL`);
}
if (!columnExists('lost_found_items', 'serial_number')) {
  rawDb.exec(`ALTER TABLE lost_found_items ADD COLUMN serial_number TEXT`);
}
if (!columnExists('tickets', 'reported_by_name')) {
  rawDb.exec(`ALTER TABLE tickets ADD COLUMN reported_by_name TEXT`);
}
if (!columnExists('users', 'group_id')) {
  rawDb.exec(`ALTER TABLE users ADD COLUMN group_id INTEGER REFERENCES permission_groups(id) ON DELETE SET NULL`);
}
[
  'can_submit_access_requests', 'can_approve_as_hod', 'can_approve_as_hr',
  'can_approve_as_it_manager', 'can_approve_as_gm', 'can_fulfil_access_requests',
  'can_manage_access_systems', 'can_manage_maintenance', 'can_edit_delete_maintenance',
  'can_submit_workflow_requests', 'can_review_workflow_as_hod', 'can_approve_workflow_as_finance', 'can_fulfil_workflow_requests',
].forEach(col => {
  if (!columnExists('permission_groups', col)) {
    rawDb.exec(`ALTER TABLE permission_groups ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  }
});
// Staff members: the people who handle tickets, each linked to a department so
// reports can show what every person did. A staff member may optionally be tied
// to a login (user_id) so "assigned to me" keeps working for them.
rawDb.exec(`
CREATE TABLE IF NOT EXISTS staff_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_department ON staff_members(department_id);
`);
rawDb.exec(`
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
rawDb.exec(`
CREATE TABLE IF NOT EXISTS notification_states (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('archived','deleted')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_key)
);
`);
if (!columnExists('staff_members', 'mobile')) {
  rawDb.exec(`ALTER TABLE staff_members ADD COLUMN mobile TEXT`);
}
if (!columnExists('staff_members', 'photo')) {
  rawDb.exec(`ALTER TABLE staff_members ADD COLUMN photo TEXT`);
}
if (!columnExists('tickets', 'assigned_staff_id')) {
  rawDb.exec(`ALTER TABLE tickets ADD COLUMN assigned_staff_id INTEGER REFERENCES staff_members(id) ON DELETE SET NULL`);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_assigned_staff ON tickets(assigned_staff_id)`);
  // Carry over today's assignees: agents, plus anyone a ticket is already assigned to.
  rawDb.exec(`
    INSERT INTO staff_members (full_name, department_id, user_id, active)
    SELECT u.full_name, u.department_id, u.id, u.active FROM users u
    WHERE u.role = 'agent' OR u.id IN (SELECT assigned_to FROM tickets WHERE assigned_to IS NOT NULL)
  `);
  rawDb.exec(`UPDATE tickets SET assigned_staff_id = (SELECT s.id FROM staff_members s WHERE s.user_id = tickets.assigned_to) WHERE assigned_to IS NOT NULL`);
}
// A ticket's department_id is the department asked to do the job; this records
// the department of the person who submitted it (filled in automatically).
// Older tickets only ever stored the reporter's department, so copy it across.
if (!columnExists('tickets', 'requester_department_id')) {
  rawDb.exec(`ALTER TABLE tickets ADD COLUMN requester_department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL`);
  rawDb.exec(`UPDATE tickets SET requester_department_id = department_id`);
}
// "Edit & delete" used to be one switch for tickets and maintenance tasks. They are
// now separate; groups that had the old switch keep both until an admin changes it.
if (!columnExists('permission_groups', 'can_edit_tickets')) {
  ['can_edit_tickets', 'can_delete_tickets', 'can_edit_maintenance', 'can_delete_maintenance'].forEach(col => {
    if (!columnExists('permission_groups', col)) rawDb.exec(`ALTER TABLE permission_groups ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  });
  rawDb.exec(`UPDATE permission_groups SET can_edit_tickets = can_edit_delete_tickets, can_delete_tickets = can_edit_delete_tickets,
    can_edit_maintenance = can_edit_delete_maintenance, can_delete_maintenance = can_edit_delete_maintenance`);
}
if (!columnExists('permission_groups', 'can_view_department_tickets')) {
  rawDb.exec(`ALTER TABLE permission_groups ADD COLUMN can_view_department_tickets INTEGER NOT NULL DEFAULT 0`);
}
// Submitting tickets used to be open to everyone, so groups that already exist
// keep that ability; admins can switch it off per group afterwards.
if (!columnExists('permission_groups', 'can_submit_tickets')) {
  rawDb.exec(`ALTER TABLE permission_groups ADD COLUMN can_submit_tickets INTEGER NOT NULL DEFAULT 0`);
  rawDb.exec(`UPDATE permission_groups SET can_submit_tickets = 1`);
}
// Reports became department-scoped; groups that could already view reports keep
// seeing everything until an admin unticks this.
if (!columnExists('permission_groups', 'can_view_all_department_reports')) {
  rawDb.exec(`ALTER TABLE permission_groups ADD COLUMN can_view_all_department_reports INTEGER NOT NULL DEFAULT 0`);
  rawDb.exec(`UPDATE permission_groups SET can_view_all_department_reports = can_view_reports`);
}
// When a user last cleared their bell (ticket notifications newer than this are unread).
if (!columnExists('users', 'notif_seen_at')) {
  rawDb.exec(`ALTER TABLE users ADD COLUMN notif_seen_at TEXT`);
  rawDb.exec(`UPDATE users SET notif_seen_at = datetime('now')`);
}
if (!columnExists('permission_groups', 'can_view_all_staff')) {
  rawDb.exec(`ALTER TABLE permission_groups ADD COLUMN can_view_all_staff INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('access_systems', 'gm_always')) {
  rawDb.exec(`ALTER TABLE access_systems ADD COLUMN gm_always INTEGER NOT NULL DEFAULT 0`);
}
// Backfill (idempotent, safe to run every boot): the two systems that must
// always require GM approval regardless of level, in case they were seeded
// before the gm_always column existed.
rawDb.exec(`UPDATE access_systems SET gm_always = 1 WHERE name IN ('VPN / Remote Access', 'Finance / Accounting System') AND gm_always = 0`);

// Seed the default configurable access-systems list (only on first run — an
// admin can add/remove/rename freely afterwards via the admin UI).
if (rawDb.prepare('SELECT COUNT(*) c FROM access_systems').get().c === 0) {
  const insertSystem = rawDb.prepare(`INSERT INTO access_systems (name, category, gm_always, sort_order) VALUES (?, ?, ?, ?)`);
  const insertLevel = rawDb.prepare(`INSERT INTO access_system_levels (system_id, name, is_admin_level, sort_order) VALUES (?, ?, ?, ?)`);
  const defaultSystems = [
    { name: 'Microsoft 365 Email', category: 'Core IT', levels: ['Individual Mailbox', 'Shared Mailbox'] },
    { name: 'Distribution Groups', category: 'Core IT', levels: [] },
    { name: 'Domain / Windows Login', category: 'Core IT', levels: [] },
    { name: 'OPERA Cloud PMS', category: 'Operations', levels: ['Front Desk', 'Reservations', 'Cashier', { name: 'Supervisor', admin: true }] },
    { name: 'POS', category: 'Operations', levels: ['Server', 'Cashier', { name: 'Manager', admin: true }] },
    { name: 'Finance / Accounting System', category: 'Finance', levels: [], gmAlways: true },
    { name: 'Inventory / Purchasing System', category: 'Operations', levels: [] },
    { name: 'HR / Payroll System', category: 'HR', levels: [] },
    { name: 'Door Lock / Key Encoding System', category: 'Security', levels: [] },
    { name: 'Shared Folders', category: 'Core IT', levels: ['Read', 'Read-Write'] },
    { name: 'Internet Access', category: 'Core IT', levels: ['Standard', 'Extended'] },
    { name: 'VPN / Remote Access', category: 'Core IT', levels: [], gmAlways: true },
    { name: 'CCTV Viewing', category: 'Security', levels: [] },
  ];
  defaultSystems.forEach((sys, i) => {
    const { lastInsertRowid } = insertSystem.run(sys.name, sys.category, sys.gmAlways ? 1 : 0, i);
    sys.levels.forEach((lvl, j) => {
      const name = typeof lvl === 'string' ? lvl : lvl.name;
      const isAdmin = typeof lvl === 'string' ? 0 : (lvl.admin ? 1 : 0);
      insertLevel.run(lastInsertRowid, name, isAdmin, j);
    });
  });
}
// Backfill any lost & found items that don't have a serial yet (pre-existing rows),
// numbered using each item's own logged month so the sequence still reads correctly.
const unnumbered = rawDb.prepare(`SELECT id, created_at FROM lost_found_items WHERE serial_number IS NULL ORDER BY id ASC`).all();
if (unnumbered.length) {
  const seqByMonth = {};
  const updateStmt = rawDb.prepare(`UPDATE lost_found_items SET serial_number = ? WHERE id = ?`);
  unnumbered.forEach(row => {
    const d = new Date((row.created_at || '').replace(' ', 'T') + 'Z');
    const yymm = isNaN(d) ? '0000' : String(d.getFullYear()).slice(-2) + String(d.getMonth() + 1).padStart(2, '0');
    seqByMonth[yymm] = (seqByMonth[yymm] || 0) + 1;
    updateStmt.run(`L-${yymm}-${String(seqByMonth[yymm]).padStart(4, '0')}`, row.id);
  });
}

// --- Custom priorities -------------------------------------------------------
// Priorities used to be a fixed list enforced by CHECK constraints on both
// priority_slas and tickets. SQLite can't drop a CHECK in place, so older
// databases need those two tables rebuilt once (copy rows into a new table
// without the constraint, swap it in). That is done inside one transaction,
// after writing a backup, and is verified before it is committed.
const ticketsDdl = rawDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'").get();
const slasNeedRebuild = !columnExists('priority_slas', 'color');
const ticketsNeedRebuild = !!ticketsDdl && /CHECK\s*\(\s*priority\s+IN\s*\(/i.test(ticketsDdl.sql);

if (slasNeedRebuild || ticketsNeedRebuild) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(dataDir, `backup-before-custom-priorities-${stamp}.db`);
  rawDb.exec(`VACUUM INTO '${backupFile.split(path.sep).join('/').replace(/'/g, "''")}'`);
  console.log(`[db] Custom priorities migration: backup written to ${backupFile}`);

  const fkViolations = () => rawDb.prepare('PRAGMA foreign_key_check').all().length;
  const countRows = (table) => rawDb.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;

  rawDb.exec('PRAGMA foreign_keys = OFF'); // must be set outside a transaction
  let inTransaction = false;
  try {
    const violationsBefore = fkViolations();
    rawDb.exec('BEGIN');
    inTransaction = true;

    if (slasNeedRebuild) {
      const colorCase = `CASE priority ${PRIORITY_DEFAULTS.map(d => `WHEN '${d.priority}' THEN '${d.color}'`).join(' ')} ELSE '#6c757d' END`;
      const orderCase = `CASE priority ${PRIORITY_DEFAULTS.map(d => `WHEN '${d.priority}' THEN ${d.sort_order}`).join(' ')} ELSE 99 END`;
      const before = countRows('priority_slas');
      rawDb.exec(prioritySlasDdl('priority_slas__new'));
      rawDb.exec(`
        INSERT INTO priority_slas__new (priority, hours, minutes, color, sort_order, is_builtin)
        SELECT priority, hours, COALESCE(minutes, hours * 60), ${colorCase}, ${orderCase}, 1
        FROM priority_slas
      `);
      if (countRows('priority_slas__new') !== before) throw new Error('priority_slas row count changed during rebuild');
      rawDb.exec('DROP TABLE priority_slas');
      rawDb.exec('ALTER TABLE priority_slas__new RENAME TO priority_slas');
    }

    if (ticketsNeedRebuild) {
      const before = countRows('tickets');
      const indexes = rawDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tickets' AND sql IS NOT NULL").all();
      const newSql = ticketsDdl.sql
        .replace(/\s*CHECK\s*\(\s*priority\s+IN\s*\([^)]*\)\s*\)/i, '')
        .replace(/^\s*CREATE\s+TABLE\s+("?)tickets\1/i, 'CREATE TABLE tickets__new');
      if (!/tickets__new/.test(newSql) || /CHECK\s*\(\s*priority/i.test(newSql)) {
        throw new Error('could not rewrite the tickets table definition');
      }
      rawDb.exec(newSql);
      rawDb.exec('INSERT INTO tickets__new SELECT * FROM tickets');
      if (countRows('tickets__new') !== before) throw new Error('tickets row count changed during rebuild');
      rawDb.exec('DROP TABLE tickets');
      rawDb.exec('ALTER TABLE tickets__new RENAME TO tickets');
      indexes.forEach(i => rawDb.exec(i.sql));
    }

    if (fkViolations() > violationsBefore) throw new Error('foreign key check failed after rebuild');
    rawDb.exec('COMMIT');
    inTransaction = false;
    console.log('[db] Custom priorities migration complete.');
  } catch (err) {
    if (inTransaction) rawDb.exec('ROLLBACK');
    console.error('[db] Custom priorities migration FAILED and was rolled back. Your data is unchanged; backup is at', backupFile);
    throw err;
  } finally {
    rawDb.exec('PRAGMA foreign_keys = ON');
  }
}

// A thin wrapper that mirrors the better-sqlite3 API surface (.prepare().run/get/all, .exec, .transaction)
// used by the rest of the app, backed by Node's built-in node:sqlite.
const db = {
  raw: rawDb,
  exec(sql) {
    return rawDb.exec(sql);
  },
  prepare(sql) {
    const stmt = rawDb.prepare(sql);
    return {
      run: (...params) => stmt.run(...params),
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
    };
  },
  transaction(fn) {
    return (...args) => {
      rawDb.exec('BEGIN');
      try {
        const result = fn(...args);
        rawDb.exec('COMMIT');
        return result;
      } catch (err) {
        rawDb.exec('ROLLBACK');
        throw err;
      }
    };
  },
};

module.exports = db;
