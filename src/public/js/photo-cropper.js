// Crop + resize a chosen photo in the browser before it is uploaded.
// Any <input type="file" data-crop-photo> opens the cropper; the cropped square
// (400 x 400 JPEG) replaces the chosen file. Add data-autosubmit to send the
// form straight away afterwards.
(function () {
  var OUT = 400;      // saved size in pixels
  var STAGE = 320;    // size of the crop area on screen

  var modalEl, modal, canvas, ctx, zoomEl, useBtn, errEl, nameEl;
  var state = null;   // { input, img, base, zoom, ox, oy, fileName }
  var busy = false;

  function build() {
    if (modalEl) return;
    modalEl = document.createElement('div');
    modalEl.className = 'modal fade';
    modalEl.tabIndex = -1;
    modalEl.innerHTML =
      '<div class="modal-dialog modal-dialog-centered" style="max-width:400px">' +
        '<div class="modal-content">' +
          '<div class="modal-header py-2"><h6 class="modal-title"><i class="bi bi-crop"></i> Crop photo</h6>' +
            '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>' +
          '<div class="modal-body text-center">' +
            '<div class="osa-crop-stage"><canvas width="' + STAGE + '" height="' + STAGE + '"></canvas><div class="osa-crop-ring"></div></div>' +
            '<div class="small text-muted mt-2">Drag the picture to position it. Use the slider to zoom.</div>' +
            '<div class="d-flex align-items-center gap-2 mt-2 px-3">' +
              '<i class="bi bi-image"></i>' +
              '<input type="range" class="form-range" min="1" max="4" step="0.01" value="1" data-zoom>' +
              '<i class="bi bi-image-fill fs-5"></i>' +
            '</div>' +
            '<div class="text-danger small mt-2" data-err hidden></div>' +
          '</div>' +
          '<div class="modal-footer py-2">' +
            '<button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Cancel</button>' +
            '<button type="button" class="btn btn-primary btn-sm" data-use><i class="bi bi-check-lg"></i> Use this photo</button>' +
          '</div>' +
        '</div></div>';
    document.body.appendChild(modalEl);
    canvas = modalEl.querySelector('canvas');
    ctx = canvas.getContext('2d');
    zoomEl = modalEl.querySelector('[data-zoom]');
    useBtn = modalEl.querySelector('[data-use]');
    errEl = modalEl.querySelector('[data-err]');
    modal = new bootstrap.Modal(modalEl);

    zoomEl.addEventListener('input', function () { setZoom(parseFloat(zoomEl.value)); });
    useBtn.addEventListener('click', confirm);
    modalEl.addEventListener('hidden.bs.modal', function () {
      // closed without confirming: forget the chosen file
      if (state && !state.done) { try { state.input.value = ''; } catch (e) {} }
      if (state && state.img && state.img.src) URL.revokeObjectURL(state.img.src);
      state = null;
    });

    var drag = null;
    canvas.addEventListener('pointerdown', function (e) {
      if (!state) return;
      drag = { x: e.clientX, y: e.clientY, ox: state.ox, oy: state.oy };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag || !state) return;
      var k = STAGE / canvas.getBoundingClientRect().width;
      state.ox = drag.ox + (e.clientX - drag.x) * k;
      state.oy = drag.oy + (e.clientY - drag.y) * k;
      clamp(); draw();
    });
    function end() { drag = null; }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', function (e) {
      if (!state) return;
      e.preventDefault();
      setZoom(Math.min(4, Math.max(1, state.zoom + (e.deltaY < 0 ? 0.1 : -0.1))));
    }, { passive: false });
  }

  function scale() { return state.base * state.zoom; }

  function clamp() {
    var w = state.img.width * scale(), h = state.img.height * scale();
    var minX = STAGE - w, minY = STAGE - h;
    state.ox = Math.min(0, Math.max(minX, state.ox));
    state.oy = Math.min(0, Math.max(minY, state.oy));
  }

  function setZoom(z) {
    // keep the centre of the crop area where it is while zooming
    var cx = (STAGE / 2 - state.ox) / scale();
    var cy = (STAGE / 2 - state.oy) / scale();
    state.zoom = z;
    zoomEl.value = String(z);
    state.ox = STAGE / 2 - cx * scale();
    state.oy = STAGE / 2 - cy * scale();
    clamp(); draw();
  }

  function draw() {
    ctx.fillStyle = '#f1f3f5';
    ctx.fillRect(0, 0, STAGE, STAGE);
    ctx.drawImage(state.img, state.ox, state.oy, state.img.width * scale(), state.img.height * scale());
  }

  function confirm() {
    if (!state || busy) return;
    busy = true;
    var out = document.createElement('canvas');
    out.width = OUT; out.height = OUT;
    var k = OUT / STAGE;
    var c = out.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, OUT, OUT);
    c.imageSmoothingQuality = 'high';
    c.drawImage(state.img, state.ox * k, state.oy * k, state.img.width * scale() * k, state.img.height * scale() * k);
    out.toBlob(function (blob) {
      busy = false;
      if (!blob) { errEl.textContent = 'Could not prepare the photo. Please try another picture.'; errEl.hidden = false; return; }
      var base = (state.fileName || 'photo').replace(/\.[^.]+$/, '');
      var file = new File([blob], base + '.jpg', { type: 'image/jpeg' });
      var dt = new DataTransfer();
      dt.items.add(file);
      state.input.files = dt.files;
      state.input.setAttribute('data-cropped', '1');
      state.input.dispatchEvent(new CustomEvent('osa-photo-cropped', { bubbles: true }));
      state.done = true;
      var input = state.input;
      modal.hide();
      if (input.hasAttribute('data-autosubmit') && input.form) input.form.submit();
    }, 'image/jpeg', 0.88);
  }

  function open(input, file) {
    build();
    errEl.hidden = true;
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      state = { input: input, img: img, fileName: file.name, zoom: 1, ox: 0, oy: 0, done: false };
      state.base = Math.max(STAGE / img.width, STAGE / img.height); // fill the square
      state.ox = (STAGE - img.width * state.base) / 2;
      state.oy = (STAGE - img.height * state.base) / 2;
      zoomEl.value = '1';
      draw();
      modal.show();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      // a format the browser cannot draw (for example HEIC): upload the original instead
      if (input.hasAttribute('data-autosubmit') && input.form) input.form.submit();
    };
    img.src = url;
  }

  document.addEventListener('change', function (e) {
    var input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.hasAttribute('data-crop-photo')) return;
    if (input.getAttribute('data-cropped') === '1') { input.removeAttribute('data-cropped'); return; }
    var file = input.files && input.files[0];
    if (!file || !/^image\//.test(file.type)) return;
    e.stopImmediatePropagation();
    open(input, file);
  }, true);
})();
