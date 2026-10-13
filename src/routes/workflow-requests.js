const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { getUserPermissions } = require('../utils/permissions');
const { generateYearlySerial } = require('../utils/serial');
const { sendMail } = require('../utils/mailer');
const { validPriorityOrDefault } = require('../utils/priorities');
const flow = require('../utils/workflowRequestFlow');
const { visibilityClause, actionableClause } = require('../utils/workflowRequestQueries');

const { STATUS, PERMISSION } = flow;

const router = express.Router();
router.use(requireLogin);

// Only people who take part in the workflow (or admins) can use this area.
router.use((req, res, next) => {
  const user = req.session.user;
  const perms = getUserPermissions(user);
  if (user.role === 'admin' || flow.ALL_PERMISSIONS.some(k => perms[k])) {
    req.wfPerms = perms;
    return next();
  }
  return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to view this page.' });
});

const uploadPhotos = upload.array('photos', 6);
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

const isAdmin = (user) => user.role === 'admin';
const deny = (res, message) => res.status(403).render('error', { title: 'Access Denied', message });

function departmentOk(user, request) {
  return isAdmin(user) || !user.department_id || !request.department_id || user.department_id === request.department_id;
}

// What this user may do to this request right now.
function abilities(user, perms, r) {
  const admin = isAdmin(user);
  const owner = r.created_by === user.id;
  const mayEdit = (admin || (owner && perms[PERMISSION.SUBMIT])) && [STATUS.DRAFT, STATUS.RETURNED].includes(r.status);
  return {
    edit: mayEdit,
    submit: mayEdit,
    hod: r.status === STATUS.HOD && (admin || (perms[PERMISSION.HOD] && departmentOk(user, r))),
    finance: r.status === STATUS.FINANCE && (admin || !!perms[PERMISSION.FINANCE]),
    start: r.status === STATUS.IT && (admin || !!perms[PERMISSION.IT]),
    complete: r.status === STATUS.IN_PROGRESS && (admin || !!perms[PERMISSION.IT]),
    note: r.status !== STATUS.CANCELLED,
    cancel: (admin || owner) && flow.nextStatus(r.status, 'cancel') !== null,
  };
}

const SELECT_REQUEST = `
  SELECT w.*, d.name AS department_name, cu.full_name AS created_by_name, au.full_name AS assigned_to_name
  FROM workflow_requests w
  LEFT JOIN departments d ON d.id = w.department_id
  LEFT JOIN users cu ON cu.id = w.created_by
  LEFT JOIN users au ON au.id = w.assigned_to
`;

function getRequest(id) {
  return db.prepare(`${SELECT_REQUEST} WHERE w.id = ?`).get(id);
}

function log(requestId, userId, action, details) {
  db.prepare('INSERT INTO workflow_request_log (request_id, user_id, action, details) VALUES (?, ?, ?, ?)')
    .run(requestId, userId, action, details || null);
  db.prepare(`UPDATE workflow_requests SET updated_at = datetime('now') WHERE id = ?`).run(requestId);
}

function saveAttachments(files, requestId, userId) {
  if (!files || !files.length) return;
  const insert = db.prepare('INSERT INTO workflow_request_attachments (request_id, filename, original_name, uploaded_by) VALUES (?, ?, ?, ?)');
  files.forEach(f => insert.run(requestId, f.filename, f.originalname || null, userId));
}

// Email whoever must act next. Silent when SMTP isn't configured (see utils/mailer.js).
function notifyStep(step, request) {
  const col = { HOD: PERMISSION.HOD, Finance: PERMISSION.FINANCE, IT: PERMISSION.IT }[step];
  if (!col) return;
  const people = db.prepare(`
    SELECT u.email, u.full_name, u.department_id, u.role FROM users u
    LEFT JOIN permission_groups g ON g.id = u.group_id
    WHERE u.active = 1 AND u.email IS NOT NULL AND u.email != '' AND (u.role = 'admin' OR g.${col} = 1)
  `).all().filter(u => step !== 'HOD' || u.role === 'admin' || !u.department_id || !request.department_id || u.department_id === request.department_id);
  people.forEach(u => sendMail({
    to: u.email,
    subject: `Workflow request ${request.reference_number} needs your action`,
    html: `<p>Hi ${u.full_name},</p><p>Workflow request <strong>${request.reference_number}</strong> (${request.title}) is waiting for you in OSA.</p>`,
  }));
}

