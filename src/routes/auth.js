const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/login', (req, res) => {
  // Sent here by the idle timer: make sure the session is really gone, then explain.
  if (req.query.timeout === '1') {
    const show = () => res.render('auth/login', { title: 'Sign In', error: null, notice: 'You were signed out after 15 minutes of inactivity. Please sign in again.' });
    return req.session.user ? req.session.destroy(show) : show();
  }
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { title: 'Sign In', error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());

  if (!user || !user.active) {
    return res.status(401).render('auth/login', { title: 'Sign In', error: 'Invalid username or password.' });
  }

  const ok = bcrypt.compareSync(password || '', user.password_hash);
  if (!ok) {
    return res.status(401).render('auth/login', { title: 'Sign In', error: 'Invalid username or password.' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    department_id: user.department_id,
    group_id: user.group_id,
  };

  // Only notify about tickets created after this login, not the whole backlog
  const latest = db.prepare('SELECT MAX(id) AS maxId FROM tickets').get();
  req.session.lastNotifiedTicketId = latest.maxId || 0;

  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/account/password', requireLogin, (req, res) => {
  res.render('auth/change-password', { title: 'Change Password', error: null, success: null });
});

router.post('/account/password', requireLogin, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const userId = req.session.user.id;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  const rerender = (message) => res.status(400).render('auth/change-password', {
    title: 'Change Password', error: message, success: null,
  });

  if (!user || !bcrypt.compareSync(current_password || '', user.password_hash)) {
    return rerender('Your current password is incorrect.');
  }
  if (!new_password || new_password.length < 6) {
    return rerender('New password must be at least 6 characters.');
  }
  if (new_password !== confirm_password) {
    return rerender('New password and confirmation do not match.');
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);

  res.render('auth/change-password', { title: 'Change Password', error: null, success: 'Password changed successfully.' });
});

module.exports = router;
