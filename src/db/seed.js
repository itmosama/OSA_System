require('dotenv').config({ path: require('../utils/appPaths').envPath });
const bcrypt = require('bcryptjs');
const db = require('./index');

function seed() {
  const deptCount = db.prepare('SELECT COUNT(*) c FROM departments').get().c;
  if (deptCount === 0) {
    const insertDept = db.prepare('INSERT INTO departments (name) VALUES (?)');
    ['Front Office', 'Housekeeping', 'Food & Beverage', 'Engineering / Maintenance', 'Sales & Marketing', 'Human Resources', 'Finance', 'IT'].forEach(name => insertDept.run(name));
    console.log('Seeded departments');
  }

  const itDept = db.prepare('SELECT id FROM departments WHERE name = ?').get('IT');

  const typeCount = db.prepare('SELECT COUNT(*) c FROM request_types').get().c;
  if (typeCount === 0) {
    const insertType = db.prepare('INSERT INTO request_types (name, description, default_priority, handling_department_id) VALUES (?, ?, ?, ?)');
    [
      ['Hardware Issue', 'PC, printer, scanner, or other equipment problem', 'Medium'],
      ['Software Issue', 'Application errors, installs, or updates', 'Medium'],
      ['Network / Wi-Fi', 'Internet, Wi-Fi, or network connectivity issue', 'High'],
      ['POS / PMS Issue', 'Point of sale or property management system issue', 'High'],
      ['Phone / Extension', 'Telephone or extension issue', 'Medium'],
      ['TV / In-Room Entertainment', 'Guest room TV or entertainment system', 'Medium'],
      ['Account / Access Request', 'New account, password reset, or access request', 'Medium'],
      ['New Equipment Request', 'Request for new hardware or software', 'Low'],
      ['Other', 'Anything not listed above', 'Low'],
    ].forEach(row => insertType.run(...row, itDept ? itDept.id : null));
    console.log('Seeded request types');
  }

  const roomTypeCount = db.prepare('SELECT COUNT(*) c FROM room_types').get().c;
  if (roomTypeCount === 0) {
    const insertRoomType = db.prepare('INSERT INTO room_types (name) VALUES (?)');
    ['Standard Room', 'Deluxe Room', 'Suite', 'Royal Suite', 'Family Room'].forEach(name => insertRoomType.run(name));
    console.log('Seeded room types');
  }

  const slaCount = db.prepare('SELECT COUNT(*) c FROM priority_slas').get().c;
  if (slaCount === 0) {
    const insertSla = db.prepare('INSERT INTO priority_slas (priority, hours, minutes, color, sort_order, is_builtin) VALUES (?, ?, ?, ?, ?, 1)');
    require('./priorityDefaults').forEach(d => insertSla.run(d.priority, d.minutes / 60, d.minutes, d.color, d.sort_order));
    console.log('Seeded priority SLA targets');
  }

  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
    const password = process.env.DEFAULT_ADMIN_PASSWORD || 'ChangeMe123!';
    const fullName = process.env.DEFAULT_ADMIN_NAME || 'IT Administrator';
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`INSERT INTO users (username, password_hash, full_name, role, department_id, active) VALUES (?, ?, ?, 'admin', ?, 1)`)
      .run(username, hash, fullName, itDept ? itDept.id : null);
    console.log(`Seeded default admin user -> username: ${username} / password: ${password} (please change after first login)`);
  }
}

seed();
module.exports = seed;
