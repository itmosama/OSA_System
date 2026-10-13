(function () {
  document.addEventListener('DOMContentLoaded', () => {
    let modalEl = document.getElementById('deleteReasonModal');
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.className = 'modal fade';
      modalEl.id = 'deleteReasonModal';
      modalEl.tabIndex = -1;
      modalEl.innerHTML = `
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-exclamation-triangle-fill text-danger"></i> Confirm Delete</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <p>Are you sure you want to delete <strong class="delete-reason-label"></strong>? This cannot be undone.</p>
              <label class="form-label small">Reason for deletion <span class="text-danger">*</span></label>
              <textarea class="form-control delete-reason-input" rows="3" placeholder="Why are you deleting this?" required></textarea>
              <div class="text-danger small mt-1 d-none delete-reason-error">Please enter a reason.</div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-danger delete-reason-confirm"><i class="bi bi-trash"></i> Delete</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(modalEl);
    }

    const labelEl = modalEl.querySelector('.delete-reason-label');
    const inputEl = modalEl.querySelector('.delete-reason-input');
    const errorEl = modalEl.querySelector('.delete-reason-error');
    const confirmBtn = modalEl.querySelector('.delete-reason-confirm');
    let pendingForm = null;

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-delete-btn');
      if (!btn) return;
      e.preventDefault();

      const formId = btn.dataset.form;
      pendingForm = formId ? document.getElementById(formId) : btn.closest('form');
      if (!pendingForm) return;

      labelEl.textContent = btn.dataset.label || 'this item';
      inputEl.value = '';
      errorEl.classList.add('d-none');

      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      modal.show();
      setTimeout(() => inputEl.focus(), 300);
    });

    confirmBtn.addEventListener('click', () => {
      const reason = inputEl.value.trim();
      if (!reason) {
        errorEl.classList.remove('d-none');
        inputEl.focus();
        return;
      }
      if (!pendingForm) return;

      let reasonField = pendingForm.querySelector('input[name="reason"]');
      if (!reasonField) {
        reasonField = document.createElement('input');
        reasonField.type = 'hidden';
        reasonField.name = 'reason';
        pendingForm.appendChild(reasonField);
      }
      reasonField.value = reason;
      pendingForm.submit();
    });
  });
})();
