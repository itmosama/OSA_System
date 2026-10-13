const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const { requireLogin, requireRole, requirePermission, requireRoleOrPermission } = require('../middleware/auth');
const { upload, uploadsDir } = require('../middleware/upload');
const { getSlaMap, attachSlaInfo, formatMinutes } = require('../utils/sla');
const { generateSerial } = require('../utils/serial');
const { logDeletion } = require('../utils/auditLog');
const { isValidPriority, validPriorityOrDefault } = require('../utils/priorities');
const { canSubmitTickets, hasDepartmentView, ticketScope, canViewTicket } = require('../utils/ticketAccess');
const { notificationScope, markTicketBellRead, snippet } = require('../utils/ticketNotifications');

const router = express.Router();
router.use(requireLogin);

// The "Staff Name" picker on the ticket forms lists staff added under Admin -> Staff.
// Admins and people with "See staff of every department" get everyone; all other
// users only get staff from their own department.
function loadReporterOptions(user, perms) {
  const everyone = user.role === 'admin' || !!perms.can_view_all_staff;
  const own = db.prepare('SELECT department_id FROM users WHERE id = ?').get(user.id);
  const deptId = own && own.department_id ? own.department_id : 0;
  const rows = db.prepare(`
    SELECT s.full_name, COALESCE(d.name, 'No department') AS department_name
    FROM staff_members s LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.active = 1 ${everyone ? '' : 'AND s.department_id = ?'} ORDER BY d.name, s.full_name
  `).all(...(everyone ? [] : [deptId]));
  const groups = {};
  rows.forEach(r => { (groups[r.department_name] = groups[r.department_name] || []).push(r.full_name); });
  return {
    groups: Object.entries(groups).map(([name, members]) => ({ name, members })),
    names: new Set(rows.map(r => r.full_name)),
  };
}
router.use((req, res, next) => {
  const opts = loadReporterOptions(req.session.user, res.locals.perms);
  res.locals.reporterLimited = !(req.session.user.role === 'admin' || res.locals.perms.can_view_all_staff);
  res.locals.reporterGroups = opts.groups;
  res.locals.reporterNames = opts.names;
  next();
});

const uploadPhotos = upload.array('photos', 6);
const ROOM_OCCUPANCY_VALUES = ['Vacant', 'Occupied - Guest In', 'Occupied - Guest Out'];

// Wraps multer so its errors (file too large, wrong type, etc.) don't crash the request
function handleUpload(req, res, next) {
  uploadPhotos(req, res, (err) => {
    if (err) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE'
        ? 'One of your photos is too large (max 10MB per photo).'
        : (err.message || 'Could not upload photo(s).');
    }
    next();
  });
}

function generateTicketNumber() {
  return generateSerial('T', 'tickets', 'ticket_number');
}

function canManageTicket(user, ticket) {
  if (user.role === 'admin' || user.role === 'agent') return true;
  return ticket.created_by === user.id;
}

// Looks up a room by number. Does NOT create new rooms — the room must already
// exist in the system (added by an admin) for a ticket to be accepted.
function findRoomId(numberRaw) {
  const number = (numberRaw || '').trim();
  if (!number) return { id: null, error: null, notProvided: true };
  const existing = db.prepare('SELECT id FROM rooms WHERE number = ?').get(number);
  if (!existing) {
    return { id: null, error: `Room "${number}" was not found in the system. Please choose a room from the list.` };
  }
  return { id: existing.id, error: null };
}

function normalizeRoomOccupancy(value) {
  return ROOM_OCCUPANCY_VALUES.includes(value) ? value : null;
}

function saveAttachments(files, ticketId, commentId, userId) {
  if (!files || !files.length) return;
  const insert = db.prepare(`
    INSERT INTO attachments (ticket_id, comment_id, filename, original_name, uploaded_by)
    VALUES (?, ?, ?, ?, ?)
  `);
  files.forEach(f => insert.run(ticketId, commentId, f.filename, f.originalname || null, userId));
}

function deleteTicketFiles(ticketId) {
  const attachments = db.prepare('SELECT filename FROM attachments WHERE ticket_id = ?').all(ticketId);
  attachments.forEach(a => {
    const filePath = path.join(uploadsDir, a.filename);
    fs.unlink(filePath, () => {}); // best-effort cleanup, ignore errors
  });
}

