const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin, requireRole, requirePermission } = require('../middleware/auth');
const { reportTicketsSource, seesAllReports } = require('../utils/ticketAccess');
const { upload, uploadsDir } = require('../middleware/upload');
const { buildReport, COLUMNS, GROUPS, SORTS, filterChoices } = require('../utils/customReport');
const { buildXlsx } = require('../utils/xlsxWriter');
const { renderPdf } = require('../utils/reportPdf');
const { getExportLogo } = require('../utils/siteLogo');
const { normalizePhone } = require('../utils/phone');
const fs = require('fs');
const nodePath = require('path');
const { getSlaMap, sqliteDateToUtc, attachSlaInfo, formatMinutes } = require('../utils/sla');
const { logDeletion } = require('../utils/auditLog');
const { PERMISSIONS, PERMISSION_SECTIONS, getUserPermissions, hasAdminAreaAccess } = require('../utils/permissions');
const { getLicenseStatus, activateLicense } = require('../utils/license');
const { listPriorities, validPriorityOrDefault } = require('../utils/priorities');
const { isValidHex, validatePriorityName } = require('../utils/priorityHelpers');
const { decryptLicenseFile } = require('../utils/licenseCrypto');
const { parseCsv, buildTemplate, planImport } = require('../utils/staffImport');

// License files are tiny (a few hundred bytes) and never need to touch disk —
// read straight into memory, decrypt, and discard.
const uploadStaffFile = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } }).single('staff_file');
const uploadLicenseFile = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 } }).single('license_file');

const router = express.Router();
router.use(requireLogin);

// Scope each admin section to the permission that governs it (admins always pass).
router.use('/priority-sla', requirePermission('can_manage_settings'));
router.use('/departments', requirePermission('can_manage_settings'));
router.use('/staff', requirePermission('can_manage_settings'));
router.use('/request-types', requirePermission('can_manage_settings'));
router.use('/room-types', requirePermission('can_manage_settings'));
router.use('/rooms', requirePermission('can_manage_settings'));
router.use('/users', requirePermission('can_manage_users'));
router.use('/reports', requirePermission('can_view_reports'));
router.use('/deleted-items', requirePermission('can_view_all_department_reports'));
router.use('/access-systems', requirePermission('can_manage_access_systems'));

// The admin dashboard hub itself is reachable by anyone with an administration
// permission (settings, users, access systems) or a full admin — individual sections below are
// still gated by their own specific permission.
router.get('/', (req, res) => {
  const perms = getUserPermissions(req.session.user);
  if (!hasAdminAreaAccess(req.session.user, perms)) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to view this page.' });
  }

  const counts = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    departments: db.prepare('SELECT COUNT(*) c FROM departments').get().c,
    requestTypes: db.prepare('SELECT COUNT(*) c FROM request_types').get().c,
    rooms: db.prepare('SELECT COUNT(*) c FROM rooms').get().c,
    roomTypes: db.prepare('SELECT COUNT(*) c FROM room_types').get().c,
    tickets: db.prepare('SELECT COUNT(*) c FROM tickets').get().c,
    groups: db.prepare('SELECT COUNT(*) c FROM permission_groups').get().c,
    accessSystems: db.prepare('SELECT COUNT(*) c FROM access_systems').get().c,
    staff: db.prepare('SELECT COUNT(*) c FROM staff_members').get().c,
    deleted: db.prepare('SELECT COUNT(*) c FROM deletion_log').get().c,
  };
  const lic = getLicenseStatus();
  const licenseText = !lic.activated ? 'Not activated' : (lic.expired ? 'Expired' : (lic.valid ? lic.daysRemaining + ' days remaining' : 'Invalid'));
  res.render('admin/index', { title: 'Admin Dashboard', counts, licenseText });
});

/* ---------- License (admin only — not delegable via permission groups) ---------- */
const { getSetting, setSetting } = require('../utils/appSettings');
router.get('/license', requireRole('admin'), (req, res) => {
  res.render('admin/license', { title: 'License', status: getLicenseStatus(), error: null, success: null, logoError: req.query.logo_error || null, logoSaved: req.query.logo === 'saved' });
});

// Hotel logo: stored once, available to every page as res.locals.siteLogoUrl.
router.post('/license/logo', requireRole('admin'), (req, res) => {
  upload.single('logo')(req, res, (err) => {
    const back = (m) => res.redirect('/admin/license?logo_error=' + encodeURIComponent(m));
    if (err) return back(err.code === 'LIMIT_FILE_SIZE' ? 'That image is too large (max 10 MB).' : (err.message || 'Could not upload the logo.'));
    if (!req.file) return back('Please choose an image file.');
    const old = getSetting('site_logo');
    setSetting('site_logo', req.file.filename);
    if (old && old !== req.file.filename) fs.unlink(nodePath.join(uploadsDir, old), () => {});
    res.redirect('/admin/license?logo=saved');
  });
});

router.post('/license/logo/remove', requireRole('admin'), (req, res) => {
  const old = getSetting('site_logo');
  setSetting('site_logo', null);
  if (old) fs.unlink(nodePath.join(uploadsDir, old), () => {});
  res.redirect('/admin/license');
});

router.post('/license', requireRole('admin'), (req, res) => {
  uploadLicenseFile(req, res, (uploadErr) => {
    const rerender = (error) => res.status(400).render('admin/license', { title: 'License', status: getLicenseStatus(), error, success: null });

    if (uploadErr) return rerender('Could not read the uploaded file: ' + uploadErr.message);

    let licenseString;
    if (req.file) {
      try {
        licenseString = decryptLicenseFile(req.file.buffer);
      } catch (e) {
        return rerender('The uploaded file could not be decrypted — it may be corrupted, not a license file, or from an incompatible system.');
      }
    } else {
      licenseString = (req.body.license_string || '').trim();
      if (!licenseString) return rerender('Paste a license string or choose a license file to upload.');
    }

    const result = activateLicense(licenseString, req.session.user.id);
    if (!result.ok) return rerender(result.error);

    res.render('admin/license', { title: 'License', status: getLicenseStatus(), error: null, success: 'License activated successfully.' });
  });
});

