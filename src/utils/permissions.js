const db = require('../db');

// The full set of grantable permissions. Each maps to a boolean column on
// permission_groups. Admins implicitly have every permission; other users only
// get what their assigned group grants them, on top of their base role.
const PERMISSIONS = [
  // Tickets
  { key: 'can_submit_tickets', section: 'tickets', label: 'Create tickets', description: 'Report a problem. People with no group can always do this.' },
  { key: 'can_view_department_tickets', section: 'tickets', label: 'See department tickets', description: 'See and comment on tickets from, or for, their own department.' },
  { key: 'can_view_all_staff', section: 'tickets', label: 'See staff of every department', description: 'The Staff Name list on a ticket shows all staff, not just their own department.' },
  { key: 'can_manage_tickets', section: 'tickets', label: 'Handle tickets', description: 'Change the status, priority and who a ticket is assigned to.' },
  { key: 'can_edit_tickets', section: 'tickets', label: 'Edit tickets', description: "Change a ticket's subject, type, department, room and description." },
  { key: 'can_delete_tickets', section: 'tickets', label: 'Delete tickets', description: 'Permanently remove a ticket.' },
  // Lost & Found
  { key: 'can_manage_lost_found', section: 'lostfound', label: 'Update items', description: 'Change the status and guest-contact notes.' },
  { key: 'can_edit_delete_lost_found', section: 'lostfound', label: 'Delete items', description: 'Remove a lost & found item.' },
  // Maintenance
  { key: 'can_manage_maintenance', section: 'maintenance', label: 'Add tasks and mark them done', description: 'Create maintenance tasks and complete them.' },
  { key: 'can_edit_maintenance', section: 'maintenance', label: 'Edit tasks', description: "Change a task's details and schedule." },
  { key: 'can_delete_maintenance', section: 'maintenance', label: 'Delete tasks', description: 'Permanently remove a task.' },
  // IT Access Requests
  { key: 'can_submit_access_requests', section: 'access', label: 'Create requests (HR)', description: 'Start a new joiner IT access request.' },
  { key: 'can_approve_as_hod', section: 'access', label: 'Approve as Head of Department', description: 'Choose the systems needed, then approve or reject.' },
  { key: 'can_approve_as_hr', section: 'access', label: 'Approve as HR Manager', description: 'Approve or reject at the HR step.' },
  { key: 'can_approve_as_it_manager', section: 'access', label: 'Approve as IT Manager', description: 'Approve or reject at the IT Manager step.' },
  { key: 'can_approve_as_gm', section: 'access', label: 'Approve as General Manager', description: 'Approve or reject requests for VPN, Finance or admin-level access.' },
  { key: 'can_fulfil_access_requests', section: 'access', label: 'Do the IT work', description: 'Complete the checklist and close approved requests.' },
  { key: 'can_manage_access_systems', section: 'access', label: 'Edit the systems list', description: 'Add or remove the systems people can request access to.' },
  // Workflow Requests
  { key: 'can_submit_workflow_requests', section: 'workflow', label: 'Create requests (HR)', description: 'Start a request and resubmit one that was returned.' },
  { key: 'can_review_workflow_as_hod', section: 'workflow', label: 'Review as Head of Department', description: 'Add input and any cost for their department, then approve or return.' },
  { key: 'can_approve_workflow_as_finance', section: 'workflow', label: 'Approve costs (Finance)', description: 'Approve or return requests that have a cost.' },
  { key: 'can_fulfil_workflow_requests', section: 'workflow', label: 'Do the work (IT)', description: 'Start and complete approved requests.' },
  // Reports
  { key: 'can_view_reports', section: 'reports', label: 'See reports', description: 'Open the Reports page. Shows only their own department unless the next box is ticked.' },
  { key: 'can_view_all_department_reports', section: 'reports', label: 'See every department', description: 'Reports and Deleted Items cover all departments, not just their own.' },
  // Administration
  { key: 'can_manage_settings', section: 'admin', label: 'Manage settings', description: 'Departments, staff, request types, rooms and priorities.' },
  { key: 'can_manage_users', section: 'admin', label: 'Manage users', description: 'Add, edit and delete users and reset passwords.' },
];

// Display order and wording of the sections on the Permission Groups page.
const PERMISSION_SECTIONS = [
  { key: 'tickets', title: 'Tickets', icon: 'bi-ticket-perforated', color: '#0d6efd' },
  { key: 'lostfound', title: 'Lost & Found', icon: 'bi-binoculars', color: '#198754' },
  { key: 'maintenance', title: 'Maintenance', icon: 'bi-tools', color: '#6f42c1' },
  { key: 'access', title: 'IT Access Requests', icon: 'bi-person-badge', color: '#fd7e14' },
  { key: 'workflow', title: 'Workflow Requests', icon: 'bi-signpost-split', color: '#0dcaf0' },
  { key: 'reports', title: 'Reports', icon: 'bi-bar-chart-line', color: '#dc3545' },
  { key: 'admin', title: 'Administration', icon: 'bi-gear', color: '#343a40' },
];

const EMPTY_PERMS = Object.fromEntries(PERMISSIONS.map(p => [p.key, false]));

// Computes what a signed-in user is actually allowed to do: admins get
// everything; everyone else gets whatever their assigned group grants.
function getUserPermissions(user) {
  const perms = { ...EMPTY_PERMS };
  if (!user) return perms;
  if (user.role === 'admin') {
    Object.keys(perms).forEach(k => { perms[k] = true; });
    return perms;
  }
  if (user.group_id) {
    const group = db.prepare('SELECT * FROM permission_groups WHERE id = ?').get(user.group_id);
    if (group) {
      Object.keys(perms).forEach(k => { if (group[k]) perms[k] = true; });
    }
  }
  return perms;
}

// The Admin tab (and its dashboard) is only for people who hold an administration
// permission. Having just report access shows the Reports tab, not Admin.
const ADMIN_AREA_PERMISSIONS = ['can_manage_settings', 'can_manage_users', 'can_manage_access_systems'];

function hasAdminAreaAccess(user, perms) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return ADMIN_AREA_PERMISSIONS.some(k => perms[k]);
}

module.exports = { hasAdminAreaAccess, ADMIN_AREA_PERMISSIONS, PERMISSIONS, PERMISSION_SECTIONS, getUserPermissions };
