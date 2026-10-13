const express = require('express');
const db = require('../db');
const { requireLogin, requirePermission } = require('../middleware/auth');
const { getUserPermissions } = require('../utils/permissions');
const { generateYearlySerial } = require('../utils/serial');
const { logAccessRequestAction } = require('../utils/auditLog');
const { sendMail } = require('../utils/mailer');
const workflow = require('../utils/accessRequestWorkflow');

const router = express.Router();
router.use(requireLogin);

const EMPLOYMENT_TYPES = ['Permanent', 'Contract', 'Intern', 'Temporary'];
const OPEN_STATUSES = ['Draft', 'Submitted', 'Pending HOD', 'Pending HR', 'Pending IT Manager', 'Pending GM'];
const CLOSED_STATUSES = ['Closed', 'Rejected', 'Cancelled'];

function generateReference() {
  return generateYearlySerial('ITR', 'access_requests', 'reference_number');
}

function getRequest(id) {
  return db.prepare(`
    SELECT r.*, d.name AS department_name, u.full_name AS created_by_name
    FROM access_requests r
    LEFT JOIN departments d ON d.id = r.department_id
    LEFT JOIN users u ON u.id = r.created_by
    WHERE r.id = ?
  `).get(id);
}

function getItems(requestId) {
  return db.prepare(`
    SELECT ri.*, s.name AS system_name, s.category AS system_category, s.gm_always AS system_gm_always,
           l.name AS level_name, l.is_admin_level AS level_is_admin
    FROM access_request_items ri
    JOIN access_systems s ON s.id = ri.system_id
    LEFT JOIN access_system_levels l ON l.id = ri.level_id
    WHERE ri.request_id = ?
    ORDER BY s.sort_order, s.name
  `).all(requestId);
}

function getApprovals(requestId) {
  return db.prepare(`
    SELECT a.*, u.full_name AS approver_name
    FROM access_request_approvals a
    LEFT JOIN users u ON u.id = a.approver_id
    WHERE a.request_id = ? ORDER BY a.id ASC
  `).all(requestId);
}

function getChecklist(requestId) {
  return db.prepare('SELECT * FROM access_request_checklist WHERE request_id = ?').get(requestId);
}

function getAudit(requestId) {
  return db.prepare(`
    SELECT au.*, u.full_name AS user_name
    FROM access_request_audit au
    LEFT JOIN users u ON u.id = au.user_id
    WHERE au.request_id = ? ORDER BY au.id ASC
  `).all(requestId);
}

function getAllSystems() {
  const systems = db.prepare('SELECT * FROM access_systems WHERE active = 1 ORDER BY sort_order, name').all();
  const levels = db.prepare('SELECT * FROM access_system_levels ORDER BY system_id, sort_order').all();
  systems.forEach(s => { s.levels = levels.filter(l => l.system_id === s.id); });
  return systems;
}

// Can this user see this request at all?
function canViewRequest(user, perms, request) {
  if (user.role === 'admin' || perms.can_fulfil_access_requests || perms.can_approve_as_it_manager) return true;
  if (request.created_by === user.id) return true;
  const step = workflow.stepForStatus(request.status);
  if (step && perms[workflow.STEP_PERMISSION[step]]) return true;
  return false;
}

// Emails everyone who holds the given permission (or is an admin) and has an
// email on file. Safe to call even when SMTP isn't configured — sendMail()
// just logs and no-ops in that case.
function notifyApprovers(permKey, request, extra) {
  const users = db.prepare(`
    SELECT u.email, u.full_name FROM users u
    LEFT JOIN permission_groups g ON g.id = u.group_id
    WHERE u.active = 1 AND u.email IS NOT NULL AND u.email != ''
      AND (u.role = 'admin' OR g.${permKey} = 1)
  `).all();
  users.forEach(u => {
    sendMail({
      to: u.email,
      subject: `Access Request ${request.reference_number} awaiting your approval`,
      html: `<p>Hi ${u.full_name},</p>
             <p>Access Request <strong>${request.reference_number}</strong> for
             <strong>${request.employee_full_name}</strong> is now awaiting your approval.</p>
             ${extra || ''}
             <p>Please review it in the OSA system.</p>`,
    });
  });
}

function logAndTouch(requestId, userId, action, details) {
  logAccessRequestAction(requestId, userId, action, details);
  db.prepare(`UPDATE access_requests SET updated_at = datetime('now') WHERE id = ?`).run(requestId);
}