/* ---------- Permission Groups (admin only — controls what others can do) ---------- */
router.get('/groups', requireRole('admin'), (req, res) => {
  const groups = db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id) AS user_count
    FROM permission_groups g ORDER BY g.name
  `).all();
  res.render('admin/groups', { title: 'Permission Groups', groups, permissions: PERMISSIONS, sections: PERMISSION_SECTIONS, error: null });
});

router.post('/groups', requireRole('admin'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    const flags = PERMISSIONS.map(p => (req.body[p.key] ? 1 : 0));
    try {
      db.prepare(`
        INSERT INTO permission_groups (name, ${PERMISSIONS.map(p => p.key).join(', ')})
        VALUES (?, ${PERMISSIONS.map(() => '?').join(', ')})
      `).run(name, ...flags);
    } catch (e) { /* ignore duplicate name */ }
  }
  res.redirect('/admin/groups');
});

router.post('/groups/:id/edit', requireRole('admin'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    const flags = PERMISSIONS.map(p => (req.body[p.key] ? 1 : 0));
    try {
      db.prepare(`
        UPDATE permission_groups SET name = ?, ${PERMISSIONS.map(p => `${p.key} = ?`).join(', ')}
        WHERE id = ?
      `).run(name, ...flags, req.params.id);
    } catch (e) { /* ignore duplicate name */ }
  }
  res.redirect('/admin/groups');
});

router.post('/groups/:id/delete', requireRole('admin'), (req, res) => {
  const group = db.prepare('SELECT * FROM permission_groups WHERE id = ?').get(req.params.id);
  if (group) {
    logDeletion('Permission Group', group.name, req.session.user.id, req.body.reason);
    db.prepare('DELETE FROM permission_groups WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/groups');
});

/* ---------- Access Systems (configurable list for the Access Requests module) ---------- */
// Levels are entered/edited as a comma-separated list; suffix a level with "*"
// to flag it admin-level (auto-triggers GM approval on a request).
function parseLevelsInput(raw) {
  return (raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map((s, i) => ({
      name: s.endsWith('*') ? s.slice(0, -1).trim() : s,
      is_admin_level: s.endsWith('*') ? 1 : 0,
      sort_order: i,
    }));
}

function replaceLevels(systemId, levels) {
  db.prepare('DELETE FROM access_system_levels WHERE system_id = ?').run(systemId);
  const insert = db.prepare('INSERT INTO access_system_levels (system_id, name, is_admin_level, sort_order) VALUES (?, ?, ?, ?)');
  levels.forEach(l => insert.run(systemId, l.name, l.is_admin_level, l.sort_order));
}

router.get('/access-systems', (req, res) => {
  const systems = db.prepare('SELECT * FROM access_systems ORDER BY sort_order, name').all();
  const levels = db.prepare('SELECT * FROM access_system_levels ORDER BY system_id, sort_order').all();
  systems.forEach(s => { s.levels = levels.filter(l => l.system_id === s.id); });
  res.render('admin/access-systems', { title: 'Access Systems List', systems, error: null });
});

router.post('/access-systems', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    try {
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO access_systems (name, category, gm_always, sort_order) VALUES (?, ?, ?, ?)'
      ).run(name, (req.body.category || '').trim() || null, req.body.gm_always ? 1 : 0, 999);
      replaceLevels(lastInsertRowid, parseLevelsInput(req.body.levels));
    } catch (e) { /* ignore duplicate name */ }
  }
  res.redirect('/admin/access-systems');
});

router.post('/access-systems/:id/edit', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    try {
      db.prepare('UPDATE access_systems SET name = ?, category = ?, gm_always = ?, active = ? WHERE id = ?')
        .run(name, (req.body.category || '').trim() || null, req.body.gm_always ? 1 : 0, req.body.active ? 1 : 0, req.params.id);
      replaceLevels(req.params.id, parseLevelsInput(req.body.levels));
    } catch (e) { /* ignore duplicate name */ }
  }
  res.redirect('/admin/access-systems');
});

router.post('/access-systems/:id/delete', (req, res) => {
  const system = db.prepare('SELECT * FROM access_systems WHERE id = ?').get(req.params.id);
  if (system) {
    try {
      logDeletion('Access System', system.name, req.session.user.id, req.body.reason);
      db.prepare('DELETE FROM access_systems WHERE id = ?').run(req.params.id);
    } catch (e) {
      // FK constraint — system is referenced by existing access requests; deactivate instead.
      db.prepare('UPDATE access_systems SET active = 0 WHERE id = ?').run(req.params.id);
    }
  }
  res.redirect('/admin/access-systems');
});

/* ---------- Priorities: name, resolution target (minutes), colour and order ---------- */
function renderPriorities(res, { status = 200, error = null, success = null, addValues } = {}) {
  const tickets = Object.fromEntries(db.prepare('SELECT priority, COUNT(*) n FROM tickets GROUP BY priority').all().map(r => [r.priority, r.n]));
  const types = Object.fromEntries(db.prepare('SELECT default_priority p, COUNT(*) n FROM request_types GROUP BY default_priority').all().map(r => [r.p, r.n]));
  const priorityRows = listPriorities().map(p => ({ ...p, ticketCount: tickets[p.priority] || 0, typeCount: types[p.priority] || 0 }));
  res.status(status).render('admin/priority-sla', {
    title: 'Priority SLA', priorityRows, error, success,
    addValues: addValues || { name: '', minutes: '', color: '#6f42c1' },
  });
}

router.get('/priority-sla', (req, res) => renderPriorities(res));

// Saves minutes, colour and order for every priority in one go (all-or-nothing).
router.post('/priority-sla', (req, res) => {
  const submitted = req.body.p || {};
  const updates = [];
  for (const p of listPriorities()) {
    // Keys are "id_<n>", not bare numbers: the form parser turns p[1], p[2]... into
    // a list and renumbers it, which would hand each priority its neighbour's values.
    const row = submitted['id_' + p.id];
    if (!row) continue;
    const minutes = parseFloat(row.minutes);
    const order = parseInt(row.order, 10);
    if (!(Number.isFinite(minutes) && minutes > 0)) {
      return renderPriorities(res, { status: 400, error: `Enter a positive number of minutes for "${p.priority}".` });
    }
    if (!isValidHex(row.color)) {
      return renderPriorities(res, { status: 400, error: `Pick a valid colour for "${p.priority}".` });
    }
    if (!Number.isInteger(order) || order < 0 || order > 9999) {
      return renderPriorities(res, { status: 400, error: `The order for "${p.priority}" must be a whole number.` });
    }
    updates.push({ id: p.id, minutes, color: row.color.toLowerCase(), order });
  }
  const update = db.prepare('UPDATE priority_slas SET hours = ?, minutes = ?, color = ?, sort_order = ? WHERE id = ?');
  db.transaction((rows) => rows.forEach(u => update.run(u.minutes / 60, u.minutes, u.color, u.order, u.id)))(updates);
  renderPriorities(res, { success: 'Saved.' });
});

router.post('/priority-sla/add', (req, res) => {
  const addValues = { name: req.body.name || '', minutes: req.body.minutes || '', color: req.body.color || '#6f42c1' };
  const fail = (error) => renderPriorities(res, { status: 400, error, addValues });

  const nameCheck = validatePriorityName(req.body.name);
  if (!nameCheck.ok) return fail(nameCheck.error);
  const minutes = parseFloat(req.body.minutes);
  if (!(Number.isFinite(minutes) && minutes > 0)) return fail('Enter a positive number of minutes.');
  if (!isValidHex(req.body.color)) return fail('Pick a valid colour.');
  if (listPriorities().some(p => p.priority.toLowerCase() === nameCheck.name.toLowerCase())) {
    return fail(`A priority called "${nameCheck.name}" already exists.`);
  }

  const lastOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM priority_slas').get().m;
  db.prepare('INSERT INTO priority_slas (priority, hours, minutes, color, sort_order, is_builtin) VALUES (?, ?, ?, ?, ?, 0)')
    .run(nameCheck.name, minutes / 60, minutes, req.body.color.toLowerCase(), lastOrder + 1);
  renderPriorities(res, { success: `Added "${nameCheck.name}". It's at the end of the list — change its Order number to move it.` });
});