function notifyCreator(request, subject, message) {
  const creator = db.prepare('SELECT email, full_name FROM users WHERE id = ?').get(request.created_by);
  if (creator && creator.email) {
    sendMail({ to: creator.email, subject, html: `<p>Hi ${creator.full_name},</p><p>${message}</p>` });
  }
}

/* ---------- form reading / validation ---------- */
function readForm(body) {
  return {
    title: (body.title || '').trim(),
    description: (body.description || '').trim(),
    department_id: body.department_id || '',
    requested_for: (body.requested_for || '').trim(),
    priority: body.priority || '',
    needed_by: body.needed_by || '',
  };
}

function validateForm(v) {
  if (!v.title) return 'Please give the request a title.';
  if (v.title.length > 150) return 'The title must be 150 characters or fewer.';
  if (!v.description) return 'Please describe what is needed and why.';
  if (v.description.length > 4000) return 'The description is too long (4000 characters at most).';
  if (!v.department_id || !db.prepare('SELECT 1 x FROM departments WHERE id = ?').get(v.department_id)) {
    return 'Please choose the department this request is for.';
  }
  if (v.requested_for.length > 120) return '"Who is it for" must be 120 characters or fewer.';
  if (v.needed_by && (!/^\d{4}-\d{2}-\d{2}$/.test(v.needed_by) || isNaN(new Date(v.needed_by)))) {
    return 'Please enter a valid "needed by" date.';
  }
  return null;
}

function renderForm(res, { status = 200, mode, request = null, values, error = null }) {
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.status(status).render('workflow-requests/form', {
    title: mode === 'edit' ? `Edit ${request.reference_number}` : 'New Workflow Request',
    mode, request, values, departments, error,
  });
}

const requireSubmit = (req, res, next) => {
  if (isAdmin(req.session.user) || req.wfPerms[PERMISSION.SUBMIT]) return next();
  return deny(res, 'You do not have permission to create workflow requests.');
};

