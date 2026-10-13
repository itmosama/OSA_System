const db = require('../db');
const workflow = require('./accessRequestWorkflow');

// Every open (non-closed) access request "related to" this user — either
// they submitted it, or it's currently awaiting a decision at a step they
// can approve. Used to power the notification bell dropdown in the navbar,
// as a persistent list (unlike the toast popups, which only fire once and
// can be missed/dismissed).
function getPendingAccessRequests(user, perms) {
  if (!user) return [];

  const seesAll = user.role === 'admin' || perms.can_fulfil_access_requests || perms.can_approve_as_it_manager;
  const params = [];
  let query = `
    SELECT id, reference_number, employee_full_name, status
    FROM access_requests
    WHERE status NOT IN ('Closed', 'Rejected', 'Cancelled')
  `;

  if (!seesAll) {
    const approverClauses = workflow.APPROVAL_STEPS
      .filter(step => perms[workflow.STEP_PERMISSION[step]])
      .map(step => `status = '${workflow.STEP_TO_STATUS[step]}'`);
    query += ` AND (created_by = ? ${approverClauses.length ? 'OR ' + approverClauses.join(' OR ') : ''})`;
    params.push(user.id);
  }

  query += ' ORDER BY updated_at DESC LIMIT 20';
  return db.prepare(query).all(...params);
}

module.exports = { getPendingAccessRequests };
