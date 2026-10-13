(function () {
  function formatNow() {
    const now = new Date();
    return now.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  }

  function tick() {
    const text = formatNow();
    const el = document.getElementById('liveClock');
    if (el) el.textContent = text;
    const elMobile = document.getElementById('liveClockMobile');
    if (elMobile) elMobile.textContent = text;
  }

  // ---- calendar pop-up (same glass style as the top bar) ----
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  let panel = null;
  let shown = new Date(); // month being shown
  let anchorEl = null;

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function render() {
    const today = new Date();
    const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const cls = ['osa-cal-day'];
      if (d.getMonth() !== shown.getMonth()) cls.push('osa-cal-out');
      if (sameDay(d, today)) cls.push('osa-cal-today');
      cells += '<span class="' + cls.join(' ') + '">' + d.getDate() + '</span>';
    }
    panel.innerHTML =
      '<div class="osa-cal-head">' +
        '<button type="button" class="osa-cal-nav" data-step="-1" aria-label="Previous month"><i class="bi bi-chevron-left"></i></button>' +
        '<div class="osa-cal-title">' + MONTHS[shown.getMonth()] + ' ' + shown.getFullYear() + '</div>' +
        '<button type="button" class="osa-cal-nav" data-step="1" aria-label="Next month"><i class="bi bi-chevron-right"></i></button>' +
      '</div>' +
      '<div class="osa-cal-grid osa-cal-dow">' + DAYS.map(function (d) { return '<span>' + d + '</span>'; }).join('') + '</div>' +
      '<div class="osa-cal-grid">' + cells + '</div>' +
      '<div class="osa-cal-foot"><button type="button" class="osa-cal-today-btn">Today</button></div>';
  }

  function position() {
    if (!anchorEl || !panel) return;
    const r = anchorEl.getBoundingClientRect();
    const w = panel.offsetWidth || 290;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    panel.style.left = left + 'px';
    panel.style.top = (r.bottom + 12) + 'px';
  }

  function closeCalendar() {
    if (panel) panel.hidden = true;
  }

  function openCalendar(anchor) {
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'osa-cal';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Calendar');
      document.body.appendChild(panel);
      panel.addEventListener('click', function (e) {
        const nav = e.target.closest('.osa-cal-nav');
        if (nav) {
          shown = new Date(shown.getFullYear(), shown.getMonth() + Number(nav.getAttribute('data-step')), 1);
          render();
        } else if (e.target.closest('.osa-cal-today-btn')) {
          shown = new Date();
          render();
        }
      });
    }
    if (!panel.hidden && anchorEl === anchor) { closeCalendar(); return; }
    anchorEl = anchor;
    shown = new Date();
    render();
    panel.hidden = false;
    position();
  }

  document.addEventListener('click', function (e) {
    if (!panel || panel.hidden) return;
    if (panel.contains(e.target) || (anchorEl && anchorEl.contains(e.target))) return;
    const trigger = e.target.closest('#liveClock, #navDateInput, #liveClockMobile');
    if (trigger) return; // its own handler decides
    closeCalendar();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCalendar(); });
  window.addEventListener('resize', position);

  document.addEventListener('DOMContentLoaded', () => {
    tick();
    // Only the date is shown, so once a minute is plenty to catch the day rolling over.
    setInterval(tick, 60000);

    // Desktop: the invisible input laid over the clock is now just a click target.
    // It is turned into a plain text field so the browser's own calendar never opens.
    const desktopInput = document.getElementById('navDateInput');
    const clockEl = document.getElementById('liveClock');
    if (desktopInput) {
      desktopInput.type = 'text';
      desktopInput.readOnly = true;
      desktopInput.addEventListener('click', () => openCalendar(clockEl || desktopInput));
    }

    // Small screens: the date is a line inside the account menu.
    const elMobile = document.getElementById('liveClockMobile');
    const mobileInput = document.getElementById('navDateInputMobile');
    if (mobileInput) mobileInput.type = 'text';
    if (elMobile) {
      elMobile.addEventListener('click', (e) => {
        e.stopPropagation();
        openCalendar(elMobile.closest('.dropdown') || elMobile);
      });
    }
  });
})();
