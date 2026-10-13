const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const { requireLogin, requireRole, requirePermission, requireRoleOrPermission } = require('../middleware/auth');
const { upload, uploadsDir } = require('../middleware/upload');
const { generateSerial } = require('../utils/serial');
const { logDeletion } = require('../utils/auditLog');

const router = express.Router();
router.use(requireLogin);

const STATUSES = ['In Storage', 'Returned to Guest', 'Disposed'];
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

function saveAttachments(files, itemId, commentId, userId) {
  if (!files || !files.length) return;
  const insert = db.prepare(`
    INSERT INTO lost_found_attachments (item_id, comment_id, filename, original_name, uploaded_by)
    VALUES (?, ?, ?, ?, ?)
  `);
  files.forEach(f => insert.run(itemId, commentId, f.filename, f.originalname || null, userId));
}

function deleteItemFiles(itemId) {
  const rows = db.prepare('SELECT filename FROM lost_found_attachments WHERE item_id = ?').all(itemId);
  rows.forEach(a => fs.unlink(path.join(uploadsDir, a.filename), () => {}));
}

function toIso(sqliteDate) {
  if (!sqliteDate) return null;
  return new Date(sqliteDate.replace(' ', 'T') + 'Z').toISOString();
}

// List / search
router.get('/', (req, res) => {
  const { status, q } = req.query;

  let query = `
    SELECT lf.*, u.full_name AS logged_by_name FROM lost_found_items lf
    LEFT JOIN users u ON u.id = lf.created_by
    WHERE 1=1
  `;
  const params = [];
  if (status) { query += ' AND lf.status = ?'; params.push(status); }
  if (q) {
    query += ' AND (lf.item_description LIKE ? OR lf.location LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  query += ' ORDER BY lf.created_at DESC';
  const items = db.prepare(query).all(...params);

  const statusCounts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) c FROM lost_found_items GROUP BY status').all().map(r => [r.status, r.c])
  );
  const stats = {
    total: db.prepare('SELECT COUNT(*) c FROM lost_found_items').get().c,
    byStatus: STATUSES.map(s => ({ status: s, count: statusCounts[s] || 0 })),
  };

  res.render('lostfound/index', {
    title: 'Lost & Found',
    items, statuses: STATUSES, stats,
    filters: { status: status || '', q: q || '' },
  });
});

router.get('/new', (req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY number').all();
  res.render('lostfound/new', {
    title: 'Report Found Item', rooms, error: null,
    values: {
      item_description: '', location: '',
      found_by_name: req.session.user.full_name,
      found_at: '', description: '',
    },
  });
});

router.post('/', handleUpload, (req, res) => {
  const user = req.session.user;
  const { item_description, location, found_by_name, found_at, description } = req.body;

  const rerenderWithError = (message) => {
    const rooms = db.prepare('SELECT * FROM rooms ORDER BY number').all();
    return res.status(400).render('lostfound/new', {
      title: 'Report Found Item', rooms, error: message,
      values: { item_description, location, found_by_name, found_at, description },
    });
  };

  if (!item_description || !item_description.trim()) return rerenderWithError('Item description is required.');
  if (req.uploadError) return rerenderWithError(req.uploadError);

  const foundAtValue = found_at ? found_at.replace('T', ' ') : null;
  const serialNumber = generateSerial('L', 'lost_found_items', 'serial_number');

  const info = db.prepare(`
    INSERT INTO lost_found_items (serial_number, item_description, location, found_by_name, found_at, description, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    serialNumber,
    item_description.trim(),
    (location || '').trim(),
    (found_by_name || '').trim(),
    foundAtValue,
    (description || '').trim(),
    user.id
  );

  saveAttachments(req.files, info.lastInsertRowid, null, user.id);

  res.redirect(`/lost-found/${info.lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const item = db.prepare(`
    SELECT lf.*, u.full_name AS logged_by_name FROM lost_found_items lf
    LEFT JOIN users u ON u.id = lf.created_by
    WHERE lf.id = ?
  `).get(req.params.id);

  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Item not found.' });

  const comments = db.prepare(`
    SELECT c.*, u.full_name AS author_name FROM lost_found_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.item_id = ? ORDER BY c.created_at ASC
  `).all(item.id);

  const allAttachments = db.prepare('SELECT * FROM lost_found_attachments WHERE item_id = ? ORDER BY created_at ASC').all(item.id);
  const itemPhotos = allAttachments.filter(a => !a.comment_id);
  const attachmentsByComment = {};
  allAttachments.filter(a => a.comment_id).forEach(a => {
    (attachmentsByComment[a.comment_id] = attachmentsByComment[a.comment_id] || []).push(a);
  });

  res.render('lostfound/show', {
    title: item.item_description,
    item, comments, itemPhotos, attachmentsByComment, statuses: STATUSES,
    createdAtIso: toIso(item.created_at),
  });
});

router.post('/:id/comments', handleUpload, (req, res) => {
  const item = db.prepare('SELECT * FROM lost_found_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Item not found.' });

  const user = req.session.user;
  const body = (req.body.body || '').trim();
  const hasPhotos = req.files && req.files.length;

  if (body || hasPhotos) {
    const info = db.prepare('INSERT INTO lost_found_comments (item_id, user_id, body) VALUES (?, ?, ?)')
      .run(item.id, user.id, body || '(photo attached)');
    saveAttachments(req.files, item.id, info.lastInsertRowid, user.id);
    db.prepare(`UPDATE lost_found_items SET updated_at = datetime('now') WHERE id = ?`).run(item.id);
  }
  res.redirect(`/lost-found/${item.id}`);
});

// Update status / guest contact info — agents & admins only
router.post('/:id/update', requireRoleOrPermission(['admin', 'agent'], 'can_manage_lost_found'), (req, res) => {
  const item = db.prepare('SELECT * FROM lost_found_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Item not found.' });

  const { status, guest_contacted, contact_notes } = req.body;
  const user = req.session.user;
  const notes = [];
  const fields = [];
  const params = [];

  if (status && STATUSES.includes(status) && status !== item.status) {
    fields.push('status = ?'); params.push(status);
    notes.push(`Status changed from "${item.status}" to "${status}"`);
  }

  const newContacted = guest_contacted ? 1 : 0;
  if (newContacted !== item.guest_contacted) {
    fields.push('guest_contacted = ?'); params.push(newContacted);
    notes.push(newContacted ? 'Marked guest as contacted' : 'Marked guest as not yet contacted');
  }

  const newNotes = (contact_notes || '').trim();
  if (newNotes !== (item.contact_notes || '')) {
    fields.push('contact_notes = ?'); params.push(newNotes);
  }

  if (fields.length) {
    fields.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE lost_found_items SET ${fields.join(', ')} WHERE id = ?`).run(...params, item.id);
    if (notes.length) {
      db.prepare('INSERT INTO lost_found_comments (item_id, user_id, body, is_system) VALUES (?, ?, ?, 1)')
        .run(item.id, user.id, notes.join('; '));
    }
  }

  res.redirect(`/lost-found/${item.id}`);
});

router.post('/:id/delete', requirePermission('can_edit_delete_lost_found'), (req, res) => {
  const item = db.prepare('SELECT * FROM lost_found_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Item not found.' });

  logDeletion('Lost & Found Item', `${item.serial_number} — ${item.item_description}`, req.session.user.id, req.body.reason);
  deleteItemFiles(item.id);
  db.prepare('DELETE FROM lost_found_items WHERE id = ?').run(item.id);

  res.redirect('/lost-found');
});

module.exports = router;
