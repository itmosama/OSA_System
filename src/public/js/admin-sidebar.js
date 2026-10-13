(function () {
  document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('adminSidebar');
    if (!sidebar) return;

    // The menu starts closed (icons only). Clicking any empty space on it opens or
    // closes it, and it stays that way on every page until clicked again.
    sidebar.addEventListener('click', (event) => {
      if (event.target.closest('a, button')) return;
      const open = !sidebar.classList.toggle('collapsed');
      try { localStorage.setItem('osaAdminMenuOpen', open ? '1' : '0'); } catch (e) { /* private browsing */ }
    });

    // Phone layout: the menu is folded away until the button is tapped.
    const mobileBtn = document.getElementById('adminSidebarMobileToggle');
    if (mobileBtn) {
      mobileBtn.addEventListener('click', () => {
        const open = sidebar.classList.toggle('mobile-open');
        mobileBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
  });
})();
