const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, buildTemplate, planImport } = require('../src/utils/staffImport');

const ctx = {
  departments: [{ id: 1, name: 'Engineering' }, { id: 2, name: 'Housekeeping' }],
  users: [{ id: 7, username: 'mary.jones' }],
  existing: [{ full_name: 'Old Timer', department_id: 1 }],
};

test('parses quotes, BOM, semicolons and blank lines', () => {
  assert.deepStrictEqual(parseCsv('\uFEFFa,b\r\n"x, y",z\r\n\r\n'), [['a', 'b'], ['x, y', 'z']]);
  assert.deepStrictEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepStrictEqual(parseCsv('a,b\n"he said ""hi""",2'), [['a', 'b'], ['he said "hi"', '2']]);
});

test('template round-trips and its example rows are skipped', () => {
  const plan = planImport(parseCsv(buildTemplate(['Engineering', 'Housekeeping'])), ctx);
  assert.strictEqual(plan.toAdd.length, 0);
  assert.strictEqual(plan.problems.length, 0);
  assert.strictEqual(plan.skipped.length, 2);
});

test('valid rows are planned, matching department and login case-insensitively', () => {
  const plan = planImport(parseCsv('Staff Name,Department,Login Username (optional)\nAli,engineering,\nMary,HOUSEKEEPING,Mary.Jones'), ctx);
  assert.deepStrictEqual(plan.toAdd.map(s => [s.name, s.department_id, s.user_id]), [['Ali', 1, null], ['Mary', 2, 7]]);
});

test('unknown department, unknown login and missing name are reported with row numbers', () => {
  const plan = planImport(parseCsv('Staff Name,Department,Login\nAli,Kitchen,\nBo,Engineering,nobody\n,Engineering,'), ctx);
  assert.deepStrictEqual(plan.problems.map(p => p.line), [2, 3, 4]);
});

test('duplicates (in the file or already saved) are skipped', () => {
  const plan = planImport(parseCsv('Staff Name,Department\nOld Timer,Engineering\nAli,Engineering\nali,Engineering'), ctx);
  assert.strictEqual(plan.toAdd.length, 1);
  assert.strictEqual(plan.skipped.length, 2);
});

test('missing columns give a clear error', () => {
  const plan = planImport(parseCsv('Foo,Bar\n1,2'), ctx);
  assert.match(plan.problems[0].message, /Staff Name/);
});
