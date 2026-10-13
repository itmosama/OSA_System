const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { getTicketBell, getLostFoundBell, getMaintenanceAlerts, markTicketBellRead } = require('../utils/ticketNotifications');
const { getPendingAccessRequests } = require('../utils/pendingRequests');
const { bellClause } = require('../utils/workflowRequestQueries');
const { ALL_PERMISSIONS: WORKFLOW_PERMS } = require('../utils/workflowRequestFlow');
const { getStates, setStates } = require('../utils/notificationStates');

const router = express.Router();
router.use(requireLogin);

const WINDOW_DAYS = 30;
const PER_GROUP = 100;

// One page with every kind of notification, grouped by area.
router.get('/', (req, res) => {
  const user = req.session.user;
  const perms = res.locals.perms;
  const states = getStates(user.id);
  const stateOf = (key) => states.get(key) || null;

  const tickets = getTicketBell(user, perms, { limit: PER_GROUP, days: WINDOW_DAYS, includeArchived: true });
  const lostFound = getLostFoundBell(user, perms, { limit: PER_GROUP, days: WINDOW_DAYS, includeArchived: true });
  const maintenance = getMaintenanceAlerts(user, perms, { includeArchived: true });
  const access = getPendingAccessRequests(user, perms)
    .map(r => ({ ...r, key: `a:${r.id}:${r.status}` })).filter(r => stateOf(r.key) !== 'deleted');

  let workflow = [];
  if (user.role === 'admin' || WORKFLOW_PERMS.some(k => perms[k])) {
    const bell = bellClause(user, perms);
    workflow = db.prepare(
      `SELECT w.id, w.reference_number, w.title, w.status, w.updated_at FROM workflow_requests w WHERE ${bell.sql} ORDER BY w.updated_at DESC LIMIT ?`
    ).all(...bell.params, PER_GROUP)
      .map(r => ({ ...r, key: `w:${r.id}:${r.status}` })).filter(r => stateOf(r.key) !== 'deleted');
  }

  const groups = [
    {
      key: 'tickets', title: 'Tickets', icon: 'bi-ticket-perforated', color: '#0d6efd', markable: true,
      empty: 'No ticket news in the last 30 days.',
      items: tickets.items.map(n => ({
        key: n.key, archived: n.archived, href: '/tickets/' + n.ticketId, variant: n.kind === 'new' ? 'success' : 'info',
        title: `${n.ticketNumber} — ${n.subject}`,
        text: n.kind === 'new' ? `New ticket from ${n.actor}` : `${n.actor}: ${n.text}`,
        at: n.at, unread: n.unread,
      })),
    },
    {
      key: 'lostfound', title: 'Lost & Found', icon: 'bi-binoculars', color: '#198754', markable: true,
      empty: 'No lost & found news in the last 30 days.',
      items: lostFound.items.map(n => ({
        key: n.key, archived: n.archived, href: '/lost-found/' + n.itemId, variant: n.kind === 'new' ? 'success' : 'info',
        title: `${n.serial} — ${n.name}`,
        text: n.kind === 'new' ? `New item from ${n.actor}` : `${n.actor}: ${n.text}`,
        at: n.at, unread: n.unread,
      })),
    },
    {
      key: 'access', title: 'IT Access Requests', icon: 'bi-person-badge', color: '#fd7e14', markable: false,
      empty: 'No access requests are waiting for you.',
      items: access.map(r => ({
        key: r.key, archived: stateOf(r.key) === 'archived', href: '/access-requests/' + r.id, variant: 'warning',
        title: `${r.reference_number} — ${r.employee_full_name}`, text: r.status, at: null, unread: true,
      })),
    },
    {
      key: 'workflow', title: 'Workflow Requests', icon: 'bi-signpost-split', color: '#0dcaf0', markable: false,
      empty: 'No workflow requests are waiting for you.',
      items: workflow.map(r => ({
        key: r.key, archived: stateOf(r.key) === 'archived', href: '/workflow-requests/' + r.id, variant: 'warning',
        title: `${r.reference_number} — ${r.title}`, text: r.status, at: r.updated_at, unread: true,
      })),
    },
    {
      key: 'maintenance', title: 'Maintenance', icon: 'bi-tools', color: '#6f42c1', markable: false,
      empty: 'No maintenance tasks are overdue or due this week.',
      items: maintenance.map(m => ({
        key: m.key, archived: m.archived, href: '/maintenance/' + m.id, variant: m.overdue ? 'error' : 'warning',
        title: `${m.number || ''} — ${m.name}`.replace(/^ — /, ''),
        text: m.overdue ? `Overdue by ${Math.abs(m.daysLeft)} day${Math.abs(m.daysLeft) === 1 ? '' : 's'}` : (m.daysLeft === 0 ? 'Due today' : `Due in ${m.daysLeft} day${m.daysLeft === 1 ? '' : 's'}`),
        at: m.dueDate, unread: true,
      })),
    },
  ];

  // Archived items leave their group and collect in the "Archived" view.
  const archivedItems = [];
  groups.forEach(g => {
    g.items.filter(i => i.archived).forEach(i => archivedItems.push({ ...i, groupTitle: g.title, groupIcon: g.icon }));
    g.items = g.items.filter(i => !i.archived);
    g.unread = g.items.filter(i => i.unread).length;
  });

  const only = req.query.group === 'archived' ? 'archived' : (groups.some(g => g.key === req.query.group) ? req.query.group : '');
  res.render('notifications/index', {
    title: 'Notifications',
    groups,
    archivedItems,
    only,
    totalUnread: groups.reduce((n, g) => n + g.unread, 0),
    windowDays: WINDOW_DAYS,
  });
});

// Clears the unread marks (tickets and lost & found share one "seen" time).
router.post('/read', (req, res) => {
  markTicketBellRead(req.session.user.id);
  const back = req.get('referer');
  res.redirect(back && back.startsWith(req.protocol + '://' + req.get('host')) ? back : '/notifications');
});

// Archive, delete or restore one or many notifications.
router.post('/state', (req, res) => {
  const keys = [].concat(req.body.keys || []);
  const action = String(req.body.action || '');
  const map = { archive: 'archived', delete: 'deleted', restore: null };
  let changed = 0;
  if (Object.prototype.hasOwnProperty.call(map, action)) changed = setStates(req.session.user.id, keys, map[action]);
  if (req.is('application/json') || (req.get('accept') || '').includes('application/json')) return res.json({ ok: true, changed });
  const back = req.get('referer');
  res.redirect(back && back.startsWith(req.protocol + '://' + req.get('host')) ? back : '/notifications');
});

module.exports = router;
