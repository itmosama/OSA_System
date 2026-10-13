const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../src/utils/workflowRequestFlow');
const { STATUS } = flow;

test('HR submitting a draft sends it to the Head of Department', () => {
  assert.equal(flow.nextStatus(STATUS.DRAFT, 'submit'), STATUS.HOD);
});

test('HOD approval WITH a cost goes to Finance', () => {
  assert.equal(flow.nextStatus(STATUS.HOD, 'hod_approve', { hasCost: true }), STATUS.FINANCE);
});

test('HOD approval with NO cost skips Finance and goes straight to IT', () => {
  assert.equal(flow.nextStatus(STATUS.HOD, 'hod_approve', { hasCost: false }), STATUS.IT);
  assert.equal(flow.nextStatus(STATUS.HOD, 'hod_approve', {}), STATUS.IT);
});

test('Finance approval sends it to IT', () => {
  assert.equal(flow.nextStatus(STATUS.FINANCE, 'finance_approve'), STATUS.IT);
});

test('IT starts then completes', () => {
  assert.equal(flow.nextStatus(STATUS.IT, 'start'), STATUS.IN_PROGRESS);
  assert.equal(flow.nextStatus(STATUS.IN_PROGRESS, 'complete'), STATUS.COMPLETED);
});

test('a return from HOD or Finance goes back to HR, and HR can resubmit', () => {
  assert.equal(flow.nextStatus(STATUS.HOD, 'hod_return'), STATUS.RETURNED);
  assert.equal(flow.nextStatus(STATUS.FINANCE, 'finance_return'), STATUS.RETURNED);
  assert.equal(flow.nextStatus(STATUS.RETURNED, 'submit'), STATUS.HOD);
});

test('actions are refused from the wrong status (nothing can be skipped or repeated)', () => {
  assert.equal(flow.nextStatus(STATUS.DRAFT, 'hod_approve'), null, 'HOD cannot approve a draft');
  assert.equal(flow.nextStatus(STATUS.HOD, 'finance_approve'), null, 'Finance cannot approve at the HOD step');
  assert.equal(flow.nextStatus(STATUS.HOD, 'start'), null, 'IT cannot start before approvals');
  assert.equal(flow.nextStatus(STATUS.FINANCE, 'start'), null, 'IT cannot start before Finance approves');
  assert.equal(flow.nextStatus(STATUS.IT, 'complete'), null, 'must be started before it can be completed');
  assert.equal(flow.nextStatus(STATUS.COMPLETED, 'start'), null);
  assert.equal(flow.nextStatus(STATUS.COMPLETED, 'cancel'), null, 'a completed request cannot be cancelled');
  assert.equal(flow.nextStatus(STATUS.CANCELLED, 'submit'), null);
  assert.equal(flow.nextStatus(STATUS.IT, 'hod_return'), null);
  assert.equal(flow.nextStatus(STATUS.HOD, 'not-a-real-action'), null);
});

test('cancel is allowed at every open stage', () => {
  [STATUS.DRAFT, STATUS.HOD, STATUS.FINANCE, STATUS.IT, STATUS.IN_PROGRESS, STATUS.RETURNED].forEach(s => {
    assert.equal(flow.nextStatus(s, 'cancel'), STATUS.CANCELLED, s);
  });
});

test('stepForStatus and permissionForStep line up with who may act', () => {
  assert.equal(flow.stepForStatus(STATUS.HOD), 'HOD');
  assert.equal(flow.stepForStatus(STATUS.FINANCE), 'Finance');
  assert.equal(flow.stepForStatus(STATUS.IT), 'IT');
  assert.equal(flow.stepForStatus(STATUS.IN_PROGRESS), 'IT');
  assert.equal(flow.stepForStatus(STATUS.DRAFT), null);
  assert.equal(flow.permissionForStep('HOD'), 'can_review_workflow_as_hod');
  assert.equal(flow.permissionForStep('Finance'), 'can_approve_workflow_as_finance');
  assert.equal(flow.permissionForStep('IT'), 'can_fulfil_workflow_requests');
});

test('parseCost: no cost ticked means no amount, whatever was typed', () => {
  assert.deepEqual(flow.parseCost(undefined, '500'), { ok: true, hasCost: false, amount: null });
});

test('parseCost: a cost needs a positive number', () => {
  assert.deepEqual(flow.parseCost('1', '1,250.456'), { ok: true, hasCost: true, amount: 1250.46 });
  assert.equal(flow.parseCost('1', '').ok, false);
  assert.equal(flow.parseCost('1', '0').ok, false);
  assert.equal(flow.parseCost('1', '-5').ok, false);
  assert.equal(flow.parseCost('1', 'abc').ok, false);
  assert.equal(flow.parseCost('1', '99999999999').ok, false);
});

test('tracker: Finance shows as skipped once a no-cost request is past the HOD', () => {
  const states = (status, has_cost) => flow.trackerSteps({ status, has_cost }).map(s => s.state);
  assert.deepEqual(states(STATUS.DRAFT, 0),       ['current', 'upcoming', 'upcoming', 'upcoming']);
  assert.deepEqual(states(STATUS.HOD, 0),         ['done', 'current', 'upcoming', 'upcoming']);
  assert.deepEqual(states(STATUS.FINANCE, 1),     ['done', 'done', 'current', 'upcoming']);
  assert.deepEqual(states(STATUS.IT, 0),          ['done', 'done', 'skipped', 'current']);
  assert.deepEqual(states(STATUS.IT, 1),          ['done', 'done', 'done', 'current']);
  assert.deepEqual(states(STATUS.IN_PROGRESS, 1), ['done', 'done', 'done', 'current']);
  assert.deepEqual(states(STATUS.COMPLETED, 0),   ['done', 'done', 'skipped', 'done']);
  assert.deepEqual(states(STATUS.RETURNED, 1),    ['returned', 'upcoming', 'upcoming', 'upcoming']);
  assert.deepEqual(states(STATUS.CANCELLED, 1),   ['upcoming', 'upcoming', 'upcoming', 'upcoming']);
});
