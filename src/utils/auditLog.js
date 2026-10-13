const db = require('../db');

// Records who deleted what, when, and why — shown on the Admin → Deleted Items page.
function logDeletion(itemType, itemLabel, userId, reason) {
  const cleanReason = (reason || '').trim() || '(no reason provided)';
  db.prepare(`
    INSERT INTO deletion_log (item_type, item_label, reason, deleted_by)
    VALUES (?, ?, ?, ?)
  `).run(itemType, itemLabel, cleanReason, userId);
}

// Records a field/status change on an access request — who did what, when.
// Used by the Access Requests module's timeline (broader than logDeletion,
// which only covers deletes).
function logAccessRequestAction(requestId, userId, action, details) {
  db.prepare(`
    INSERT INTO access_request_audit (request_id, user_id, action, details)
    VALUES (?, ?, ?, ?)
  `).run(requestId, userId, action, details || null);
}

module.exports = { logDeletion, logAccessRequestAction };
