const { getUserPermissions, hasAdminAreaAccess } = require('../utils/permissions');
const { getLicenseStatus } = require('../utils/license');
const { getPendingAccessRequests } = require('../utils/pendingRequests');
const { listPriorities, priorityMap } = require('../utils/priorities');
const { getTicketBell, getLostFoundBell, getMaintenanceAlerts } = require('../utils/ticketNotifications');
const { getSetting } = require('../utils/appSettings');
const { getStates } = require('../utils/notificationStates');
const db = require('../db');
const { ALL_PERMISSIONS: WORKFLOW_PERMS } = require('../utils/workflowRequestFlow');
const { bellClause } = require('../utils/workflowRequestQueries');

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to view this page.' });
    }
    next();
  };
}

// Allows access if the user is an admin, OR their assigned permission group
// grants the given permission key (see src/utils/permissions.js).
function requirePermission(permKey) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    const perms = getUserPermissions(req.session.user);
    if (perms[permKey]) return next();
    return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to view this page.' });
  };
}

// Allows access if the user has one of the given base roles, OR their permission
// group grants permKey. Used where a group permission should extend an
// existing role-gated action (e.g. letting a requester act like an agent).
function requireRoleOrPermission(roles, permKey) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (roles.includes(req.session.user.role)) return next();
    const perms = getUserPermissions(req.session.user);
    if (perms[permKey]) return next();
    return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to view this page.' });
  };
}

// Makes current user + helpers available in every view
function injectLocals(req, res, next) {
  res.locals.currentUser = req.session.user || null;
  const siteLogo = getSetting('site_logo');
  res.locals.siteLogoUrl = siteLogo ? '/branding/logo?v=' + encodeURIComponent(siteLogo) : null;
  res.locals.path = req.path;
  res.locals.perms = getUserPermissions(req.session.user);
  res.locals.ticketBell = req.session.user ? getTicketBell(req.session.user, res.locals.perms) : { unread: 0, items: [] };
  res.locals.lostFoundBell = req.session.user ? getLostFoundBell(req.session.user, res.locals.perms) : { unread: 0, items: [] };
  res.locals.maintenanceAlertCount = req.session.user ? getMaintenanceAlerts(req.session.user, res.locals.perms).length : 0;
  res.locals.canSeeAdmin = hasAdminAreaAccess(req.session.user, res.locals.perms);
  res.locals.pendingAccessRequests = req.session.user
    ? getPendingAccessRequests(req.session.user, res.locals.perms)
    : [];
  // Workflow requests: tab visibility + bell entries for this user.
  const wfUser = req.session.user;
  res.locals.canSeeWorkflow = !!wfUser && (wfUser.role === 'admin' || WORKFLOW_PERMS.some(k => res.locals.perms[k]));
  res.locals.workflowBell = [];
  if (res.locals.canSeeWorkflow) {
    const bell = bellClause(wfUser, res.locals.perms);
    res.locals.workflowBell = db.prepare(
      `SELECT w.id, w.reference_number, w.title, w.status FROM workflow_requests w WHERE ${bell.sql} ORDER BY w.updated_at DESC LIMIT 15`
    ).all(...bell.params);
  }
  // Priorities (name, colour, order) are admin-configurable, so every view gets
  // the current list rather than assuming Urgent/High/Medium/Low.
  // Things the person archived or deleted no longer count.
  if (req.session.user) {
    const states = getStates(req.session.user.id);
    if (states.size) {
      res.locals.pendingAccessRequests = res.locals.pendingAccessRequests.filter(r => !states.has('a:' + r.id + ':' + r.status));
      res.locals.workflowBell = res.locals.workflowBell.filter(r => !states.has('w:' + r.id + ':' + r.status));
    }
  }
  // How many things need attention on each tab, shown as a small number on the tab icon.
  res.locals.tabCounts = {
    tickets: res.locals.ticketBell.unread,
    lostfound: res.locals.lostFoundBell.unread,
    maintenance: res.locals.maintenanceAlertCount,
    access: res.locals.pendingAccessRequests.length,
    workflow: res.locals.workflowBell.length,
  };
  res.locals.priorities = req.session.user ? listPriorities() : [];
  res.locals.priorityMeta = priorityMap(res.locals.priorities);
  next();
}

// Blocks everyone except admins once the license is missing/invalid/expired.
// Admins are never blocked (so they can always get to Admin → License to
// activate/renew), but they still see the expiry-warning banner below.
// Login/logout must keep working regardless, so this only acts once a
// session user exists, and it exempts the license admin page itself.
const LICENSE_EXEMPT_PATHS = ['/admin/license', '/login', '/logout', '/account/password'];
function licenseGate(req, res, next) {
  const user = req.session.user;
  if (!user || user.role === 'admin') return next();
  if (LICENSE_EXEMPT_PATHS.includes(req.path)) return next();

  const status = getLicenseStatus();
  if (!status.activated || status.expired || !status.valid) {
    return res.status(403).render('license-expired', { title: 'System Unavailable', status });
  }
  next();
}

// Shows the expiry-warning popup once per login (not once per page load),
// starting 30 days out, to every signed-in user including admins.
function licenseWarning(req, res, next) {
  if (!req.session.user) return next();
  if (req.session.licenseWarningShown) return next();

  const status = getLicenseStatus();
  if (!(status.activated && status.valid && !status.expired && status.daysRemaining <= 30)) {
    req.session.licenseWarningShown = true; // nothing to warn about for this sign-in
    return next();
  }

  // Offer the popup, and only count it as shown once a real page has been rendered with it.
  // (Right after signing in the browser is first redirected "/" -> "/home"; marking it shown
  // on that redirect would swallow the popup.)
  res.locals.licenseWarning = status;
  const render = res.render.bind(res);
  res.render = (view, ...args) => {
    if (!/login/i.test(String(view))) req.session.licenseWarningShown = true;
    return render(view, ...args);
  };
  next();
}

module.exports = { requireLogin, requireRole, requirePermission, requireRoleOrPermission, injectLocals, licenseGate, licenseWarning };
