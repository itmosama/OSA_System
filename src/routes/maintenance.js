const express = require('express');
const db = require('../db');
const { requireLogin, requirePermission } = require('../middleware/auth');
const { generateSerial } = require('../utils/serial');
const { logDeletion } = require('../utils/auditLog');

const router = express.Router();
router.use(requireLogin);

const FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Semi-Annually', 'Annually'];

function addInterval(dateStr, frequency) {
  const d = new Date(dateStr + 'T00:00:00');
  switch (frequency) {
    case 'Daily': d.setDate(d.getDate() + 1); break;
    case 'Weekly': d.setDate(d.getDate() + 7); break;
    case 'Monthly': d.setMonth(d.getMonth() + 1); break;
    case 'Quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'Semi-Annually': d.setMonth(d.getMonth() + 6); break;
    case 'Annually': d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

function attachOverdue(task) {
  const today = new Date().toISOString().slice(0, 10);
  task.isOverdue = task.status !== 'Completed' && task.next_due_date < today;
  task.isDueSoon = !task.isOverdue && task.status !== 'Completed'
    && task.next_due_date <= addInterval(today, 'Weekly');
  return task;
}

/* ---------- List ---------- */
router.get('/', (req, res) => {
  const { status, department_id, frequency, q } = req.query;

  let query = `
    SELECT t.*, d.name AS department_name, u.full_name AS assigned_to_name, cu.full_name AS created_by_name
    FROM maintenance_tasks t
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN users u ON u.id = t.assigned_to
    LEFT JOIN users cu ON cu.id = t.created_by
    WHERE 1=1
  `;
  const params = [];
  if (status) { query += ' AND t.status = ?'; params.push(status); }
  if (department_id) { query += ' AND t.department_id = ?'; params.push(department_id); }
  if (frequency) { query += ' AND t.frequency = ?'; params.push(frequency); }
  if (q) { query += ' AND (t.equipment_area LIKE ? OR t.task_description LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  query += ' ORDER BY t.next_due_date ASC';

  const tasks = db.prepare(query).all(...params).map(attachOverdue);

  const allTasks = db.prepare('SELECT status, next_due_date FROM maintenance_tasks').all().map(attachOverdue);
  const stats = {
    total: allTasks.length,
    overdue: allTasks.filter(t => t.isOverdue).length,
    dueSoon: allTasks.filter(t => t.isDueSoon).length,
    completed: allTasks.filter(t => t.status === 'Completed').length,
  };

  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();

  res.render('maintenance/index', {
    title: 'Preventive Maintenance',
    tasks, departments, frequencies: FREQUENCIES, stats,
    filters: { status: status || '', department_id: department_id || '', frequency: frequency || '', q: q || '' },
  });
});

/* ---------- New ---------- */
router.get('/new', requirePermission('can_manage_maintenance'), (req, res) => {
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('maintenance/new', {
    title: 'New Maintenance Task', departments, users, frequencies: FREQUENCIES, error: null,
    values: {
      equipment_area: '', task_description: '', frequency: 'Monthly',
      department_id: '', assigned_to: '', next_due_date: '', notes: '',
    },
  });
});

router.post('/', requirePermission('can_manage_maintenance'), (req, res) => {
  const user = req.session.user;
  const b = req.body;

  const rerender = (message) => {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
    return res.status(400).render('maintenance/new', {
      title: 'New Maintenance Task', departments, users, frequencies: FREQUENCIES, error: message, values: b,
    });
  };

  if (!b.equipment_area || !b.equipment_area.trim()) return rerender('Equipment / area is required.');
  if (!b.task_description || !b.task_description.trim()) return rerender('Task description is required.');
  if (!FREQUENCIES.includes(b.frequency)) return rerender('Please choose a valid frequency.');
  if (!b.next_due_date) return rerender('Next due date is required.');

  const taskNumber = generateSerial('M', 'maintenance_tasks', 'task_number');

  const info = db.prepare(`
    INSERT INTO maintenance_tasks (task_number, equipment_area, task_description, frequency, department_id, assigned_to, next_due_date, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskNumber, b.equipment_area.trim(), b.task_description.trim(), b.frequency,
    b.department_id || null, b.assigned_to || null, b.next_due_date, (b.notes || '').trim() || null,
    user.id
  );

  res.redirect(`/maintenance/${info.lastInsertRowid}`);
});

/* ---------- Detail ---------- */
router.get('/:id', (req, res) => {
  const task = db.prepare(`
    SELECT t.*, d.name AS department_name, u.full_name AS assigned_to_name, cu.full_name AS created_by_name
    FROM maintenance_tasks t
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN users u ON u.id = t.assigned_to
    LEFT JOIN users cu ON cu.id = t.created_by
    WHERE t.id = ?
  `).get(req.params.id);
  if (!task) return res.status(404).render('error', { title: 'Not Found', message: 'Maintenance task not found.' });
  attachOverdue(task);

  const comments = db.prepare(`
    SELECT c.*, u.full_name AS author_name FROM maintenance_task_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ? ORDER BY c.created_at ASC
  `).all(task.id);

  res.render('maintenance/show', { title: task.task_number, task, comments });
});

router.post('/:id/comments', (req, res) => {
  const task = db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { title: 'Not Found', message: 'Maintenance task not found.' });

  const body = (req.body.body || '').trim();
  if (body) {
    db.prepare('INSERT INTO maintenance_task_comments (task_id, user_id, body) VALUES (?, ?, ?)')
      .run(task.id, req.session.user.id, body);
    db.prepare(`UPDATE maintenance_tasks SET updated_at = datetime('now') WHERE id = ?`).run(task.id);
  }
  res.redirect(`/maintenance/${task.id}`);
});

// Mark complete — recurs automatically by advancing next_due_date by one frequency interval.
router.post('/:id/complete', requirePermission('can_manage_maintenance'), (req, res) => {
  const user = req.session.user;
  const task = db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { title: 'Not Found', message: 'Maintenance task not found.' });

  const today = new Date().toISOString().slice(0, 10);
  const nextDue = addInterval(today, task.frequency);

  db.prepare(`
    UPDATE maintenance_tasks SET status = 'Scheduled', last_completed_date = ?, next_due_date = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(today, nextDue, task.id);

  const note = (req.body.note || '').trim();
  db.prepare('INSERT INTO maintenance_task_comments (task_id, user_id, body, is_system) VALUES (?, ?, ?, 1)')
    .run(task.id, user.id, `Completed on ${today}; next due ${nextDue}.${note ? ' Note: ' + note : ''}`);

  res.redirect(`/maintenance/${task.id}`);
});

/* ---------- Edit ---------- */
router.get('/:id/edit', requirePermission('can_edit_maintenance'), (req, res) => {
  const task = db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { title: 'Not Found', message: 'Maintenance task not found.' });

  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('maintenance/edit', {
    title: `Edit ${task.task_number}`, task, departments, users, frequencies: FREQUENCIES, error: null,
  });
});

router.post('/:id/edit', requirePermission('can_edit_maintenance'), (req, res) => {
  const task = db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { title: 'Not Found', message: 'Maintenance task not found.' });

  const b = req.body;
  const rerender = (message) => {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
    return res.status(400).render('maintenance/edit', {
      title: `Edit ${task.task_number}`, task: { ...task, ...b }, departments, users, frequencies: FREQUENCIES, error: message,
    });
  };

  if (!b.equipment_area || !b.equipment_area.trim()) return rerender('Equipment / area is required.');
  if (!b.task_description || !b.task_description.trim()) return rerender('Task description is required.');
  if (!FREQUENCIES.includes(b.frequency)) return rerender('Please choose a valid frequency.');
  if (!b.next_due_date) return rerender('Next due date is required.');

  db.prepare(`
    UPDATE maintenance_tasks SET equipment_area = ?, task_description = ?, frequency = ?, department_id = ?,
      assigned_to = ?, next_due_date = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    b.equipment_area.trim(), b.task_description.trim(), b.frequency, b.department_id || null,
    b.assigned_to || null, b.next_due_date, (b.notes || '').trim() || null, task.id
  );

  res.redirect(`/maintenance/${task.id}`);
});

router.post('/:id/delete', requirePermission('can_delete_maintenance'), (req, res) => {
  const task = db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { title: 'Not Found', message: 'Maintenance task not found.' });

  logDeletion('Maintenance Task', `${task.task_number} — ${task.equipment_area}`, req.session.user.id, req.body.reason);
  db.prepare('DELETE FROM maintenance_tasks WHERE id = ?').run(task.id);

  res.redirect('/maintenance');
});

module.exports = router;
