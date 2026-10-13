(function () {
  function formatDuration(ms) {
    if (ms < 0) ms = 0;
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days) parts.push(days + 'd');
    parts.push(String(hours).padStart(2, '0') + 'h');
    parts.push(String(minutes).padStart(2, '0') + 'm');
    parts.push(String(seconds).padStart(2, '0') + 's');
    return parts.join(' ');
  }

  const STATUS_CLASSES = ['sla-green', 'sla-yellow', 'sla-red'];

  function initTicketTimers() {
    document.querySelectorAll('[data-ticket-timer]').forEach(el => {
      const createdAt = new Date(el.dataset.createdAt);
      const dueAt = el.dataset.dueAt ? new Date(el.dataset.dueAt) : null;
      const finished = el.dataset.finished === '1';
      const finishedAt = el.dataset.finishedAt ? new Date(el.dataset.finishedAt) : null;

      const elapsedEl = el.querySelector('.ticket-elapsed');
      const badgeEl = el.querySelector('.ticket-sla-badge');
      const remainingEl = el.querySelector('.ticket-remaining');

      function applyStatusClass(status) {
        el.classList.remove(...STATUS_CLASSES);
        if (status) el.classList.add('sla-' + status);
      }

      function tick() {
        const now = new Date();
        const endPoint = finished && finishedAt ? finishedAt : now;
        if (elapsedEl) elapsedEl.textContent = formatDuration(endPoint - createdAt);

        if (!dueAt) return;

        const referenceTime = finished ? (finishedAt || now) : now;
        const totalWindow = dueAt - createdAt;
        const elapsed = referenceTime - createdAt;
        const percent = totalWindow > 0 ? elapsed / totalWindow : 1;
        const overdue = referenceTime > dueAt;

        let status;
        if (overdue) status = 'red';
        else if (percent >= 0.75) status = 'yellow';
        else status = 'green';
        applyStatusClass(status);

        if (badgeEl) {
          if (overdue) {
            badgeEl.innerHTML = '<i class="bi bi-exclamation-triangle-fill"></i> ' +
              (finished ? 'Resolved late by ' : 'Overdue by ') + formatDuration(referenceTime - dueAt);
          } else if (status === 'yellow') {
            badgeEl.innerHTML = '<i class="bi bi-clock-history"></i> ' + (finished ? 'Resolved close to deadline' : 'Approaching SLA deadline');
          } else {
            badgeEl.innerHTML = '<i class="bi bi-check-circle"></i> ' + (finished ? 'Resolved within SLA' : 'On track');
          }
        }

        if (remainingEl) {
          if (!overdue && !finished) {
            remainingEl.classList.remove('d-none');
            remainingEl.textContent = 'Due in ' + formatDuration(dueAt - now);
          } else {
            remainingEl.classList.add('d-none');
          }
        }
      }

      tick();
      if (!finished) {
        setInterval(tick, 1000);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', initTicketTimers);
})();