/* ---------- Dashboard ---------- */
router.get('/', (req, res) => {
  const user = req.session.user;
  const perms = getUserPermissions(user);
  const seesAll = user.role === 'admin' || perms.can_fulfil_access_requests || perms.can_approve_as_it_manager;

  const { status, department_id, start_date } = req.query;
  let query = `
    SELECT r.*, d.name AS department_name, u.full_name AS created_by_name
    FROM access_requests r
    LEFT JOIN departments d ON d.id = r.department_id
    LEFT JOIN users u ON u.id = r.created_by
    WHERE 1=1
  `;
  const params = [];
  if (!seesAll) {
    const approverClauses = workflow.APPROVAL_STEPS
      .filter(step => perms[workflow.STEP_PERMISSION[step]])
      .map(step => `r.status = '${workflow.STEP_TO_STATUS[step]}'`);
    query += ` AND (r.created_by = ? ${approverClauses.length ? 'OR ' + approverClauses.join(' OR ') : ''})`;
    params.push(user.id);
  }
  if (status) { query += ' AND r.status = ?'; params.push(status); }
  if (department_id) { query += ' AND r.department_id = ?'; params.push(department_id); }
  if (start_date) { query += ' AND r.start_date = ?'; params.push(start_date); }
  query += ' ORDER BY r.created_at DESC';

  const requests = db.prepare(query).all(...params);

  const allStatuses = [...OPEN_STATUSES, 'Approved', 'In Progress', 'Awaiting User Acknowledgment', ...CLOSED_STATUSES];
  const statusCounts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) c FROM access_requests GROUP BY status').all().map(r => [r.status, r.c])
  );

  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();

  res.render('access-requests/index', {
    title: 'IT Access Requests',
    requests, departments,
    statusCounts, allStatuses,
    filters: { status: status || '', department_id: department_id || '', start_date: start_date || '' },
  });
});

/* ---------- New (HR) ---------- */
router.get('/new', requirePermission('can_submit_access_requests'), (req, res) => {
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.render('access-requests/new', {
    title: 'New Joiner IT Access Request', departments, employmentTypes: EMPLOYMENT_TYPES, error: null,
    values: {
      employee_full_name: '', employee_id: '', job_title: '', department_id: '',
      reporting_manager: '', mobile_number: '', employment_type: 'Permanent',
      contract_end_date: '', start_date: '',
      hw_device_type: '', hw_asset_tag: '', hw_phone_extension_needed: '', hw_phone_extension: '',
      hw_mobile_radio: '', hw_printer_needed: '', hw_printer_location: '', hw_monitor_peripherals: '',
    },
  });
});

