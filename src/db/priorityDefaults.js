// The four priorities every installation starts with. They keep the colours
// the system has always used; admins can recolour, reorder and re-time them
// but not delete them (the app relies on "Medium" existing as the default).
module.exports = [
  { priority: 'Urgent', color: '#dc3545', sort_order: 1, minutes: 240 },
  { priority: 'High',   color: '#ffc107', sort_order: 2, minutes: 480 },
  { priority: 'Medium', color: '#6c757d', sort_order: 3, minutes: 1440 },
  { priority: 'Low',    color: '#198754', sort_order: 4, minutes: 4320 },
];