const ACTIVE_STATUSES = ['Open', 'In Progress', 'On Hold'];
const DONE_STATUSES = ['Resolved', 'Closed'];

// Dashboard / ticket list — split into an "Active" tab (Open/In Progress/On Hold)
// and a "Completed" tab (Resolved/Closed) so finished tickets don't clutter the
// working list. Picking a specific status auto-switches to the tab it belongs to.
router.get('/', (req, res) => {
  const user = req.session.user;
  const { status, department_id, mine, staff_id } = req.query;

  let view = req.query.view === 'done' ? 'done' : 'active';
  if (status && DONE_STATUSES.includes(status)) view = 'done';
  else if (status && ACTIVE_STATUSES.includes(status)) view = 'active';
  const viewStatuses = view === 'done' ? DONE_STATUSES : ACTIVE_STATUSES;

  let query = `
    SELECT t.*, rt.name AS request_type_name, d.name AS department_name, r.number AS room_number,
           hd.name AS handling_department_name,
           cu.full_name AS created_by_name, COALESCE(st.full_name, au.full_name) AS assigned_to_name, st.department_id AS assigned_staff_department_id,
           EXISTS(SELECT 1 FROM attachments a WHERE a.ticket_id = t.id) AS has_photos
    FROM tickets t
    LEFT JOIN request_types rt ON rt.id = t.request_type_id
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN departments hd ON hd.id = rt.handling_department_id
    LEFT JOIN rooms r ON r.id = t.room_id
    LEFT JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users au ON au.id = t.assigned_to
    LEFT JOIN staff_members st ON st.id = t.assigned_staff_id
    WHERE 1=1
  `;
  const params = [];

  const scope = ticketScope(user, res.locals.perms);
  if (scope) {
    query += ` AND ${scope.sql}`;
    params.push(...scope.params);
  }
  if (!scope && mine === '1') {
    query += ' AND t.assigned_to = ?';
    params.push(user.id);
  }

  query += ` AND t.status IN (${viewStatuses.map(() => '?').join(',')})`;
  params.push(...viewStatuses);

  if (status && viewStatuses.includes(status)) {
    query += ' AND t.status = ?';
    params.push(status);
  }
  if (department_id) {
    query += ' AND t.department_id = ?';
    params.push(department_id);
  }
  if (staff_id) {
    query += ' AND t.assigned_staff_id = ?';
    params.push(staff_id);
  }

  query += ' ORDER BY t.created_at DESC';
  const tickets = db.prepare(query).all(...params);

  const slaMap = getSlaMap();
  tickets.forEach(t => attachSlaInfo(t, slaMap));

  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();

  // Status counts scoped the same way as the list itself (requester sees only their
  // own counts), used for both the tab badges and the per-status tiles.
  let countQuery = `SELECT status, COUNT(*) c FROM tickets t WHERE 1=1`;
  const countParams = [];
  if (scope) { countQuery += ` AND ${scope.sql}`; countParams.push(...scope.params); }
  else if (mine === '1') { countQuery += ' AND t.assigned_to = ?'; countParams.push(user.id); }
  if (department_id) { countQuery += ' AND t.department_id = ?'; countParams.push(department_id); }
  if (staff_id) { countQuery += ' AND t.assigned_staff_id = ?'; countParams.push(staff_id); }
  countQuery += ' GROUP BY status';
  const statusCounts = Object.fromEntries(db.prepare(countQuery).all(...countParams).map(r => [r.status, r.c]));

  const activeTotal = ACTIVE_STATUSES.reduce((sum, s) => sum + (statusCounts[s] || 0), 0);
  const doneTotal = DONE_STATUSES.reduce((sum, s) => sum + (statusCounts[s] || 0), 0);

  // Overdue count, scoped the same way, so the banner matches what this user can see.
  let openQuery = `SELECT priority, status, created_at, resolved_at, closed_at FROM tickets t WHERE t.status IN ('Open','In Progress','On Hold')`;
  const openParams = [];
  if (scope) { openQuery += ` AND ${scope.sql}`; openParams.push(...scope.params); }
  else if (mine === '1') { openQuery += ' AND t.assigned_to = ?'; openParams.push(user.id); }
  const allOpenTickets = db.prepare(openQuery).all(...openParams);
  allOpenTickets.forEach(t => attachSlaInfo(t, slaMap));

  const stats = {
    total: activeTotal + doneTotal,
    activeTotal, doneTotal,
    overdue: allOpenTickets.filter(t => t.isOverdue).length,
    byStatus: viewStatuses.map(s => ({ status: s, count: statusCounts[s] || 0 })),
  };

  res.render('tickets/index', {
    title: 'Tickets',
    tickets, departments, viewStatuses, stats, formatMinutes, view,
    filters: { status: status || '', department_id: department_id || '', mine: mine || '', staff_id: staff_id || '' },
    staffName: staff_id ? (db.prepare('SELECT full_name FROM staff_members WHERE id = ?').get(staff_id) || {}).full_name || null : null,
    currentUrl: req.originalUrl,
    canSubmit: canSubmitTickets(user, res.locals.perms),
  });
});