router.post('/priority-sla/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM priority_slas WHERE id = ?').get(req.params.id);
  if (!p) return res.redirect('/admin/priority-sla');
  if (p.is_builtin) return renderPriorities(res, { status: 400, error: `"${p.priority}" is a built-in priority and can't be deleted.` });

  const tickets = db.prepare('SELECT COUNT(*) c FROM tickets WHERE priority = ?').get(p.priority).c;
  const types = db.prepare('SELECT COUNT(*) c FROM request_types WHERE default_priority = ?').get(p.priority).c;
  if (tickets || types) {
    const parts = [];
    if (tickets) parts.push(`${tickets} ticket${tickets === 1 ? '' : 's'}`);
    if (types) parts.push(`${types} request type${types === 1 ? '' : 's'}`);
    return renderPriorities(res, { status: 400, error: `"${p.priority}" is still used by ${parts.join(' and ')}. Move them to another priority first.` });
  }

  logDeletion('Priority', p.priority, req.session.user.id, req.body.reason);
  db.prepare('DELETE FROM priority_slas WHERE id = ?').run(p.id);
  renderPriorities(res, { success: `Deleted "${p.priority}".` });
});

/* ---------- Departments ---------- */
router.get('/departments', (req, res) => {
  const departments = db.prepare(`
    SELECT d.*, (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id) AS user_count,
           (SELECT COUNT(*) FROM tickets t WHERE t.department_id = d.id) AS ticket_count
    FROM departments d ORDER BY d.name
  `).all();
  res.render('admin/departments', { title: 'Departments', departments, error: null });
});

router.post('/departments', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    try {
      db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
    } catch (e) { /* ignore duplicate */ }
  }
  res.redirect('/admin/departments');
});

router.post('/departments/:id/edit', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    try {
      db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(name, req.params.id);
    } catch (e) { /* ignore duplicate name */ }
  }
  res.redirect('/admin/departments');
});

