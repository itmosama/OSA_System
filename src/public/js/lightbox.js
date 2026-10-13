(function () {
  document.addEventListener('DOMContentLoaded', () => {
    let overlay = document.querySelector('.lightbox-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'lightbox-overlay';
      overlay.innerHTML = '<button type="button" class="lightbox-close" aria-label="Close">&times;</button><img alt="Photo preview">';
      document.body.appendChild(overlay);
    }
    const img = overlay.querySelector('img');

    function open(src) {
      img.src = src;
      overlay.classList.add('open');
    }
    function close() {
      overlay.classList.remove('open');
      img.src = '';
    }

    document.addEventListener('click', (e) => {
      const thumb = e.target.closest('.photo-thumb');
      if (thumb) {
        e.preventDefault();
        open(thumb.dataset.fullSrc || thumb.src);
      } else if (e.target === overlay || e.target.closest('.lightbox-close')) {
        close();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  });
})();
