const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidHex, textColorFor, emojiForColor, validatePriorityName } = require('../src/utils/priorityHelpers');

test('isValidHex accepts #rrggbb only', () => {
  assert.equal(isValidHex('#dc3545'), true);
  assert.equal(isValidHex('#DC3545'), true);
  assert.equal(isValidHex('dc3545'), false);
  assert.equal(isValidHex('#fff'), false);
  assert.equal(isValidHex('red'), false);
  assert.equal(isValidHex(null), false);
});

test('textColorFor gives dark text on light colours and white on dark ones', () => {
  assert.equal(textColorFor('#ffc107'), '#212529'); // the yellow used for High
  assert.equal(textColorFor('#ffffff'), '#212529');
  assert.equal(textColorFor('#dc3545'), '#ffffff'); // red
  assert.equal(textColorFor('#198754'), '#ffffff'); // green
  assert.equal(textColorFor('#6c757d'), '#ffffff'); // grey
  assert.equal(textColorFor('not-a-colour'), '#ffffff'); // falls back to grey
});

test('emojiForColor matches the four built-in colours to their original emoji', () => {
  assert.equal(emojiForColor('#dc3545'), '🔴');
  assert.equal(emojiForColor('#ffc107'), '🟡');
  assert.equal(emojiForColor('#6c757d'), '⚪');
  assert.equal(emojiForColor('#198754'), '🟢');
});

test('emojiForColor covers other hues', () => {
  assert.equal(emojiForColor('#fd7e14'), '🟠');
  assert.equal(emojiForColor('#0d6efd'), '🔵');
  assert.equal(emojiForColor('#6f42c1'), '🟣');
  assert.equal(emojiForColor('#000000'), '⚫');
});

test('validatePriorityName trims, collapses spaces and enforces rules', () => {
  assert.deepEqual(validatePriorityName('  Very   High '), { ok: true, name: 'Very High' });
  assert.deepEqual(validatePriorityName('P1-Critical'), { ok: true, name: 'P1-Critical' });
  assert.equal(validatePriorityName('').ok, false);
  assert.equal(validatePriorityName('   ').ok, false);
  assert.equal(validatePriorityName('x'.repeat(31)).ok, false);
  assert.equal(validatePriorityName('<script>').ok, false);
  assert.equal(validatePriorityName('-leading').ok, false);
  assert.equal(validatePriorityName(undefined).ok, false);
});