router.post('/departments/:id/delete', (req, res) => {
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (dept) {
    logDeletion('Department', dept.name, req.session.user.id, req.body.reason);
    db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/departments');
});

/* ---------- Staff (people who handle tickets) ---------- */
function renderStaff(req, res, importResult) {
  const staff = db.prepare(`
    SELECT s.*, d.name AS department_name, u.username AS username,
           (SELECT COUNT(*) FROM tickets t WHERE t.assigned_staff_id = s.id) AS ticket_count,
           (SELECT COUNT(*) FROM tickets t WHERE t.assigned_staff_id = s.id AND t.status IN ('Resolved','Closed')) AS done_count
    FROM staff_members s
    LEFT JOIN departments d ON d.id = s.department_id
    LEFT JOIN users u ON u.id = s.user_id
    ORDER BY d.name, s.full_name
  `).all();
  res.render('admin/staff', {
    title: 'Staff',
    staff,
    departments: db.prepare('SELECT * FROM departments ORDER BY name').all(),
    users: db.prepare("SELECT id, full_name, username FROM users WHERE active = 1 ORDER BY full_name").all(),
    error: req.query.error || null,
    importResult: importResult || null,
  });
}

router.get('/staff', (req, res) => renderStaff(req, res, null));

// Blank template, pre-filled with this site's department names.
router.get('/staff/template.csv', (req, res) => {
  const names = db.prepare('SELECT name FROM departments ORDER BY name').all().map(d => d.name);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="OSA-Staff-Import-Template.csv"');
  res.send(buildTemplate(names));
});

router.post('/staff/import', (req, res) => {
  uploadStaffFile(req, res, (uploadErr) => {
    if (uploadErr || !req.file) {
      const msg = uploadErr && uploadErr.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (max 1 MB).' : 'Please choose a file to import.';
      return renderStaff(req, res, { fatal: msg });
    }
    if (!/.(csv|txt)$/i.test(req.file.originalname || '')) {
      return renderStaff(req, res, { fatal: 'Please upload a .csv file. In Excel use File → Save As → CSV.' });
    }
    const plan = planImport(parseCsv(req.file.buffer.toString('utf8')), {
      departments: db.prepare('SELECT id, name FROM departments').all(),
      users: db.prepare('SELECT id, username FROM users').all(),
      existing: db.prepare('SELECT full_name, department_id FROM staff_members').all(),
    });
    // All-or-nothing: if any row has a problem nothing is added, so the file can be fixed and re-uploaded.
    let added = 0;
    if (plan.problems.length === 0 && plan.toAdd.length) {
      const insert = db.prepare('INSERT INTO staff_members (full_name, department_id, user_id, mobile) VALUES (?, ?, ?, ?)');
      db.transaction(() => { plan.toAdd.forEach(s => { insert.run(s.name, s.department_id, s.user_id, s.mobile || null); added += 1; }); })();
    }
    renderStaff(req, res, { file: req.file.originalname, added, skipped: plan.skipped, problems: plan.problems, wouldAdd: plan.toAdd.length });
  });
});

function staffFields(body) {
  const name = (body.full_name || '').trim();
  const dept = body.department_id ? Number(body.department_id) : null;
  const userId = body.user_id ? Number(body.user_id) : null;
  const mobile = normalizePhone(body.mobile); // '' = none, null = not a valid number
  return { name, dept, userId, mobile };
}

// One optional photo per person (field name "photo"); images only, 10 MB max.
function staffPhotoUpload(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (err) req.photoError = err.code === 'LIMIT_FILE_SIZE' ? 'That photo is too large (max 10 MB).' : (err.message || 'Could not upload the photo.');
    next();
  });
}
function removePhotoFile(filename) {
  if (filename) fs.unlink(nodePath.join(uploadsDir, filename), () => {});
}

router.post('/staff', staffPhotoUpload, (req, res) => {
  const { name, dept, userId, mobile } = staffFields(req.body);
  const fail = (m) => { if (req.file) removePhotoFile(req.file.filename); return res.redirect('/admin/staff?error=' + encodeURIComponent(m)); };
  if (req.photoError) return fail(req.photoError);
  if (!name) return fail('Staff name is required.');
  if (mobile === null) return fail('That mobile number does not look right. Use the international format, for example +971501234567.');
  if (!dept) return fail('Please choose a department for the staff member.');
  db.prepare('INSERT INTO staff_members (full_name, department_id, user_id, photo, mobile) VALUES (?, ?, ?, ?, ?)')
    .run(name, dept, userId, req.file ? req.file.filename : null, mobile || null);
  res.redirect('/admin/staff');
});

router.post('/staff/:id/edit', staffPhotoUpload, (req, res) => {
  const { name, dept, userId, mobile } = staffFields(req.body);
  const fail = (m) => { if (req.file) removePhotoFile(req.file.filename); return res.redirect('/admin/staff?error=' + encodeURIComponent(m)); };
  if (req.photoError) return fail(req.photoError);
  if (!name || !dept) return fail('Name and department are required.');
  if (mobile === null) return fail('That mobile number does not look right. Use the international format, for example +971501234567.');
  const existing = db.prepare('SELECT * FROM staff_members WHERE id = ?').get(req.params.id);
  if (!existing) return fail('That staff member no longer exists.');
  // New upload replaces the old photo; the "remove" button clears it.
  let photo = existing.photo;
  if (req.file) { removePhotoFile(existing.photo); photo = req.file.filename; }
  else if (req.body.remove_photo) { removePhotoFile(existing.photo); photo = null; }
  db.prepare('UPDATE staff_members SET full_name = ?, department_id = ?, user_id = ?, active = ?, photo = ?, mobile = ? WHERE id = ?')
    .run(name, dept, userId, req.body.active ? 1 : 0, photo, mobile || null, existing.id);
  // Keep the login link on open assignments in step with this person.
  db.prepare('UPDATE tickets SET assigned_to = ? WHERE assigned_staff_id = ?').run(userId, existing.id);
  res.redirect('/admin/staff');
});

router.post('/staff/:id/delete', (req, res) => {
  const member = db.prepare('SELECT * FROM staff_members WHERE id = ?').get(req.params.id);
  if (member) {
    logDeletion('Staff Member', member.full_name, req.session.user.id, req.body.reason);
    removePhotoFile(member.photo);
    db.prepare('DELETE FROM staff_members WHERE id = ?').run(member.id);
  }
  res.redirect('/admin/staff');
});

/* ---------- Request Types ---------- */
router.get('/request-types', (req, res) => {
  const requestTypes = db.prepare(`
    SELECT rt.*, d.name AS handling_department_name,
           (SELECT COUNT(*) FROM tickets t WHERE t.request_type_id = rt.id) AS ticket_count
    FROM request_types rt
    LEFT JOIN departments d ON d.id = rt.handling_department_id
    ORDER BY rt.name
  `).all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.render('admin/request-types', { title: 'Request Types', requestTypes, departments, error: null });
});

