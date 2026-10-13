const db = require('../db');
const { textColorFor, emojiForColor } = require('./priorityHelpers');

// Every priority, most urgent first, with the display extras the views need.
function listPriorities() {
  return db.prepare(`
    SELECT id, priority, minutes, color, sort_order, is_builtin
    FROM priority_slas ORDER BY sort_order, id
  `).all().map(p => ({
    ...p,
    textColor: textColorFor(p.color),
    emoji: emojiForColor(p.color),
  }));
}

// name -> priority, for looking up a ticket's colour by its priority name.
function priorityMap(list = listPriorities()) {
  return Object.fromEntries(list.map(p => [p.priority, p]));
}

function isValidPriority(name, list = listPriorities()) {
  return list.some(p => p.priority === name);
}

// The priority a new ticket gets when none (or an unknown one) is chosen.
function defaultPriorityName(list = listPriorities()) {
  return list.some(p => p.priority === 'Medium') ? 'Medium' : (list[0] ? list[0].priority : 'Medium');
}

// Returns `name` if it is a real priority, otherwise the default.
function validPriorityOrDefault(name, list = listPriorities()) {
  return isValidPriority(name, list) ? name : defaultPriorityName(list);
}

module.exports = { listPriorities, priorityMap, isValidPriority, defaultPriorityName, validPriorityOrDefault };
