// Who may see / submit tickets.
//  - Admins and agents see every ticket (unchanged).
//  - A requester sees their own tickets, plus — when their permission group has
//    "View Department Tickets" — tickets raised by their department or sent to it.
//  - Submitting is open to everyone except people whose permission group does not
//    include "Submit Tickets" (users with no group are never locked out).

function seesAllTickets(user) {
  return user.role === 'admin' || user.role === 'agent';
}

function canSubmitTickets(user, perms) {
  if (user.role === 'admin') return true;
  if (!user.group_id) return true;
  return !!perms.can_submit_tickets;
}

function hasDepartmentView(user, perms) {
  return !!(perms.can_view_department_tickets && user.department_id);
}

// SQL fragment limiting `t` (the tickets table/alias) to what this user may see.
// Returns null when there is no limit.
function ticketScope(user, perms, a = 't') {
  if (seesAllTickets(user)) return null;
  if (!hasDepartmentView(user, perms)) return { sql: `${a}.created_by = ?`, params: [user.id] };
  const d = user.department_id;
  return {
    sql: `(${a}.created_by = ?
      OR ${a}.department_id = ?
      OR ${a}.requester_department_id = ?
      OR EXISTS (SELECT 1 FROM users su WHERE su.id = ${a}.created_by AND su.department_id = ?)
      OR EXISTS (SELECT 1 FROM request_types srt WHERE srt.id = ${a}.request_type_id AND srt.handling_department_id = ?))`,
    params: [user.id, d, d, d, d],
  };
}

// Single-ticket check (ticket is a plain tickets row).
function canViewTicket(user, perms, ticket, db) {
  if (seesAllTickets(user)) return true;
  if (ticket.created_by === user.id) return true;
  if (!hasDepartmentView(user, perms)) return false;
  const d = user.department_id;
  if (ticket.department_id === d || ticket.requester_department_id === d) return true;
  const submitter = db.prepare('SELECT department_id FROM users WHERE id = ?').get(ticket.created_by);
  if (submitter && submitter.department_id === d) return true;
  const rt = db.prepare('SELECT handling_department_id FROM request_types WHERE id = ?').get(ticket.request_type_id);
  return !!(rt && rt.handling_department_id === d);
}

// Reports: admins and people with "View Reports: All Departments" see everything;
// anyone else with report access sees only tickets tied to their own department
// (requested of it, submitted from it, or routed to it by request type).
function seesAllReports(user, perms) {
  return user.role === 'admin' || !!perms.can_view_all_department_reports;
}

// A sub-select to use in place of the tickets table. Values are inlined as
// integers (never user text), so it can be dropped into any query.
function reportTicketsSource(user, perms) {
  if (seesAllReports(user, perms)) return 'tickets';
  const d = Number(user.department_id);
  if (!Number.isInteger(d) || d <= 0) return '(SELECT * FROM tickets WHERE 0)';
  return `(SELECT * FROM tickets t0 WHERE t0.department_id = ${d}
    OR t0.requester_department_id = ${d}
    OR EXISTS (SELECT 1 FROM request_types r0 WHERE r0.id = t0.request_type_id AND r0.handling_department_id = ${d}))`;
}

module.exports = { seesAllReports, reportTicketsSource, seesAllTickets, canSubmitTickets, hasDepartmentView, ticketScope, canViewTicket };