router.post('/request-types', (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  const default_priority = validPriorityOrDefault(req.body.default_priority);
  const handling_department_id = req.body.handling_department_id || null;
  if (name) {
    try {
      db.prepare('INSERT INTO request_types (name, description, default_priority, handling_department_id) VALUES (?, ?, ?, ?)')
        .run(name, description, default_priority, handling_department_id);
    } catch (e) { /* ignore duplicate */ }
  }
  res.redirect('/admin/request-types');
});

// Full edit: name, description, default priority, and handling department in one save
router.post('/request-types/:id/edit', (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  const default_priority = validPriorityOrDefault(req.body.default_priority);
  const handling_department_id = req.body.handling_department_id || null;
  if (name) {
    try {
      db.prepare('UPDATE request_types SET name = ?, description = ?, default_priority = ?, handling_department_id = ? WHERE id = ?')
        .run(name, description, default_priority, handling_department_id, req.params.id);
    } catch (e) { /* ignore duplicate name */ }
  }
  res.redirect('/admin/request-types');
});

router.post('/request-types/:id/delete', (req, res) => {
  const rt = db.prepare('SELECT * FROM request_types WHERE id = ?').get(req.params.id);
  if (rt) {
    logDeletion('Request Type', rt.name, req.session.user.id, req.body.reason);
    db.prepare('DELETE FROM request_types WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/request-types');
});

/* ---------- Room Types ---------- */
router.get('/room-types', (req, res) => {
  const roomTypes = db.prepare(`
    SELECT rt.*, (SELECT COUNT(*) FROM rooms r WHERE r.room_type_id = rt.id) AS room_count
    FROM room_types rt ORDER BY rt.name
  `).all();
  res.render('admin/room-types', { title: 'Room Types', roomTypes, error: null });
});

router.post('/room-types', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    try {
      db.prepare('INSERT INTO room_types (name) VALUES (?)').run(name);
    } catch (e) { /* ignore duplicate */ }
  }
  res.redirect('/admin/room-types');
});

router.post('/room-types/:id/edit', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    try {
      db.prepare('UPDATE room_types SET name = ? WHERE id = ?').run(name, req.params.id);
    } catch (e) { /* ignore duplicate name */ }
  }
  res.redirect('/admin/room-types');
});

