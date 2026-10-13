(function () {
  const POLL_INTERVAL_MS = 20000;

  // Same icons the Notifications page uses for each kind of alert.
  const ICONS = {
    success: 'bi-check-circle-fill',
    info: 'bi-info-circle-fill',
    warning: 'bi-exclamation-triangle-fill',
    error: 'bi-exclamation-circle-fill',
  };

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // One pop-up in the "alert card" style: coloured icon, bold title, small
  // muted text and a dismiss (X). Clicking the card opens `href`.
  function showCard({ variant, title, body, href }) {
    const container = document.getElementById('notifToastContainer');
    if (!container || typeof bootstrap === 'undefined') return;

    const toastEl = document.createElement('div');
    toastEl.className = 'toast osa-toast border-0 mb-2 notif-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.innerHTML = `
      <div class="osa-alert osa-alert-${variant}" style="cursor:pointer">
        <i class="bi ${ICONS[variant] || ICONS.info} osa-alert-icon" aria-hidden="true"></i>
        <div class="osa-alert-body">
          <div class="osa-alert-title">${escapeHtml(title)}</div>
          <div class="osa-alert-text">${body}</div>
        </div>
        <button type="button" class="osa-alert-x notif-toast-close" aria-label="Dismiss"><i class="bi bi-x-lg"></i></button>
      </div>`;

    const toast = new bootstrap.Toast(toastEl, { delay: 20000 });
    toastEl.addEventListener('click', (e) => {
      if (e.target.closest('.notif-toast-close')) { toast.hide(); return; }
      window.location.href = href;
    });
    container.appendChild(toastEl);
    toast.show();
    toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
  }

  const showTicketToast = (t) => showCard({
    variant: 'success', title: 'New ticket',
    body: `${escapeHtml(t.ticket_number)} — ${escapeHtml(t.subject)}<br>Priority: ${escapeHtml(t.priority)}`,
    href: '/tickets/' + t.id,
  });

  const showTicketUpdateToast = (u) => showCard({
    variant: 'info', title: 'Ticket updated',
    body: `${escapeHtml(u.ticket_number)} — ${escapeHtml(u.subject)}<br>${escapeHtml(u.actor)}: ${escapeHtml(u.text)}`,
    href: '/tickets/' + u.id,
  });

  const showAccessRequestToast = (r) => showCard({
    variant: 'warning', title: 'Access request awaiting you',
    body: `${escapeHtml(r.reference_number)} — ${escapeHtml(r.employee_full_name)}<br>${escapeHtml(r.status)}`,
    href: '/access-requests/' + r.id,
  });

  const showWorkflowToast = (r) => showCard({
    variant: 'warning', title: 'Workflow request awaiting you',
    body: `${escapeHtml(r.reference_number)} — ${escapeHtml(r.title)}<br>${escapeHtml(r.status)}`,
    href: '/workflow-requests/' + r.id,
  });

  async function poll() {
    try {
      const res = await fetch('/tickets/api/notifications', { credentials: 'same-origin' });
      if (res.status === 401) { window.location.href = '/login?timeout=1'; return; }
      if (res.ok) {
        const data = await res.json();
        (data.tickets || []).forEach(showTicketToast);
        (data.updates || []).forEach(showTicketUpdateToast);
      }
    } catch (e) { /* network hiccup — try again next interval */ }

    try {
      const res2 = await fetch('/access-requests/api/notifications', { credentials: 'same-origin' });
      if (res2.status === 401) { window.location.href = '/login?timeout=1'; return; }
      if (res2.ok) {
        const data2 = await res2.json();
        (data2.requests || []).forEach(showAccessRequestToast);
      }
    } catch (e) { /* network hiccup — try again next interval */ }
  }

  async function pollWorkflow() {
    if (!document.querySelector('[href="/workflow-requests"]')) return; // user has no access
    try {
      const res = await fetch('/workflow-requests/api/notifications', { credentials: 'same-origin' });
      if (res.status === 401) { window.location.href = '/login?timeout=1'; return; }
      if (res.ok) {
        const data = await res.json();
        (data.requests || []).forEach(showWorkflowToast);
      }
    } catch (e) { /* try again next interval */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('notifToastContainer')) return;
    poll(); pollWorkflow();
    setInterval(() => { poll(); pollWorkflow(); }, POLL_INTERVAL_MS);
  });
})();
