// Rules for the Workflow Request module (no database access, so it is easy to test).
//
//   HR submits -> Head of Department adds input (and any cost)
//     -> Finance approves, ONLY if there is a cost
//     -> IT receives it, starts work, completes it
// A "return" at the HOD or Finance step sends it back to HR to fix and resubmit.

const STATUS = {
  DRAFT: 'Draft',
  HOD: 'Pending HOD',
  FINANCE: 'Pending Finance',
  IT: 'Pending IT',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  RETURNED: 'Returned to HR',
  CANCELLED: 'Cancelled',
};

const ALL_STATUSES = Object.values(STATUS);
const CLOSED_STATUSES = [STATUS.COMPLETED, STATUS.CANCELLED];

const PERMISSION = {
  SUBMIT: 'can_submit_workflow_requests',
  HOD: 'can_review_workflow_as_hod',
  FINANCE: 'can_approve_workflow_as_finance',
  IT: 'can_fulfil_workflow_requests',
};
const ALL_PERMISSIONS = Object.values(PERMISSION);

// action -> { from: [statuses it may be taken from] }
const ACTIONS = {
  submit:           { from: [STATUS.DRAFT, STATUS.RETURNED] },
  hod_approve:      { from: [STATUS.HOD] },
  hod_return:       { from: [STATUS.HOD] },
  finance_approve:  { from: [STATUS.FINANCE] },
  finance_return:   { from: [STATUS.FINANCE] },
  start:            { from: [STATUS.IT] },
  complete:         { from: [STATUS.IN_PROGRESS] },
  cancel:           { from: [STATUS.DRAFT, STATUS.HOD, STATUS.FINANCE, STATUS.IT, STATUS.IN_PROGRESS, STATUS.RETURNED] },
};

// The status a request moves to when `action` is taken. Returns null when the
// action is not allowed from the current status. `ctx.hasCost` only matters for
// hod_approve (a cost sends it to Finance, no cost goes straight to IT).
function nextStatus(current, action, ctx = {}) {
  const rule = ACTIONS[action];
  if (!rule || !rule.from.includes(current)) return null;
  switch (action) {
    case 'submit': return STATUS.HOD;
    case 'hod_approve': return ctx.hasCost ? STATUS.FINANCE : STATUS.IT;
    case 'finance_approve': return STATUS.IT;
    case 'hod_return':
    case 'finance_return': return STATUS.RETURNED;
    case 'start': return STATUS.IN_PROGRESS;
    case 'complete': return STATUS.COMPLETED;
    case 'cancel': return STATUS.CANCELLED;
    default: return null;
  }
}

// The step a user must belong to in order to act while a request is in `status`.
function stepForStatus(status) {
  if (status === STATUS.HOD) return 'HOD';
  if (status === STATUS.FINANCE) return 'Finance';
  if (status === STATUS.IT || status === STATUS.IN_PROGRESS) return 'IT';
  return null;
}

function permissionForStep(step) {
  return { HOD: PERMISSION.HOD, Finance: PERMISSION.FINANCE, IT: PERMISSION.IT }[step] || null;
}

// Cost entered by the Head of Department. Returns { ok, hasCost, amount } or { ok:false, error }.
function parseCost(hasCostRaw, amountRaw) {
  const hasCost = hasCostRaw === true || hasCostRaw === '1' || hasCostRaw === 'on' || hasCostRaw === 1;
  if (!hasCost) return { ok: true, hasCost: false, amount: null };
  const amount = parseFloat(String(amountRaw ?? '').replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter the estimated cost as a number greater than zero, or untick "This request has a cost".' };
  }
  if (amount > 1e9) return { ok: false, error: 'That cost looks too large. Please check the amount.' };
  return { ok: true, hasCost: true, amount: Math.round(amount * 100) / 100 };
}

// The four boxes shown at the top of a request. state: done | current | upcoming | skipped | returned
function trackerSteps(request) {
  const s = request.status;
  const hasCost = !!request.has_cost;
  const past = (...list) => list.includes(s);

  let hr = 'done';
  if (past(STATUS.DRAFT)) hr = 'current';
  if (past(STATUS.RETURNED)) hr = 'returned';

  let hod = 'upcoming';
  if (past(STATUS.HOD)) hod = 'current';
  else if (past(STATUS.FINANCE, STATUS.IT, STATUS.IN_PROGRESS, STATUS.COMPLETED)) hod = 'done';

  let finance = 'upcoming';
  if (past(STATUS.FINANCE)) finance = 'current';
  else if (past(STATUS.IT, STATUS.IN_PROGRESS, STATUS.COMPLETED)) finance = hasCost ? 'done' : 'skipped';

  let it = 'upcoming';
  if (past(STATUS.IT, STATUS.IN_PROGRESS)) it = 'current';
  else if (past(STATUS.COMPLETED)) it = 'done';

  if (past(STATUS.CANCELLED)) { hr = hod = finance = it = 'upcoming'; }

  return [
    { key: 'HR', label: 'HR request', state: hr },
    { key: 'HOD', label: 'Head of Department', state: hod },
    { key: 'Finance', label: 'Finance', state: finance },
    { key: 'IT', label: 'IT', state: it },
  ];
}

module.exports = {
  STATUS, ALL_STATUSES, CLOSED_STATUSES, PERMISSION, ALL_PERMISSIONS, ACTIONS,
  nextStatus, stepForStatus, permissionForStep, parseCost, trackerSteps,
};