// Blocks users whose permission group does not allow submitting tickets.
function requireSubmitAccess(req, res, next) {
  if (canSubmitTickets(req.session.user, res.locals.perms)) return next();
  return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to submit tickets.' });
}

// The submitter's own department is recorded automatically (read live so a
// transfer is picked up even if their session is older).
function submitterDepartmentId(user) {
  const row = db.prepare('SELECT department_id FROM users WHERE id = ?').get(user.id);
  return row ? row.department_id : null;
}

function submitterDepartmentName(user) {
  const id = submitterDepartmentId(user);
  const row = id ? db.prepare('SELECT name FROM departments WHERE id = ?').get(id) : null;
  return row ? row.name : null;
}

router.get('/new', requireSubmitAccess, (req, res) => {
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const requestTypes = db.prepare('SELECT * FROM request_types ORDER BY name').all();
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY number').all();
  res.render('tickets/new', {
    title: 'New Ticket', departments, requestTypes, rooms, error: null,
    submitterDepartment: submitterDepartmentName(req.session.user),
    values: { subject: '', description: '', request_type_id: '', department_id: '', room_number: '', priority: 'Medium', room_occupancy: '', reported_by_name: '' },
  });
});

router.post('/', requireSubmitAccess, handleUpload, (req, res) => {
  const user = req.session.user;
  const { subject, description, request_type_id, department_id, room_number, priority, room_occupancy, reported_by_name } = req.body;

  const rerenderWithError = (message) => {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const requestTypes = db.prepare('SELECT * FROM request_types ORDER BY name').all();
    const rooms = db.prepare('SELECT * FROM rooms ORDER BY number').all();
    return res.status(400).render('tickets/new', {
      title: 'New Ticket', departments, requestTypes, rooms, error: message,
      submitterDepartment: submitterDepartmentName(user),
      values: { subject, description, request_type_id, department_id, room_number, priority, room_occupancy, reported_by_name },
    });
  };

  if (!subject || !subject.trim()) return rerenderWithError('Subject is required.');
  if (!request_type_id) return rerenderWithError('Request type is required.');
  if (!department_id) return rerenderWithError('Department is required.');
  if (reported_by_name && reported_by_name.trim() && !res.locals.reporterNames.has(reported_by_name.trim())) {
    return rerenderWithError('Please choose the staff name from the list.');
  }
  if (req.uploadError) return rerenderWithError(req.uploadError);

  const room = findRoomId(room_number);
  if (room.error) return rerenderWithError(room.error);

  const ticketNumber = generateTicketNumber();

  const info = db.prepare(`
    INSERT INTO tickets (ticket_number, subject, description, priority, request_type_id, department_id, room_id, room_occupancy, reported_by_name, created_by, requester_department_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketNumber,
    subject.trim(),
    (description || '').trim(),
    validPriorityOrDefault(priority),
    request_type_id,
    department_id,
    room.id,
    normalizeRoomOccupancy(room_occupancy),
    (reported_by_name || '').trim() || null,
    user.id,
    submitterDepartmentId(user)
  );

  saveAttachments(req.files, info.lastInsertRowid, null, user.id);

  res.redirect(`/tickets/${info.lastInsertRowid}`);
});

// Clears the ticket part of the bell.
router.post('/notifications/read', (req, res) => {
  markTicketBellRead(req.session.user.id);
  const back = req.get('referer');
  res.redirect(back && back.startsWith(req.protocol + '://' + req.get('host')) ? back : '/tickets');
});

// Polled by the browser to pop up alerts: brand-new tickets and updates on tickets that
// concern the signed-in user or their department. The first poll of a session only
// records where things stand, so old activity does not pop up on login.
router.get('/api/notifications', (req, res) => {
  const user = req.session.user;
  const scope = notificationScope(user, res.locals.perms);

  if (req.session.lastNotifiedTicketId === undefined || req.session.lastNotifiedCommentId === undefined) {
    req.session.lastNotifiedTicketId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM tickets').get().m;
    req.session.lastNotifiedCommentId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ticket_comments').get().m;
    return res.json({ tickets: [], updates: [] });
  }
  const lastTicketId = req.session.lastNotifiedTicketId;
  const lastCommentId = req.session.lastNotifiedCommentId || 0;

  const tickets = db.prepare(`
    SELECT t.id, t.ticket_number, t.subject, t.priority FROM tickets t
    WHERE t.id > ? AND t.created_by != ? AND ${scope.sql}
    ORDER BY t.id ASC LIMIT 20
  `).all(lastTicketId, user.id, ...scope.params);

  const updateRows = db.prepare(`
    SELECT c.id AS comment_id, t.id, t.ticket_number, t.subject, c.body, cu.full_name AS actor
    FROM ticket_comments c
    JOIN tickets t ON t.id = c.ticket_id
    LEFT JOIN users cu ON cu.id = c.user_id
    WHERE c.id > ? AND c.user_id != ? AND ${scope.sql}
    ORDER BY c.id ASC LIMIT 20
  `).all(lastCommentId, user.id, ...scope.params);

  req.session.lastNotifiedTicketId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM tickets').get().m;
  req.session.lastNotifiedCommentId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ticket_comments').get().m;

  res.json({
    tickets,
    updates: updateRows.map(u => ({ id: u.id, ticket_number: u.ticket_number, subject: u.subject, actor: u.actor || 'Someone', text: snippet(u.body) })),
  });
});

router.get('/:id', (req, res) => {
  const user = req.session.user;
  const ticket = db.prepare(`
    SELECT t.*, rt.name AS request_type_name, d.name AS department_name, r.number AS room_number,
           hd.name AS handling_department_name, rd.name AS requester_department_name,
           cu.full_name AS created_by_name, COALESCE(st.full_name, au.full_name) AS assigned_to_name, st.photo AS assigned_staff_photo
    FROM tickets t
    LEFT JOIN request_types rt ON rt.id = t.request_type_id
    LEFT JOIN departments rd ON rd.id = t.requester_department_id
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN departments hd ON hd.id = rt.handling_department_id
    LEFT JOIN rooms r ON r.id = t.room_id
    LEFT JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users au ON au.id = t.assigned_to
    LEFT JOIN staff_members st ON st.id = t.assigned_staff_id
    WHERE t.id = ?
  `).get(req.params.id);

  if (!ticket) return res.status(404).render('error', { title: 'Not Found', message: 'Ticket not found.' });
  if (!canViewTicket(user, res.locals.perms, ticket, db)) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view this ticket.' });
  }

  attachSlaInfo(ticket, getSlaMap());

  const comments = db.prepare(`
    SELECT c.*, u.full_name AS author_name FROM ticket_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.ticket_id = ? ORDER BY c.created_at ASC
  `).all(ticket.id);

  const allAttachments = db.prepare('SELECT * FROM attachments WHERE ticket_id = ? ORDER BY created_at ASC').all(ticket.id);
  const ticketPhotos = allAttachments.filter(a => !a.comment_id);
  const attachmentsByComment = {};
  allAttachments.filter(a => a.comment_id).forEach(a => {
    (attachmentsByComment[a.comment_id] = attachmentsByComment[a.comment_id] || []).push(a);
  });

  // Staff who can take the ticket, grouped by department with the department asked to
  // do the job listed first (the current assignee stays listed even if now inactive).
  const staffRows = db.prepare(`
    SELECT s.id, s.full_name, d.name AS department_name, s.department_id
    FROM staff_members s LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.active = 1 OR s.id = ?
    ORDER BY d.name, s.full_name
  `).all(ticket.assigned_staff_id || 0);
  const staffByDepartment = {};
  staffRows.forEach(r => { (staffByDepartment[r.department_name || 'No department'] = staffByDepartment[r.department_name || 'No department'] || []).push(r); });
  const staffGroups = Object.entries(staffByDepartment)
    .map(([name, members]) => ({ name, members, first: ticket.department_name === name }))
    .sort((a, b) => (b.first - a.first) || a.name.localeCompare(b.name));
  const statuses = ['Open', 'In Progress', 'On Hold', 'Resolved', 'Closed'];

  // Previous/Next navigation — scoped to whatever tickets this user is allowed to see
  const navScope = ticketScope(user, res.locals.perms);
  const scopeClause = navScope ? `AND ${navScope.sql}` : '';
  const scopeParams = navScope ? navScope.params : [];
  const prevRow = db.prepare(`SELECT t.id FROM tickets t WHERE t.id < ? ${scopeClause} ORDER BY t.id DESC LIMIT 1`).get(ticket.id, ...scopeParams);
  const nextRow = db.prepare(`SELECT t.id FROM tickets t WHERE t.id > ? ${scopeClause} ORDER BY t.id ASC LIMIT 1`).get(ticket.id, ...scopeParams);

  res.render('tickets/show', {
    title: `${ticket.ticket_number}`,
    ticket, comments, staffGroups, statuses, ticketPhotos, attachmentsByComment, formatMinutes,
    roomOccupancyValues: ROOM_OCCUPANCY_VALUES,
    canManage: canManageTicket(user, ticket),
    prevTicketId: prevRow ? prevRow.id : null,
    nextTicketId: nextRow ? nextRow.id : null,
  });
});

router.post('/:id/comments', handleUpload, (req, res) => {
  const user = req.session.user;
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: 'Not Found', message: 'Ticket not found.' });
  if (!canViewTicket(user, res.locals.perms, ticket, db)) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot comment on this ticket.' });
  }

  const body = (req.body.body || '').trim();
  const hasPhotos = req.files && req.files.length;

  if (body || hasPhotos) {
    const info = db.prepare('INSERT INTO ticket_comments (ticket_id, user_id, body) VALUES (?, ?, ?)')
      .run(ticket.id, user.id, body || '(photo attached)');
    saveAttachments(req.files, ticket.id, info.lastInsertRowid, user.id);
    db.prepare(`UPDATE tickets SET updated_at = datetime('now') WHERE id = ?`).run(ticket.id);
  }
  res.redirect(`/tickets/${ticket.id}`);
});

// Update status / assignment / priority / room occupancy — agents & admins only
router.post('/:id/update', requireRoleOrPermission(['admin', 'agent'], 'can_manage_tickets'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: 'Not Found', message: 'Ticket not found.' });

  const { status, assigned_staff_id, priority, room_occupancy, return_to } = req.body;
  const user = req.session.user;
  const notes = [];

  const fields = [];
  const params = [];

  if (status && status !== ticket.status) {
    fields.push('status = ?'); params.push(status);
    notes.push(`Status changed from "${ticket.status}" to "${status}"`);
    if (status === 'Resolved') { fields.push(`resolved_at = datetime('now')`); }
    if (status === 'Closed') { fields.push(`closed_at = datetime('now')`); }
  }
  if (assigned_staff_id !== undefined) {
    const newStaff = assigned_staff_id ? db.prepare('SELECT * FROM staff_members WHERE id = ?').get(Number(assigned_staff_id)) : null;
    const newStaffId = newStaff ? newStaff.id : null;
    if (newStaffId !== (ticket.assigned_staff_id || null)) {
      fields.push('assigned_staff_id = ?'); params.push(newStaffId);
      // Keep the login link in step so "Assigned to me" still works for staff with an account.
      fields.push('assigned_to = ?'); params.push(newStaff ? newStaff.user_id : null);
      notes.push(`Assigned to ${newStaff ? newStaff.full_name : 'Unassigned'}`);
    }
  }
  if (priority && priority !== ticket.priority && isValidPriority(priority)) {
    fields.push('priority = ?'); params.push(priority);
    notes.push(`Priority changed to "${priority}"`);
  }
  if (room_occupancy !== undefined) {
    const newOccupancy = normalizeRoomOccupancy(room_occupancy);
    if (newOccupancy !== ticket.room_occupancy) {
      fields.push('room_occupancy = ?'); params.push(newOccupancy);
      notes.push(`Room status changed to "${newOccupancy || 'Not set'}"`);
    }
  }

  if (fields.length) {
    fields.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...params, ticket.id);
    if (notes.length) {
      db.prepare('INSERT INTO ticket_comments (ticket_id, user_id, body, is_system) VALUES (?, ?, ?, 1)')
        .run(ticket.id, user.id, notes.join('; '));
    }
  }

  if (return_to && return_to.startsWith('/tickets') && !return_to.startsWith('//')) {
    return res.redirect(return_to);
  }
  res.redirect(`/tickets/${ticket.id}`);
});

// Edit ticket details — admin only
router.get('/:id/edit', requirePermission('can_edit_tickets'), (req, res) => {
  const ticket = db.prepare('SELECT t.*, r.number AS room_number FROM tickets t LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?').get(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: 'Not Found', message: 'Ticket not found.' });

  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const requestTypes = db.prepare('SELECT * FROM request_types ORDER BY name').all();
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY number').all();

  res.render('tickets/edit', {
    title: `Edit ${ticket.ticket_number}`,
    ticket, departments, requestTypes, rooms, error: null,
    roomOccupancyValues: ROOM_OCCUPANCY_VALUES,
  });
});

router.post('/:id/edit', requirePermission('can_edit_tickets'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: 'Not Found', message: 'Ticket not found.' });

  const { subject, description, request_type_id, department_id, room_number, priority, room_occupancy, reported_by_name } = req.body;

  const rerenderWithError = (message) => {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const requestTypes = db.prepare('SELECT * FROM request_types ORDER BY name').all();
    const rooms = db.prepare('SELECT * FROM rooms ORDER BY number').all();
    return res.status(400).render('tickets/edit', {
      title: `Edit ${ticket.ticket_number}`, departments, requestTypes, rooms, error: message,
      ticket: { ...ticket, subject, description, request_type_id, department_id, room_number, priority, room_occupancy, reported_by_name },
      roomOccupancyValues: ROOM_OCCUPANCY_VALUES,
    });
  };

  if (!subject || !subject.trim()) return rerenderWithError('Subject is required.');
  if (!request_type_id) return rerenderWithError('Request type is required.');
  if (!department_id) return rerenderWithError('Department is required.');
  const reporter = (reported_by_name || '').trim();
  // An older free-typed name already on this ticket may stay; a new name must come from the list.
  if (reporter && reporter !== (ticket.reported_by_name || '') && !res.locals.reporterNames.has(reporter)) {
    return rerenderWithError('Please choose the staff name from the list.');
  }

  const room = findRoomId(room_number);
  if (room.error) return rerenderWithError(room.error);

  db.prepare(`
    UPDATE tickets SET subject = ?, description = ?, priority = ?, request_type_id = ?, department_id = ?, room_id = ?, room_occupancy = ?, reported_by_name = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(subject.trim(), (description || '').trim(), validPriorityOrDefault(priority), request_type_id, department_id, room.id, normalizeRoomOccupancy(room_occupancy), (reported_by_name || '').trim() || null, ticket.id);

  db.prepare('INSERT INTO ticket_comments (ticket_id, user_id, body, is_system) VALUES (?, ?, ?, 1)')
    .run(ticket.id, req.session.user.id, 'Ticket details edited by admin');

  res.redirect(`/tickets/${ticket.id}`);
});

// Delete ticket — admin only
router.post('/:id/delete', requirePermission('can_delete_tickets'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: 'Not Found', message: 'Ticket not found.' });

  logDeletion('Ticket', `${ticket.ticket_number} — ${ticket.subject}`, req.session.user.id, req.body.reason);
  deleteTicketFiles(ticket.id);
  db.prepare('DELETE FROM tickets WHERE id = ?').run(ticket.id);

  res.redirect('/tickets');
});

module.exports = router;
