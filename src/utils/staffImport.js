// CSV helpers for the Staff import: a small parser (quotes, BOM, comma or
// semicolon separated — Excel uses ; in some regions) and the row rules.

const { normalizePhone } = require('./phone');

function parseCsv(text) {
  let src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildTemplate(departmentNames) {
  const d = departmentNames.length ? departmentNames : ['Engineering', 'Housekeeping'];
  const lines = [
    ['Staff Name', 'Department', 'Login Username (optional)', 'Mobile Number (optional, with country code)'],
    ['Example: John Smith', d[0], '', '+971501234567'],
    ['Example: Mary Jones', d[1] || d[0], 'mary.jones', '+971507654321'],
  ];
  return '﻿' + lines.map(l => l.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// Turns parsed rows into { toAdd, problems, skipped }.
//  departments: [{id,name}]  users: [{id,username}]  existing: [{full_name, department_id}]
function planImport(rows, { departments, users, existing }) {
  const result = { toAdd: [], problems: [], skipped: [] };
  if (!rows.length) { result.problems.push({ line: 1, message: 'The file is empty.' }); return result; }

  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const col = (...names) => header.findIndex(h => names.some(n => h.startsWith(n)));
  const nameCol = col('staff name', 'name');
  const deptCol = col('department', 'dept');
  const userCol = col('login', 'username', 'user');
  const mobileCol = col('mobile', 'phone', 'whatsapp');
  if (nameCol === -1 || deptCol === -1) {
    result.problems.push({ line: 1, message: 'The first row must have the columns "Staff Name" and "Department". Please start from the template.' });
    return result;
  }

  const deptByName = new Map(departments.map(d => [d.name.trim().toLowerCase(), d]));
  const userByName = new Map(users.map(u => [u.username.trim().toLowerCase(), u]));
  const seen = new Set(existing.map(e => `${e.full_name.trim().toLowerCase()}|${e.department_id}`));

  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const name = String(r[nameCol] || '').trim();
    const deptName = String(r[deptCol] || '').trim();
    const username = userCol === -1 ? '' : String(r[userCol] || '').trim();
    const mobileRaw = mobileCol === -1 ? '' : String(r[mobileCol] || '').trim();
    if (!name && !deptName) return;
    if (/^example:/i.test(name)) { result.skipped.push({ line, name, reason: 'Example row' }); return; }
    if (!name) return result.problems.push({ line, message: 'Staff name is missing.' });
    if (!deptName) return result.problems.push({ line, message: `${name}: department is missing.` });
    const dept = deptByName.get(deptName.toLowerCase());
    if (!dept) return result.problems.push({ line, message: `${name}: department "${deptName}" does not exist. Add it under Admin → Departments first, or fix the spelling.` });
    let userId = null;
    if (username) {
      const u = userByName.get(username.toLowerCase());
      if (!u) return result.problems.push({ line, message: `${name}: login "${username}" was not found.` });
      userId = u.id;
    }
    const mobile = normalizePhone(mobileRaw);
    if (mobile === null) return result.problems.push({ line, message: `${name}: mobile number "${mobileRaw}" does not look right (use the international format, for example +971501234567).` });
    const key = `${name.toLowerCase()}|${dept.id}`;
    if (seen.has(key)) return result.skipped.push({ line, name, reason: 'Already in the list' });
    seen.add(key);
    result.toAdd.push({ line, name, department_id: dept.id, department_name: dept.name, user_id: userId, mobile });
  });
  return result;
}

module.exports = { parseCsv, buildTemplate, planImport, csvEscape };
