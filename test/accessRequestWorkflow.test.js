const test = require('node:test');
const assert = require('node:assert/strict');
const workflow = require('../src/utils/accessRequestWorkflow');

test('computeGmRequired: false when nothing admin-level or gm-always selected', () => {
  const items = [
    { required: true, isAdminLevel: false, systemGmAlways: false },
    { required: false, isAdminLevel: true, systemGmAlways: false }, // not required — shouldn't count
  ];
  assert.equal(workflow.computeGmRequired(items), false);
});

test('computeGmRequired: true when a required item has an admin-level access level', () => {
  const items = [
    { required: true, isAdminLevel: true, systemGmAlways: false },
  ];
  assert.equal(workflow.computeGmRequired(items), true);
});

test('computeGmRequired: true when a required item is on a system flagged "always needs GM" (e.g. VPN, Finance)', () => {
  const items = [
    { required: true, isAdminLevel: false, systemGmAlways: true },
  ];
  assert.equal(workflow.computeGmRequired(items), true);
});

test('stepsForRequest: includes GM only when required', () => {
  assert.deepEqual(workflow.stepsForRequest(false), ['HOD', 'HR', 'IT Manager']);
  assert.deepEqual(workflow.stepsForRequest(true), ['HOD', 'HR', 'IT Manager', 'GM']);
});

test('nextStatus: walks HOD -> HR -> IT Manager -> Approved when GM not required', () => {
  assert.equal(workflow.nextStatus(false, []), 'Pending HOD');
  assert.equal(workflow.nextStatus(false, ['HOD']), 'Pending HR');
  assert.equal(workflow.nextStatus(false, ['HOD', 'HR']), 'Pending IT Manager');
  assert.equal(workflow.nextStatus(false, ['HOD', 'HR', 'IT Manager']), 'Approved');
});

test('nextStatus: inserts a GM step before Approved when GM is required', () => {
  assert.equal(workflow.nextStatus(true, ['HOD', 'HR', 'IT Manager']), 'Pending GM');
  assert.equal(workflow.nextStatus(true, ['HOD', 'HR', 'IT Manager', 'GM']), 'Approved');
});

test('stepForStatus: maps pending statuses back to their approval step', () => {
  assert.equal(workflow.stepForStatus('Pending HOD'), 'HOD');
  assert.equal(workflow.stepForStatus('Pending GM'), 'GM');
  assert.equal(workflow.stepForStatus('Approved'), undefined);
  assert.equal(workflow.stepForStatus('Closed'), undefined);
});

test('STEP_PERMISSION maps every approval step to a permission key', () => {
  workflow.APPROVAL_STEPS.forEach(step => {
    assert.ok(workflow.STEP_PERMISSION[step], `missing permission mapping for step "${step}"`);
  });
});
