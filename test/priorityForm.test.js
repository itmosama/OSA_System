const test = require('node:test');
const assert = require('node:assert/strict');
// Express's urlencoded({ extended: true }) body parser uses qs, so this is
// exactly how the Priority SLA form is read on the server.
const qs = require('qs');

test('bare numeric keys are turned into a renumbered list (the bug this guards against)', () => {
  const parsed = qs.parse('p[1][minutes]=10&p[2][minutes]=20&p[3][minutes]=60');
  assert.ok(Array.isArray(parsed.p), 'p becomes an array');
  // priority id 1 would wrongly receive the values meant for id 2:
  assert.equal(parsed.p[1].minutes, '20');
});

test('"id_<n>" keys stay keyed by id, including across gaps', () => {
  const parsed = qs.parse('p[id_1][minutes]=10&p[id_2][minutes]=20&p[id_4][minutes]=90&p[id_6][minutes]=5');
  assert.equal(Array.isArray(parsed.p), false);
  assert.equal(parsed.p.id_1.minutes, '10');
  assert.equal(parsed.p.id_2.minutes, '20');
  assert.equal(parsed.p.id_4.minutes, '90');
  assert.equal(parsed.p.id_6.minutes, '5');
  assert.equal(parsed.p.id_3, undefined);
});