router.post('/room-types/:id/delete', (req, res) => {
  const rt = db.prepare('SELECT * FROM room_types WHERE id = ?').get(req.params.id);
  if (rt) {
    logDeletion('Room Type', rt.name, req.session.user.id, req.body.reason);
    db.prepare('DELETE FROM room_types WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/room-types');
});

/* ---------- Rooms ---------- */
router.get('/rooms', (req, res) => {
  const rooms = db.prepare(`
    SELECT r.*, rt.name AS room_type_name FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    ORDER BY r.number
  `).all();
  const roomTypes = db.prepare('SELECT * FROM room_types ORDER BY name').all();
  res.render('admin/rooms', { title: 'Rooms', rooms, roomTypes, error: null });
});

router.post('/rooms', (req, res) => {
  const number = (req.body.number || '').trim();
  const floor = (req.body.floor || '').trim();
  const room_type_id = req.body.room_type_id || null;
  if (number) {
    try {
      db.prepare('INSERT INTO rooms (number, floor, room_type_id) VALUES (?, ?, ?)').run(number, floor, room_type_id);
    } catch (e) { /* ignore duplicate */ }
  }
  res.redirect('/admin/rooms');
});

// Bulk add a numeric range, e.g. 101 to 150 on floor 1
router.post('/rooms/bulk', (req, res) => {
  const { from, to, floor, room_type_id } = req.body;
  const start = parseInt(from, 10);
  const end = parseInt(to, 10);
  if (Number.isInteger(start) && Number.isInteger(end) && end >= start && (end - start) < 2000) {
    const insert = db.prepare('INSERT OR IGNORE INTO rooms (number, floor, room_type_id) VALUES (?, ?, ?)');
    const insertMany = db.transaction((rows) => rows.forEach(r => insert.run(r, floor || '', room_type_id || null)));
    const numbers = [];
    for (let n = start; n <= end; n++) numbers.push(String(n));
    insertMany(numbers);
  }
  res.redirect('/admin/rooms');
});

// Saves many edited rooms at once (the "Save All Changes" button). All-or-nothing:
// if any row is invalid or clashes with an existing number, nothing is changed
// and the page keeps the user's edits so they can fix it and retry.
router.post('/rooms/bulk-edit', (req, res) => {
  const items = Array.isArray(req.body.rooms) ? req.body.rooms : [];
  if (!items.length) return res.json({ ok: true, saved: 0 });
  if (items.length > 5000) return res.status(400).json({ ok: false, error: 'Too many rooms in one save.' });

  const clean = [];
  for (const it of items) {
    const number = String(it.number ?? '').trim();
    if (!number) return res.status(400).json({ ok: false, error: 'A room number cannot be empty.' });
    clean.push({
      id: Number(it.id),
      number,
      floor: String(it.floor ?? '').trim(),
      room_type_id: it.room_type_id ? Number(it.room_type_id) : null,
    });
  }

  const repeated = clean.find((a, i) => clean.findIndex(b => b.number === a.number) !== i);
  if (repeated) {
    return res.status(400).json({ ok: false, error: `Room number "${repeated.number}" appears more than once in your edits.` });
  }

  const update = db.prepare('UPDATE rooms SET number = ?, floor = ?, room_type_id = ? WHERE id = ?');
  try {
    db.transaction((rows) => rows.forEach(r => update.run(r.number, r.floor, r.room_type_id, r.id)))(clean);
  } catch (e) {
    const clash = /UNIQUE/i.test(e.message);
    return res.status(400).json({
      ok: false,
      error: clash
        ? 'One of those room numbers already exists on another room. Nothing was saved.'
        : 'Could not save the changes. Nothing was saved.',
    });
  }
  res.json({ ok: true, saved: clean.length });
});

router.post('/rooms/:id/edit', (req, res) => {
  const number = (req.body.number || '').trim();
  const floor = (req.body.floor || '').trim();
  const room_type_id = req.body.room_type_id || null;
  if (number) {
    try {
      db.prepare('UPDATE rooms SET number = ?, floor = ?, room_type_id = ? WHERE id = ?').run(number, floor, room_type_id, req.params.id);
    } catch (e) { /* ignore duplicate number */ }
  }
  res.redirect('/admin/rooms');
});

router.post('/rooms/:id/delete', (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (room) {
    logDeletion('Room', `Room ${room.number}`, req.session.user.id, req.body.reason);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/rooms');
});

/* ---------- Users ---------- */
router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.*, d.name AS department_name, g.name AS group_name FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN permission_groups g ON g.id = u.group_id
    ORDER BY u.full_name
  `).all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const groups = db.prepare('SELECT * FROM permission_groups ORDER BY name').all();
  res.render('admin/users', { title: 'Users', users, departments, groups, error: null });
});

router.post('/users', (req, res) => {
  const { username, full_name, password, role, department_id, group_id, email } = req.body;
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const groups = db.prepare('SELECT * FROM permission_groups ORDER BY name').all();
  const users = db.prepare(`
    SELECT u.*, d.name AS department_name, g.name AS group_name FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN permission_groups g ON g.id = u.group_id
    ORDER BY u.full_name
  `).all();

  if (!username || !full_name || !password || !role) {
    return res.status(400).render('admin/users', { title: 'Users', users, departments, groups, error: 'Username, full name, password, and role are required.' });
  }
  if (!['admin', 'agent', 'requester'].includes(role)) {
    return res.status(400).render('admin/users', { title: 'Users', users, departments, groups, error: 'Invalid role.' });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role, department_id, group_id, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(username.trim(), hash, full_name.trim(), (email || '').trim(), role, department_id || null, group_id || null);
  } catch (e) {
    return res.status(400).render('admin/users', { title: 'Users', users, departments, groups, error: 'That username is already taken.' });
  }

  res.redirect('/admin/users');
});

// Edit name, email, role, department, permission group (username & password are handled separately)
router.post('/users/:id/edit', (req, res) => {
  const { full_name, email, role, department_id, group_id } = req.body;
  if (!full_name || !full_name.trim() || !['admin', 'agent', 'requester'].includes(role)) {
    return res.redirect('/admin/users');
  }
  db.prepare('UPDATE users SET full_name = ?, email = ?, role = ?, department_id = ?, group_id = ? WHERE id = ?')
    .run(full_name.trim(), (email || '').trim(), role, department_id || null, group_id || null, req.params.id);
  res.redirect('/admin/users');
});

router.post('/users/:id/toggle-active', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (user) {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(user.active ? 0 : 1, user.id);
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/reset-password', (req, res) => {
  const newPassword = (req.body.password || '').trim();
  if (newPassword.length >= 6) {
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', (req, res) => {
  if (Number(req.params.id) === req.session.user.id) {
    return res.redirect('/admin/users');
  }
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (targetUser) {
    logDeletion('User', `${targetUser.full_name} (${targetUser.username})`, req.session.user.id, req.body.reason);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/users');
});

/* ---------- Custom report builder + exports ---------- */
function reportScopeNote(req, res) {
  return seesAllReports(req.session.user, res.locals.perms) ? '' : 'Limited to tickets for your own department.';
}

router.get('/reports/builder', (req, res) => {
  const run = req.query.run === '1';
  const report = buildReport(req.session.user, res.locals.perms, req.query);
  res.render('admin/report-builder', {
    title: 'Custom Report',
    run, report,
    columnsAll: COLUMNS, groupsAll: GROUPS, sortsAll: SORTS,
    choices: filterChoices(),
    queryString: new URLSearchParams(Object.entries(req.query).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => [k, x])).filter(([k]) => k !== 'run')).toString(),
    scopeNote: reportScopeNote(req, res),
  });
});

router.get('/reports/export', (req, res) => {
  const format = ['pdf', 'xlsx', 'csv'].includes(req.query.format) ? req.query.format : 'pdf';
  const report = buildReport(req.session.user, res.locals.perms, req.query);
  const stamp = new Date().toISOString().slice(0, 10);
  const title = 'Ticket Report';
  const filename = `OSA-${title.replace(/\s+/g, '-')}-${stamp}.${format}`;
  const cellsOf = (r) => report.columns.map(c => c.get(r));

  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return renderPdf(res, report, {
      title,
      generated: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      by: req.session.user.full_name,
      scopeNote: reportScopeNote(req, res),
      logo: getExportLogo(),
    });
  }

  const grouped = !!report.options.groupBy;
  const summaryText = (sm) => `${sm.count} ticket${sm.count === 1 ? '' : 's'} · ${sm.finished} finished${sm.avgTime ? ' · avg ' + sm.avgTime : ''}${sm.slaRate !== null ? ' · ' + sm.slaRate + '% within SLA' : ''}`;

  if (format === 'csv') {
    const q = (v) => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const header = report.columns.map(c => c.label);
    const lines = [];
    if (grouped) header.unshift(report.groupLabel);
    lines.push(header.map(q).join(','));
    report.groups.forEach(g => g.rows.forEach(r => lines.push((grouped ? [g.label, ...cellsOf(r)] : cellsOf(r)).map(q).join(','))));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
  }

  // Excel
  const exportLogo = getExportLogo();
  const rows = [];
  // three empty rows at the top leave room for the logo picture
  if (exportLogo) for (let i = 0; i < 3; i++) rows.push({ cells: [] });
  rows.push({ style: 3, cells: [title] });
  rows.push({ style: 4, cells: [`Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC by ${req.session.user.full_name}`] });
  rows.push({ style: 4, cells: [report.filters.length ? 'Filters: ' + report.filters.join('  |  ') : 'Filters: none (all tickets you can see)'] });
  rows.push({ style: 4, cells: [`Grouped by: ${report.groupLabel}   |   Sorted by: ${report.sortLabel}`] });
  const note = reportScopeNote(req, res);
  if (note) rows.push({ style: 4, cells: [note] });
  rows.push({ style: 2, cells: [summaryText(report.summary), ...report.columns.slice(1).map(() => '')] });
  rows.push({ cells: [] });
  rows.push({ style: 1, cells: report.columns.map(c => c.label) });
  const headerRowNumber = rows.length;
  report.groups.forEach(g => {
    if (grouped) rows.push({ style: 2, cells: [`${g.label}  —  ${summaryText(g.summary)}`, ...report.columns.slice(1).map(() => '')] });
    g.rows.forEach(r => rows.push({ cells: cellsOf(r) }));
  });
  const buf = buildXlsx({
    sheetName: 'Ticket Report',
    widths: report.columns.map(c => c.width + 2),
    rows,
    freezeRow: headerRowNumber,
    logo: exportLogo,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});

/* ---------- Reports ---------- */
router.get('/reports', (req, res) => {
  // Anyone without full report access only sees tickets tied to their own department.
  const SCOPED = reportTicketsSource(req.session.user, res.locals.perms);
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('Open','In Progress','On Hold') THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) AS resolved_count,
      SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END) AS closed_count
    FROM ${SCOPED}
  `).get();

  const byStatus = db.prepare(`SELECT status AS label, COUNT(*) AS count FROM ${SCOPED} GROUP BY status`).all();
  const byPriority = db.prepare(`SELECT priority AS label, COUNT(*) AS count FROM ${SCOPED} GROUP BY priority`).all();
  const priorityRank = Object.fromEntries(listPriorities().map((p, i) => [p.priority, i]));
  byPriority.sort((a, b) => (priorityRank[a.label] ?? 99) - (priorityRank[b.label] ?? 99));
  const byDepartment = db.prepare(`
    SELECT COALESCE(d.name, 'Unassigned') AS label, COUNT(*) AS count
    FROM ${SCOPED} t LEFT JOIN departments d ON d.id = t.department_id
    GROUP BY label ORDER BY count DESC
  `).all();
  const byHandlingDepartment = db.prepare(`
    SELECT COALESCE(hd.name, 'Not set') AS label, COUNT(*) AS count
    FROM ${SCOPED} t
    LEFT JOIN request_types rt ON rt.id = t.request_type_id
    LEFT JOIN departments hd ON hd.id = rt.handling_department_id
    GROUP BY label ORDER BY count DESC
  `).all();
  const byRequestType = db.prepare(`
    SELECT COALESCE(rt.name, 'Not set') AS label, COUNT(*) AS count
    FROM ${SCOPED} t LEFT JOIN request_types rt ON rt.id = t.request_type_id
    GROUP BY label ORDER BY count DESC
  `).all();
  const byAgent = db.prepare(`
    SELECT COALESCE(s.full_name, u.full_name, 'Unassigned') AS label, COUNT(*) AS count
    FROM ${SCOPED} t LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN staff_members s ON s.id = t.assigned_staff_id
    GROUP BY label ORDER BY count DESC
  `).all();

  const maxCount = (rows) => Math.max(1, ...rows.map(r => r.count));

  // Resolution time + SLA compliance, computed from finished tickets
  const finished = db.prepare(`
    SELECT priority, status, created_at, resolved_at, closed_at
    FROM ${SCOPED} WHERE status IN ('Resolved', 'Closed')
  `).all();
  const slaMap = getSlaMap();

  let totalResolutionMinutes = 0;
  let resolutionSamples = 0;
  let withinSla = 0;
  let slaTracked = 0;

  finished.forEach(t => {
    const createdAt = sqliteDateToUtc(t.created_at);
    const finishedAt = t.status === 'Resolved' ? sqliteDateToUtc(t.resolved_at) : sqliteDateToUtc(t.closed_at);
    if (createdAt && finishedAt) {
      const minutesTaken = (finishedAt.getTime() - createdAt.getTime()) / 60000;
      totalResolutionMinutes += minutesTaken;
      resolutionSamples += 1;

      const slaMinutes = slaMap[t.priority];
      if (slaMinutes) {
        slaTracked += 1;
        if (minutesTaken <= slaMinutes) withinSla += 1;
      }
    }
  });

  const avgResolutionMinutes = resolutionSamples ? Math.round(totalResolutionMinutes / resolutionSamples) : null;
  const slaComplianceRate = slaTracked ? Math.round((withinSla / slaTracked) * 100) : null;

  // Per-staff workload: what each person has been given and how much they finished.
  const staffTicketRows = db.prepare(`
    SELECT s.id AS staff_id, t.priority, t.status, t.created_at, t.resolved_at, t.closed_at
    FROM ${SCOPED} t JOIN staff_members s ON s.id = t.assigned_staff_id
  `).all();
  const staffMap = {};
  const staffBase = db.prepare(`
    SELECT s.id, s.full_name, s.active, s.photo, COALESCE(d.name, 'No department') AS department_name
    FROM staff_members s LEFT JOIN departments d ON d.id = s.department_id
  `).all();
  staffBase.forEach(b => { staffMap[b.id] = { ...b, total: 0, open: 0, completed: 0, minutes: 0, samples: 0, within: 0, tracked: 0 }; });
  staffTicketRows.forEach(t => {
    const m = staffMap[t.staff_id]; if (!m) return;
    m.total += 1;
    if (t.status === 'Resolved' || t.status === 'Closed') {
      m.completed += 1;
      const c = sqliteDateToUtc(t.created_at);
      const f = t.status === 'Resolved' ? sqliteDateToUtc(t.resolved_at) : sqliteDateToUtc(t.closed_at);
      if (c && f) {
        const mins = (f.getTime() - c.getTime()) / 60000;
        m.minutes += mins; m.samples += 1;
        if (slaMap[t.priority]) { m.tracked += 1; if (mins <= slaMap[t.priority]) m.within += 1; }
      }
    } else m.open += 1;
  });
  const fullView = seesAllReports(req.session.user, res.locals.perms);
  const staffDepartments = {};
  Object.values(staffMap)
    .filter(m => m.total > 0 || (fullView && m.active))
    .forEach(m => {
      m.avgMinutes = m.samples ? Math.round(m.minutes / m.samples) : null;
      m.slaRate = m.tracked ? Math.round((m.within / m.tracked) * 100) : null;
      (staffDepartments[m.department_name] = staffDepartments[m.department_name] || []).push(m);
    });
  const staffStats = Object.entries(staffDepartments)
    .map(([department, members]) => ({ department, members: members.sort((a, b) => b.completed - a.completed || a.full_name.localeCompare(b.full_name)) }))
    .sort((a, b) => a.department.localeCompare(b.department));

  // Currently-overdue open tickets, for a quick action list
  const openTickets = db.prepare(`
    SELECT t.*, rt.name AS request_type_name, d.name AS department_name, r.number AS room_number
    FROM ${SCOPED} t
    LEFT JOIN request_types rt ON rt.id = t.request_type_id
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN rooms r ON r.id = t.room_id
    WHERE t.status IN ('Open','In Progress','On Hold')
  `).all();
  openTickets.forEach(t => attachSlaInfo(t, slaMap));
  const overdueTickets = openTickets.filter(t => t.isOverdue).sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Tickets created per day, last 14 days
  const dailyRows = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS count
    FROM ${SCOPED}
    WHERE created_at >= datetime('now', '-14 days')
    GROUP BY day ORDER BY day ASC
  `).all();

  // Ticket throughput chart: opened vs resolved/closed, per day for the last 14 days,
  // with every day present (zero-filled) so the two series line up.
  const resolvedDailyRows = db.prepare(`
    SELECT date(COALESCE(resolved_at, closed_at)) AS day, COUNT(*) AS count
    FROM ${SCOPED}
    WHERE COALESCE(resolved_at, closed_at) >= datetime('now', '-14 days')
    GROUP BY day ORDER BY day ASC
  `).all();
  const openedByDay = Object.fromEntries(dailyRows.map(r => [r.day, r.count]));
  const resolvedByDay = Object.fromEntries(resolvedDailyRows.map(r => [r.day, r.count]));
  const chartDays = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    chartDays.push(d.toISOString().slice(0, 10));
  }
  const throughputChart = {
    labels: chartDays.map(d => d.slice(5)),
    opened: chartDays.map(d => openedByDay[d] || 0),
    resolved: chartDays.map(d => resolvedByDay[d] || 0),
  };

  const createdThisWeek = db.prepare(`SELECT COUNT(*) c FROM ${SCOPED} WHERE created_at >= datetime('now', '-7 days')`).get().c;

  // Top few open tickets, most SLA-urgent first, for the "Active Tickets" progress list
  const activeTickets = openTickets
    .map(t => {
      const created = sqliteDateToUtc(t.created_at);
      const due = t.dueAtIso ? new Date(t.dueAtIso) : null;
      let percent = null;
      if (created && due) {
        const totalWindow = due.getTime() - created.getTime();
        const elapsed = Date.now() - created.getTime();
        percent = totalWindow > 0 ? Math.round((elapsed / totalWindow) * 100) : 100;
      }
      return { ...t, slaPercent: percent };
    })
    .sort((a, b) => (b.slaPercent ?? -1) - (a.slaPercent ?? -1))
    .slice(0, 6);

  // Recent activity feed across every ticket — comments + system status changes
  const recentActivity = db.prepare(`
    SELECT c.body, c.is_system, c.created_at, u.full_name AS author_name,
           t.id AS ticket_id, t.ticket_number, t.subject
    FROM ticket_comments c
    JOIN ${SCOPED} t ON t.id = c.ticket_id
    LEFT JOIN users u ON u.id = c.user_id
    ORDER BY c.created_at DESC
    LIMIT 8
  `).all();

  res.render('admin/reports', {
    title: 'Reports',
    totals,
    byStatus, byPriority, byDepartment, byHandlingDepartment, byRequestType, byAgent,
    maxCount,
    avgResolutionMinutes, slaComplianceRate, slaTracked, createdThisWeek,
    overdueTickets,
    activeTickets, recentActivity,
    dailyRows, throughputChart,
    formatMinutes,
    staffStats,
    scopedToDepartment: !seesAllReports(req.session.user, res.locals.perms),
    scopeDepartmentName: (db.prepare('SELECT name FROM departments WHERE id = ?').get(req.session.user.department_id || 0) || {}).name || null,
  });
});

/* ---------- Deleted Items (audit log) ---------- */
router.get('/deleted-items', (req, res) => {
  const entries = db.prepare(`
    SELECT dl.*, u.full_name AS deleted_by_name
    FROM deletion_log dl
    LEFT JOIN users u ON u.id = dl.deleted_by
    ORDER BY dl.deleted_at DESC
  `).all();
  res.render('admin/deleted-items', { title: 'Deleted Items', entries });
});

module.exports = router;
