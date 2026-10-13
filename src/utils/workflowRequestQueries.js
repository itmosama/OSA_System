// SQL fragments that decide who can see / must act on a workflow request.
// One definition, used by the list page, the detail page, the bell and the pop-ups,
// so they can never disagree. Each returns { sql, params } to drop into a WHERE.

const { PERMISSION } = require('./workflowRequestFlow');

// A Head of Department only acts on requests for their own department. A user
// with no department set (or an admin) is not limited.
function deptParams(user) {
  const d = user.department_id ?? null;
  return [d, d];
}

// Requests this user is allowed to open.
function visibilityClause(user, perms, a = 'w') {
  if (user.role === 'admin') return { sql: '1 = 1', params: [] };
  const conds = [
    `${a}.created_by = ?`,
    `EXISTS (SELECT 1 FROM workflow_request_log l WHERE l.request_id = ${a}.id AND l.user_id = ?)`,
  ];
  const params = [user.id, user.id];
  if (perms[PERMISSION.HOD]) {
    conds.push(`(${a}.status = 'Pending HOD' AND (? IS NULL OR ${a}.department_id = ?))`);
    params.push(...deptParams(user));
  }
  if (perms[PERMISSION.FINANCE]) conds.push(`${a}.status = 'Pending Finance'`);
  if (perms[PERMISSION.IT]) conds.push(`${a}.status IN ('Pending IT', 'In Progress', 'Completed')`);
  return { sql: `(${conds.join(' OR ')})`, params };
}

// Requests that are waiting on THIS user right now (used for pop-ups).
function actionableClause(user, perms, a = 'w') {
  if (user.role === 'admin') {
    return { sql: `${a}.status IN ('Pending HOD', 'Pending Finance', 'Pending IT')`, params: [] };
  }
  const conds = [`(${a}.created_by = ? AND ${a}.status = 'Returned to HR')`];
  const params = [user.id];
  if (perms[PERMISSION.HOD]) {
    conds.push(`(${a}.status = 'Pending HOD' AND (? IS NULL OR ${a}.department_id = ?))`);
    params.push(...deptParams(user));
  }
  if (perms[PERMISSION.FINANCE]) conds.push(`${a}.status = 'Pending Finance'`);
  if (perms[PERMISSION.IT]) conds.push(`${a}.status = 'Pending IT'`);
  return { sql: `(${conds.join(' OR ')})`, params };
}

// Open requests worth showing in the bell: ones I started, ones waiting on me,
// and ones I am working on.
function bellClause(user, perms, a = 'w') {
  const open = `${a}.status NOT IN ('Completed', 'Cancelled')`;
  if (user.role === 'admin') return { sql: open, params: [] };
  const act = actionableClause(user, perms, a);
  return {
    sql: `(${open} AND (${a}.created_by = ? OR ${act.sql} OR (${a}.status = 'In Progress' AND ${a}.assigned_to = ?)))`,
    params: [user.id, ...act.params, user.id],
  };
}

module.exports = { visibilityClause, actionableClause, bellClause };
