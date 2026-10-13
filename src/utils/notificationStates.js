// Per-person "archived" / "deleted" marks on notifications. Notifications themselves are
// derived from tickets, requests and so on, so a mark is kept against a stable key.
const db = require('../db');

function getStates(userId) {
  const map = new Map();
  db.prepare('SELECT item_key, state FROM notification_states WHERE user_id = ?').all(userId)
    .forEach(r => map.set(r.item_key, r.state));
  return map;
}

// state: 'archived' | 'deleted' | null (restore)
function setStates(userId, keys, state) {
  const clean = [...new Set(keys.map(String))].filter(k => k && k.length <= 200).slice(0, 500);
  if (!clean.length) return 0;
  db.transaction(() => {
    if (state === null) {
      const del = db.prepare('DELETE FROM notification_states WHERE user_id = ? AND item_key = ?');
      clean.forEach(k => del.run(userId, k));
    } else {
      const up = db.prepare(`
        INSERT INTO notification_states (user_id, item_key, state) VALUES (?, ?, ?)
        ON CONFLICT(user_id, item_key) DO UPDATE SET state = excluded.state, updated_at = datetime('now')
      `);
      clean.forEach(k => up.run(userId, k, state));
    }
  })();
  return clean.length;
}

module.exports = { getStates, setStates };