router.post('/', requirePermission('can_submit_access_requests'), (req, res) => {
  const user = req.session.user;
  const b = req.body;

  const rerender = (message) => {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    return res.status(400).render('access-requests/new', {
      title: 'New Joiner IT Access Request', departments, employmentTypes: EMPLOYMENT_TYPES, error: message,
      values: b,
    });
  };

  const fullName = (b.employee_full_name || '').trim();
  if (!fullName) return rerender('Employee full name is required.');
  if (!EMPLOYMENT_TYPES.includes(b.employment_type)) return rerender('Please choose a valid employment type.');
  if (!b.start_date) return rerender('Start date is required.');
  if (['Temporary', 'Intern'].includes(b.employment_type) && !b.contract_end_date) {
    return rerender('Contract end date is required for Temporary/Intern employment.');
  }

  const reference = generateReference();
  const isDraft = b.action === 'draft';

  const info = db.prepare(`
    INSERT INTO access_requests (
      reference_number, status, employee_full_name, employee_id, job_title, department_id,
      reporting_manager, mobile_number, employment_type, contract_end_date, start_date,
      hw_device_type, hw_asset_tag, hw_phone_extension_needed, hw_phone_extension,
      hw_mobile_radio, hw_printer_needed, hw_printer_location, hw_monitor_peripherals,
      created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reference, isDraft ? 'Draft' : 'Pending HOD',
    fullName, (b.employee_id || '').trim() || null, (b.job_title || '').trim() || null,
    b.department_id || null, (b.reporting_manager || '').trim() || null, (b.mobile_number || '').trim() || null,
    b.employment_type, b.contract_end_date || null, b.start_date,
    b.hw_device_type || null, (b.hw_asset_tag || '').trim() || null,
    b.hw_phone_extension_needed ? 1 : 0, (b.hw_phone_extension || '').trim() || null,
    b.hw_mobile_radio ? 1 : 0, b.hw_printer_needed ? 1 : 0, (b.hw_printer_location || '').trim() || null,
    (b.hw_monitor_peripherals || '').trim() || null,
    user.id
  );

  const requestId = info.lastInsertRowid;
  logAndTouch(requestId, user.id, isDraft ? 'Created (draft)' : 'Submitted', `Reference ${reference}`);
  if (!isDraft) notifyApprovers('can_approve_as_hod', { ...getRequest(requestId) });

  res.redirect(`/access-requests/${requestId}`);
});

router.post('/:id/submit', (req, res) => {
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not Found', message: 'Access request not found.' });
  if (request.created_by !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Access Denied', message: 'Only the submitter can submit this draft.' });
  }
  if (request.status !== 'Draft') return res.redirect(`/access-requests/${request.id}`);

  db.prepare(`UPDATE access_requests SET status = 'Pending HOD', updated_at = datetime('now') WHERE id = ?`).run(request.id);
  logAndTouch(request.id, req.session.user.id, 'Submitted');
  notifyApprovers('can_approve_as_hod', request);
  res.redirect(`/access-requests/${request.id}`);
});

/* ---------- Detail ---------- */
router.get('/:id', (req, res) => {
  const user = req.session.user;
  const perms = getUserPermissions(user);
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not Found', message: 'Access request not found.' });
  if (!canViewRequest(user, perms, request)) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view this access request.' });
  }

  const items = getItems(request.id);
  const approvals = getApprovals(request.id);
  const checklist = getChecklist(request.id);
  const audit = getAudit(request.id);
  const systems = getAllSystems();

  const currentStep = workflow.stepForStatus(request.status);
  const canDecideNow = currentStep && (user.role === 'admin' || perms[workflow.STEP_PERMISSION[currentStep]]);

  res.render('access-requests/show', {
    title: request.reference_number,
    request, items, approvals, checklist, audit, systems,
    currentStep, canDecideNow,
    canFulfil: user.role === 'admin' || perms.can_fulfil_access_requests,
    canCancel: (request.created_by === user.id || user.role === 'admin') && !CLOSED_STATUSES.includes(request.status),
    isHodStep: currentStep === 'HOD',
  });
});

/* ---------- HOD step: fills Access Required + decides ---------- */
router.post('/:id/hod-decision', (req, res) => {
  const user = req.session.user;
  const perms = getUserPermissions(user);
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not Found', message: 'Access request not found.' });
  if (request.status !== 'Pending HOD') return res.redirect(`/access-requests/${request.id}`);
  if (user.role !== 'admin' && !perms.can_approve_as_hod) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to approve at this step.' });
  }

  const decision = req.body.decision === 'Rejected' ? 'Rejected' : 'Approved';
  const comments = (req.body.comments || '').trim();

  if (decision === 'Approved') {
    // Rebuild the Access Required items from the submitted checkboxes/levels/remarks.
    const systems = getAllSystems();
    db.prepare('DELETE FROM access_request_items WHERE request_id = ?').run(request.id);
    const insertItem = db.prepare(`
      INSERT INTO access_request_items (request_id, system_id, required, level_id, remarks)
      VALUES (?, ?, ?, ?, ?)
    `);
    const itemsForGmCheck = [];
    systems.forEach(sys => {
      const required = req.body[`required_${sys.id}`] ? 1 : 0;
      const levelId = req.body[`level_${sys.id}`] || null;
      const remarks = (req.body[`remarks_${sys.id}`] || '').trim() || null;
      if (required || levelId || remarks) {
        insertItem.run(request.id, sys.id, required, levelId || null, remarks);
      }
      const level = sys.levels.find(l => String(l.id) === String(levelId));
      itemsForGmCheck.push({ required: !!required, isAdminLevel: !!(level && level.is_admin_level), systemGmAlways: !!sys.gm_always });
    });

    const gmRequired = workflow.computeGmRequired(itemsForGmCheck) ? 1 : 0;
    const next = workflow.nextStatus(!!gmRequired, ['HOD']);
    db.prepare('UPDATE access_requests SET gm_required = ?, status = ? WHERE id = ?').run(gmRequired, next, request.id);
    db.prepare(`
      INSERT INTO access_request_approvals (request_id, step, approver_id, decision, comments, decided_at)
      VALUES (?, 'HOD', ?, 'Approved', ?, datetime('now'))
    `).run(request.id, user.id, comments || null);
    logAndTouch(request.id, user.id, 'HOD approved', comments);
    notifyApprovers('can_approve_as_hr', getRequest(request.id));
  } else {
    db.prepare(`
      INSERT INTO access_request_approvals (request_id, step, approver_id, decision, comments, decided_at)
      VALUES (?, 'HOD', ?, 'Rejected', ?, datetime('now'))
    `).run(request.id, user.id, comments || null);
    db.prepare(`UPDATE access_requests SET status = 'Rejected', rejection_reason = ? WHERE id = ?`).run(comments, request.id);
    logAndTouch(request.id, user.id, 'HOD rejected', comments);
  }

  res.redirect(`/access-requests/${request.id}`);
});

/* ---------- HR / IT Manager / GM steps: decide only ---------- */
router.post('/:id/decision', (req, res) => {
  const user = req.session.user;
  const perms = getUserPermissions(user);
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not Found', message: 'Access request not found.' });

  const step = workflow.stepForStatus(request.status);
  if (!step || step === 'HOD') return res.redirect(`/access-requests/${request.id}`);
  if (user.role !== 'admin' && !perms[workflow.STEP_PERMISSION[step]]) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to approve at this step.' });
  }

  const decision = req.body.decision === 'Rejected' ? 'Rejected' : 'Approved';
  const comments = (req.body.comments || '').trim();

  db.prepare(`
    INSERT INTO access_request_approvals (request_id, step, approver_id, decision, comments, decided_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(request.id, step, user.id, decision, comments || null);

  if (decision === 'Approved') {
    const decidedSteps = getApprovals(request.id).filter(a => a.decision === 'Approved').map(a => a.step);
    const next = workflow.nextStatus(!!request.gm_required, decidedSteps);
    db.prepare('UPDATE access_requests SET status = ? WHERE id = ?').run(next, request.id);
    logAndTouch(request.id, user.id, `${step} approved`, comments);
    if (next.startsWith('Pending ')) {
      const nextStep = workflow.stepForStatus(next);
      notifyApprovers(workflow.STEP_PERMISSION[nextStep], getRequest(request.id));
    } else if (next === 'Approved') {
      notifyApprovers('can_fulfil_access_requests', getRequest(request.id));
    }
  } else {
    db.prepare(`UPDATE access_requests SET status = 'Rejected', rejection_reason = ? WHERE id = ?`).run(comments, request.id);
    logAndTouch(request.id, user.id, `${step} rejected`, comments);
  }

  res.redirect(`/access-requests/${request.id}`);
});

/* ---------- IT fulfilment ---------- */
router.post('/:id/start', requirePermission('can_fulfil_access_requests'), (req, res) => {
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not Found', message: 'Access request not found.' });
  if (request.status !== 'Approved') return res.redirect(`/access-requests/${request.id}`);

  db.prepare(`UPDATE access_requests SET status = 'In Progress', updated_at = datetime('now') WHERE id = ?`).run(request.id);
  logAndTouch(request.id, req.session.user.id, 'IT started fulfilment');
  res.redirect(`/access-requests/${request.id}`);
});

router.post('/:id/checklist', requirePermission('can_fulfil_access_requests'), (req, res) => {
  const user = req.session.user;
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not Found', message: 'Access request not found.' });
  if (!['In Progress', 'Approved'].includes(request.status)) return res.redirect(`/access-requests/${request.id}`);

  const b = req.body;
  const existing = getChecklist(request.id);
  const fields = {
    accounts_created: (b.accounts_created || '').trim() || null,
    equipment_issued: b.equipment_issued ? 1 : 0,
    asset_register_updated: b.asset_register_updated ? 1 : 0,
    credentials_handed_over: b.credentials_handed_over ? 1 : 0,
    user_briefed: b.user_briefed ? 1 : 0,
    closing_notes: (b.closing_notes || '').trim() || null,
  };

  if (existing) {
    db.prepare(`
      UPDATE access_request_checklist SET accounts_created = ?, equipment_issued = ?, asset_register_updated = ?,
        credentials_handed_over = ?, user_briefed = ?, closing_notes = ?
      WHERE request_id = ?
    `).run(fields.accounts_created, fields.equipment_issued, fields.asset_register_updated,
      fields.credentials_handed_over, fields.user_briefed, fields.closing_notes, request.id);
  } else {
    db.prepare(`
      INSERT INTO access_request_checklist (request_id, accounts_created, equipment_issued, asset_register_updated,
        credentials_handed_over, user_briefed, closing_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(request.id, fields.accounts_created, fields.equipment_issued, fields.asset_register_updated,
      fields.credentials_handed_over, fields.user_briefed, fields.closing_notes);
  }
  logAndTouch(request.id, user.id, 'IT checklist updated');

  const allDone = fields.equipment_issued && fields.asset_register_updated && fields.credentials_handed_over && fields.user_briefed;
  if (b.action === 'complete' && allDone) {
    db.prepare(`
      UPDATE access_request_checklist SET completed_by = ?, completed_at = datetime('now') WHERE request_id = ?
    `).run(user.id, request.id);
    db.prepare(`UPDATE access_requests SET status = 'Awaiting User Acknowledgment' WHERE id = ?`).run(request.id);
    logAndTouch(request.id, user.id, 'IT completion checklist finished');
  }

  res.redirect(`/access-requests/${request.id}`);
});

router.post('/:id/acknowledge', requirePermission('can_fulfil_access_requests'), (req, res) => {
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not Found', message: 'Access request not found.' });
  if (request.status !== 'Awaiting User Acknowledgment') return res.redirect(`/access-requests/${request.id}`);

  db.prepare(`
    UPDATE access_requests SET ack_confirmed = 1, ack_at = datetime('now'), status = 'Closed' WHERE id = ?
  `).run(request.id);
  logAndTouch(request.id, req.session.user.id, 'User acknowledgment recorded; request closed');
  res.redirect(`/access-requests/${request.id}`);
});

router.post('/:id/cancel', (req, res) => {
  const user = req.session.user;
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not Found', message: 'Access request not found.' });
  if (request.created_by !== user.id && user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Access Denied', message: 'Only the submitter or an admin can cancel this request.' });
  }
  if (CLOSED_STATUSES.includes(request.status)) return res.redirect(`/access-requests/${request.id}`);

  db.prepare(`UPDATE access_requests SET status = 'Cancelled' WHERE id = ?`).run(request.id);
  logAndTouch(request.id, user.id, 'Cancelled', (req.body.reason || '').trim() || null);
  res.redirect(`/access-requests/${request.id}`);
});

/* ---------- Notifications (polling, matching the tickets module pattern) ---------- */
router.get('/api/notifications', (req, res) => {
  const user = req.session.user;
  const perms = getUserPermissions(user);
  // First check after sign-in only records where things stand, so requests that were
  // already there (the bell and tab count show them) do not all pop up at once.
  if (req.session.lastNotifiedAccessRequestId === undefined) {
    req.session.lastNotifiedAccessRequestId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM access_requests').get().m;
    return res.json({ requests: [] });
  }
  const lastId = req.session.lastNotifiedAccessRequestId;

  const seesAll = user.role === 'admin' || perms.can_fulfil_access_requests || perms.can_approve_as_it_manager;
  let rows;
  if (seesAll) {
    rows = db.prepare(`SELECT id, reference_number, employee_full_name, status FROM access_requests WHERE id > ? AND status NOT IN ('Closed', 'Rejected', 'Cancelled') ORDER BY id ASC LIMIT 20`).all(lastId);
  } else {
    const approverClauses = workflow.APPROVAL_STEPS
      .filter(step => perms[workflow.STEP_PERMISSION[step]])
      .map(step => `status = '${workflow.STEP_TO_STATUS[step]}'`);
    if (!approverClauses.length) return res.json({ requests: [] });
    rows = db.prepare(`
      SELECT id, reference_number, employee_full_name, status FROM access_requests
      WHERE id > ? AND status NOT IN ('Closed', 'Rejected', 'Cancelled') AND (${approverClauses.join(' OR ')}) ORDER BY id ASC LIMIT 20
    `).all(lastId);
  }

  // Remember the newest request seen, whatever its status, so a request that was
  // already finished is never announced later.
  req.session.lastNotifiedAccessRequestId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM access_requests').get().m;
  res.json({ requests: rows });
});

/* ---------- PDF export ---------- */
router.get('/:id/pdf', (req, res) => {
  const user = req.session.user;
  const perms = getUserPermissions(user);
  const request = getRequest(req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not Found', message: 'Access request not found.' });
  if (!canViewRequest(user, perms, request)) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view this access request.' });
  }

  // Path form on purpose: pdfkit only declares package "exports", which the .exe packager cannot follow.
  let PDFDocument;
  try { PDFDocument = require('../../node_modules/pdfkit/js/pdfkit.js'); } catch (e) { PDFDocument = require('pdfkit'); }
  const items = getItems(request.id).filter(i => i.required);
  const approvals = getApprovals(request.id);
  const checklist = getChecklist(request.id);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${request.reference_number}.pdf"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  const exportLogo = require('../utils/siteLogo').getExportLogo();
  let headX = 100;
  if (exportLogo) {
    try { doc.image(exportLogo.buffer, 50, 40, { fit: [90, 46] }); headX = 155; } catch (e) { exportLogo.failed = true; }
  }
  if (!exportLogo || exportLogo.failed) {
    doc.rect(50, 45, 40, 40).stroke();
    doc.fontSize(8).text('LOGO', 50, 62, { width: 40, align: 'center' });
  }
  doc.fontSize(18).text('OSA — Operations Service Assistance', headX, 50);
  doc.fontSize(10).fillColor('#666').text('New Joiner IT Access Request', headX, 72);
  doc.fillColor('#000').moveDown(2);

  doc.fontSize(14).text(`Reference: ${request.reference_number}`);
  doc.fontSize(10).fillColor('#666').text(`Status: ${request.status}`).fillColor('#000');
  doc.moveDown();

  doc.fontSize(12).text('Employee Details', { underline: true });
  doc.fontSize(10);
  doc.text(`Full Name: ${request.employee_full_name}`);
  doc.text(`Employee ID: ${request.employee_id || '-'}`);
  doc.text(`Job Title: ${request.job_title || '-'}`);
  doc.text(`Department: ${request.department_name || '-'}`);
  doc.text(`Reporting Manager: ${request.reporting_manager || '-'}`);
  doc.text(`Employment Type: ${request.employment_type}`);
  doc.text(`Start Date: ${request.start_date}`);
  if (request.contract_end_date) doc.text(`Contract End Date: ${request.contract_end_date}`);
  doc.moveDown();

  doc.fontSize(12).text('Access Granted', { underline: true });
  doc.fontSize(10);
  if (items.length === 0) doc.text('No access items recorded.');
  items.forEach(i => {
    doc.text(`• ${i.system_name}${i.level_name ? ' — ' + i.level_name : ''}${i.remarks ? ' (' + i.remarks + ')' : ''}`);
  });
  doc.moveDown();

  doc.fontSize(12).text('Approvals', { underline: true });
  doc.fontSize(10);
  if (approvals.length === 0) doc.text('No approvals recorded yet.');
  approvals.forEach(a => {
    doc.text(`${a.step}: ${a.decision} by ${a.approver_name || '-'} on ${a.decided_at || '-'}${a.comments ? ' — ' + a.comments : ''}`);
  });
  doc.moveDown();

  doc.fontSize(12).text('IT Completion', { underline: true });
  doc.fontSize(10);
  if (checklist) {
    doc.text(`Accounts created: ${checklist.accounts_created || '-'}`);
    doc.text(`Equipment issued: ${checklist.equipment_issued ? 'Yes' : 'No'}`);
    doc.text(`Asset register updated: ${checklist.asset_register_updated ? 'Yes' : 'No'}`);
    doc.text(`Credentials handed over: ${checklist.credentials_handed_over ? 'Yes' : 'No'}`);
    doc.text(`User briefed: ${checklist.user_briefed ? 'Yes' : 'No'}`);
    if (checklist.completed_at) doc.text(`Completed: ${checklist.completed_at}`);
  } else {
    doc.text('Not completed yet.');
  }
  doc.moveDown();
  doc.fontSize(10).fillColor('#666').text(`User acknowledgment: ${request.ack_confirmed ? 'Confirmed on ' + request.ack_at : 'Not yet confirmed'}`);

  doc.end();
});

module.exports = router;