/* ---------- list ---------- */
router.get('/', (req, res) => {
  const user = req.session.user;
  const perms = req.wfPerms;
  const { status, department_id, q, filter } = req.query;

  const vis = visibilityClause(user, perms);
  let where = vis.sql;
  const params = [...vis.params];
  if (filter === 'awaiting') {
    const act = actionableClause(user, perms);
    where += ` AND ${act.sql}`;
    params.push(...act.params);
  }
  if (status && flow.ALL_STATUSES.includes(status)) { where += ' AND w.status = ?'; params.push(status); }
  if (department_id) { where += ' AND w.department_id = ?'; params.push(department_id); }
  if (q) {
    where += ' AND (w.title LIKE ? OR w.reference_number LIKE ? OR w.requested_for LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const requests = db.prepare(`${SELECT_REQUEST} WHERE ${where} ORDER BY w.updated_at DESC, w.id DESC`).all(...params);

  const counts = Object.fromEntries(
    db.prepare(`SELECT w.status, COUNT(*) c FROM workflow_requests w WHERE ${vis.sql} GROUP BY w.status`).all(...vis.params).map(r => [r.status, r.c])
  );
  const act = actionableClause(user, perms);
  const awaitingCount = db.prepare(`SELECT COUNT(*) c FROM workflow_requests w WHERE ${vis.sql} AND ${act.sql}`).get(...vis.params, ...act.params).c;

  res.render('workflow-requests/index', {
    title: 'Workflow Requests',
    requests, counts, awaitingCount,
    totalVisible: Object.values(counts).reduce((a, b) => a + b, 0),
    allStatuses: flow.ALL_STATUSES,
    departments: db.prepare('SELECT * FROM departments ORDER BY name').all(),
    canCreate: isAdmin(user) || !!perms[PERMISSION.SUBMIT],
    filters: { status: status || '', department_id: department_id || '', q: q || '', filter: filter || '' },
  });
});

/* ---------- pop-up notifications ---------- */
// Declared before '/:id' so "api" is not mistaken for a request id.
router.get('/api/notifications', (req, res) => {
  const act = actionableClause(req.session.user, req.wfPerms);
  const rows = db.prepare(`SELECT w.id, w.reference_number, w.title, w.status FROM workflow_requests w WHERE ${act.sql}`).all(...act.params);
  const key = (r) => `${r.id}:${r.status}`;

  // First poll of a session: remember what is already waiting (the bell shows it)
  // so only genuinely new work pops up.
  if (!req.session.workflowSeen) {
    req.session.workflowSeen = rows.map(key);
    return res.json({ requests: [] });
  }
  const seen = new Set(req.session.workflowSeen);
  const fresh = rows.filter(r => !seen.has(key(r))).slice(0, 5);
  req.session.workflowSeen = rows.map(key);
  res.json({ requests: fresh });
});

/* ---------- create ---------- */
router.get('/new', requireSubmit, (req, res) => {
  renderForm(res, {
    mode: 'new',
    values: { title: '', description: '', department_id: req.session.user.department_id || '', requested_for: '', priority: 'Medium', needed_by: '' },
  });
});

router.post('/', requireSubmit, handleUpload, (req, res) => {
  const user = req.session.user;
  const values = readForm(req.body);
  const error = validateForm(values) || req.uploadError;
  if (error) return renderForm(res, { status: 400, mode: 'new', values, error });

  const submitNow = req.body.action !== 'draft';
  const reference = generateYearlySerial('WFR', 'workflow_requests', 'reference_number');
  const info = db.prepare(`
    INSERT INTO workflow_requests (reference_number, status, title, description, department_id, requested_for, priority, needed_by, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(reference, submitNow ? STATUS.HOD : STATUS.DRAFT, values.title, values.description, values.department_id,
    values.requested_for || null, validPriorityOrDefault(values.priority), values.needed_by || null, user.id);

  const id = info.lastInsertRowid;
  saveAttachments(req.files, id, user.id);
  log(id, user.id, submitNow ? 'Submitted by HR' : 'Saved as draft', `Reference ${reference}`);
  if (submitNow) notifyStep('HOD', getRequest(id));
  res.redirect(`/workflow-requests/${id}`);
});

/* ---------- detail ---------- */
// Loads a request the user is allowed to see, or answers 404/403 and returns null.
function loadVisible(req, res) {
  const r = getRequest(req.params.id);
  if (!r) { res.status(404).render('error', { title: 'Not Found', message: 'Workflow request not found.' }); return null; }
  const vis = visibilityClause(req.session.user, req.wfPerms);
  const ok = db.prepare(`SELECT 1 x FROM workflow_requests w WHERE w.id = ? AND ${vis.sql}`).get(r.id, ...vis.params);
  if (!ok) { deny(res, 'You cannot view this workflow request.'); return null; }
  return r;
}

function renderShow(req, res, r, { status = 200, error = null, form = {} } = {}) {
  const user = req.session.user;
  res.status(status).render('workflow-requests/show', {
    title: r.reference_number,
    request: r,
    tracker: flow.trackerSteps(r),
    can: abilities(user, req.wfPerms, r),
    log: db.prepare(`
      SELECT l.*, u.full_name AS user_name FROM workflow_request_log l
      LEFT JOIN users u ON u.id = l.user_id WHERE l.request_id = ? ORDER BY l.id ASC
    `).all(r.id),
    attachments: db.prepare('SELECT * FROM workflow_request_attachments WHERE request_id = ? ORDER BY id').all(r.id),
    error, form,
  });
}

router.get('/:id', (req, res) => {
  const r = loadVisible(req, res);
  if (r) renderShow(req, res, r);
});

/* ---------- edit / resubmit (HR) ---------- */
router.get('/:id/edit', (req, res) => {
  const r = loadVisible(req, res);
  if (!r) return;
  if (!abilities(req.session.user, req.wfPerms, r).edit) return deny(res, 'This request can no longer be edited.');
  renderForm(res, {
    mode: 'edit', request: r,
    values: { title: r.title, description: r.description, department_id: r.department_id || '', requested_for: r.requested_for || '', priority: r.priority, needed_by: r.needed_by || '' },
  });
});

router.post('/:id/edit', handleUpload, (req, res) => {
  const r = loadVisible(req, res);
  if (!r) return;
  const user = req.session.user;
  if (!abilities(user, req.wfPerms, r).edit) return deny(res, 'This request can no longer be edited.');

  const values = readForm(req.body);
  const error = validateForm(values) || req.uploadError;
  if (error) return renderForm(res, { status: 400, mode: 'edit', request: r, values, error });

  db.prepare(`
    UPDATE workflow_requests SET title = ?, description = ?, department_id = ?, requested_for = ?, priority = ?, needed_by = ?
    WHERE id = ?
  `).run(values.title, values.description, values.department_id, values.requested_for || null,
    validPriorityOrDefault(values.priority), values.needed_by || null, r.id);
  saveAttachments(req.files, r.id, user.id);

  if (req.body.action === 'submit') {
    const next = flow.nextStatus(r.status, 'submit');
    db.prepare(`UPDATE workflow_requests SET status = ?, returned_reason = NULL, returned_by_step = NULL WHERE id = ?`).run(next, r.id);
    log(r.id, user.id, r.status === STATUS.RETURNED ? 'Resubmitted by HR' : 'Submitted by HR');
    notifyStep('HOD', getRequest(r.id));
  } else {
    log(r.id, user.id, 'Edited by HR');
  }
  res.redirect(`/workflow-requests/${r.id}`);
});

router.post('/:id/submit', (req, res) => {
  const r = loadVisible(req, res);
  if (!r) return;
  const user = req.session.user;
  if (!abilities(user, req.wfPerms, r).submit) return deny(res, 'This request cannot be submitted.');
  const next = flow.nextStatus(r.status, 'submit');
  db.prepare(`UPDATE workflow_requests SET status = ?, returned_reason = NULL, returned_by_step = NULL WHERE id = ?`).run(next, r.id);
  log(r.id, user.id, r.status === STATUS.RETURNED ? 'Resubmitted by HR' : 'Submitted by HR');
  notifyStep('HOD', getRequest(r.id));
  res.redirect(`/workflow-requests/${r.id}`);
});

/* ---------- Head of Department ---------- */
router.post('/:id/hod', (req, res) => {
  const r = loadVisible(req, res);
  if (!r) return;
  const user = req.session.user;
  if (!abilities(user, req.wfPerms, r).hod) return deny(res, 'You cannot act on this request at this step.');

  const comments = (req.body.hod_comments || '').trim().slice(0, 2000);
  const form = req.body;

  if (req.body.decision === 'return') {
    const reason = (req.body.return_reason || '').trim().slice(0, 1000);
    if (reason.length < 3) return renderShow(req, res, r, { status: 400, error: 'Please write the reason for returning this request to HR.', form });
    db.prepare(`UPDATE workflow_requests SET status = ?, hod_comments = ?, returned_reason = ?, returned_by_step = 'Head of Department' WHERE id = ?`)
      .run(flow.nextStatus(r.status, 'hod_return'), comments || null, reason, r.id);
    log(r.id, user.id, 'Returned to HR by Head of Department', reason);
    notifyCreator(r, `Workflow request ${r.reference_number} was returned`, `Your request "${r.title}" was returned by the Head of Department: ${reason}`);
    return res.redirect(`/workflow-requests/${r.id}`);
  }

  const cost = flow.parseCost(req.body.has_cost, req.body.cost_amount);
  if (!cost.ok) return renderShow(req, res, r, { status: 400, error: cost.error, form });
  const costNote = cost.hasCost ? (req.body.cost_note || '').trim().slice(0, 500) : '';

  const next = flow.nextStatus(r.status, 'hod_approve', { hasCost: cost.hasCost });
  db.prepare(`UPDATE workflow_requests SET status = ?, has_cost = ?, cost_amount = ?, cost_note = ?, hod_comments = ?, returned_reason = NULL, returned_by_step = NULL WHERE id = ?`)
    .run(next, cost.hasCost ? 1 : 0, cost.amount, costNote || null, comments || null, r.id);
  log(r.id, user.id, 'Head of Department added input and approved',
    cost.hasCost ? `Estimated cost ${cost.amount.toFixed(2)}${costNote ? ' - ' + costNote : ''}. Sent to Finance.` : 'No cost. Sent to IT.');
  notifyStep(next === STATUS.FINANCE ? 'Finance' : 'IT', getRequest(r.id));
  res.redirect(`/workflow-requests/${r.id}`);
});

/* ---------- Finance ---------- */
router.post('/:id/finance', (req, res) => {
  const r = loadVisible(req, res);
  if (!r) return;
  const user = req.session.user;
  if (!abilities(user, req.wfPerms, r).finance) return deny(res, 'You cannot act on this request at this step.');

  const comments = (req.body.finance_comments || '').trim().slice(0, 2000);

  if (req.body.decision === 'return') {
    const reason = (req.body.return_reason || '').trim().slice(0, 1000);
    if (reason.length < 3) return renderShow(req, res, r, { status: 400, error: 'Please write the reason for returning this request to HR.', form: req.body });
    db.prepare(`UPDATE workflow_requests SET status = ?, finance_comments = ?, returned_reason = ?, returned_by_step = 'Finance' WHERE id = ?`)
      .run(flow.nextStatus(r.status, 'finance_return'), comments || null, reason, r.id);
    log(r.id, user.id, 'Returned to HR by Finance', reason);
    notifyCreator(r, `Workflow request ${r.reference_number} was returned`, `Your request "${r.title}" was returned by Finance: ${reason}`);
    return res.redirect(`/workflow-requests/${r.id}`);
  }

  db.prepare(`UPDATE workflow_requests SET status = ?, finance_comments = ? WHERE id = ?`)
    .run(flow.nextStatus(r.status, 'finance_approve'), comments || null, r.id);
  log(r.id, user.id, 'Finance approved the cost', comments || null);
  notifyStep('IT', getRequest(r.id));
  res.redirect(`/workflow-requests/${r.id}`);
});

/* ---------- IT ---------- */
router.post('/:id/start', (req, res) => {
  const r = loadVisible(req, res);
  if (!r) return;
  const user = req.session.user;
  if (!abilities(user, req.wfPerms, r).start) return deny(res, 'You cannot start this request.');
  db.prepare(`UPDATE workflow_requests SET status = ?, assigned_to = ? WHERE id = ?`)
    .run(flow.nextStatus(r.status, 'start'), user.id, r.id);
  log(r.id, user.id, 'IT started work');
  res.redirect(`/workflow-requests/${r.id}`);
});

router.post('/:id/complete', (req, res) => {
  const r = loadVisible(req, res);
  if (!r) return;
  const user = req.session.user;
  if (!abilities(user, req.wfPerms, r).complete) return deny(res, 'You cannot complete this request.');
  const notes = (req.body.completion_notes || '').trim().slice(0, 2000);
  if (notes.length < 3) return renderShow(req, res, r, { status: 400, error: 'Please write what was done before completing the request.', form: req.body });
  db.prepare(`UPDATE workflow_requests SET status = ?, completion_notes = ?, completed_at = datetime('now') WHERE id = ?`)
    .run(flow.nextStatus(r.status, 'complete'), notes, r.id);
  log(r.id, user.id, 'IT completed the request', notes);
  notifyCreator(r, `Workflow request ${r.reference_number} is complete`, `Your request "${r.title}" has been completed by IT.`);
  res.redirect(`/workflow-requests/${r.id}`);
});

/* ---------- notes and cancel ---------- */
router.post('/:id/note', (req, res) => {
  const r = loadVisible(req, res);
  if (!r) return;
  if (!abilities(req.session.user, req.wfPerms, r).note) return deny(res, 'This request is cancelled.');
  const text = (req.body.note || '').trim().slice(0, 1000);
  if (text) log(r.id, req.session.user.id, 'Note', text);
  res.redirect(`/workflow-requests/${r.id}`);
});

router.post('/:id/cancel', (req, res) => {
  const r = loadVisible(req, res);
  if (!r) return;
  const user = req.session.user;
  if (!abilities(user, req.wfPerms, r).cancel) return deny(res, 'This request cannot be cancelled.');
  db.prepare(`UPDATE workflow_requests SET status = ? WHERE id = ?`).run(flow.nextStatus(r.status, 'cancel'), r.id);
  log(r.id, user.id, 'Cancelled', (req.body.reason || '').trim().slice(0, 500) || null);
  res.redirect(`/workflow-requests/${r.id}`);
});

module.exports = router;
