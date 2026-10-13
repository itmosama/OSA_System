// State machine for the New Joiner IT Access Request approval flow.
//
// Draft -> Submitted -> Pending HOD -> Pending HR -> Pending IT Manager
//   -> (Pending GM, only if required) -> Approved -> In Progress
//   -> Awaiting User Acknowledgment -> Closed
// A rejection at any Pending-* step sends the request to Rejected.

const APPROVAL_STEPS = ['HOD', 'HR', 'IT Manager', 'GM'];

const STEP_TO_STATUS = {
  HOD: 'Pending HOD',
  HR: 'Pending HR',
  'IT Manager': 'Pending IT Manager',
  GM: 'Pending GM',
};

const STEP_PERMISSION = {
  HOD: 'can_approve_as_hod',
  HR: 'can_approve_as_hr',
  'IT Manager': 'can_approve_as_it_manager',
  GM: 'can_approve_as_gm',
};

// Determines whether GM approval is required, per the business rule: any
// selected access-system level flagged admin-level, OR any selected system
// flagged "always needs GM" (e.g. VPN, Finance), triggers it.
function computeGmRequired(items) {
  return items.some(item => item.required && (item.isAdminLevel || item.systemGmAlways));
}

// Given gm_required, returns the ordered list of approval steps this request
// must go through.
function stepsForRequest(gmRequired) {
  return gmRequired ? APPROVAL_STEPS : APPROVAL_STEPS.filter(s => s !== 'GM');
}

// The status a request should move to right after being submitted, or after
// each successful approval — i.e. "what's the next pending step, or are we
// done". Returns 'Approved' once every required step has an Approved decision.
function nextStatus(gmRequired, decidedSteps) {
  const steps = stepsForRequest(gmRequired);
  const nextStep = steps.find(s => !decidedSteps.includes(s));
  return nextStep ? STEP_TO_STATUS[nextStep] : 'Approved';
}

// Maps a request's current status to the approval step a decision on it
// applies to (undefined if the status isn't a pending-approval step).
function stepForStatus(status) {
  return Object.keys(STEP_TO_STATUS).find(step => STEP_TO_STATUS[step] === status);
}

module.exports = {
  APPROVAL_STEPS,
  STEP_TO_STATUS,
  STEP_PERMISSION,
  computeGmRequired,
  stepsForRequest,
  nextStatus,
  stepForStatus,
};
