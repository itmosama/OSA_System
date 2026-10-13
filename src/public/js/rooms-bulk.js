(function () {
  const fields = Array.from(document.querySelectorAll('.room-field'));
  const saveBtn = document.getElementById('saveAllRooms');
  const msg = document.getElementById('roomsDirtyMsg');
  const alertBox = document.getElementById('roomsSaveAlert');
  if (!fields.length || !saveBtn) return;

  let skipLeaveWarning = false;

  function changedRoomIds() {
    const ids = new Set();
    fields.forEach(f => { if (f.value !== f.dataset.original) ids.add(f.dataset.roomId); });
    return ids;
  }

  function refresh() {
    const ids = changedRoomIds();
    document.querySelectorAll('tr[data-room-id]').forEach(tr => {
      tr.classList.toggle('table-warning', ids.has(tr.dataset.roomId));
    });
    saveBtn.disabled = ids.size === 0;
    saveBtn.innerHTML = '<i class="bi bi-save"></i> Save All Changes' + (ids.size ? ` (${ids.size})` : '');
    msg.textContent = ids.size
      ? `${ids.size} room${ids.size === 1 ? '' : 's'} edited — not saved yet`
      : 'No unsaved changes';
  }

  function showAlert(kind, text) {
    alertBox.innerHTML = `<div class="alert alert-${kind} py-2 mb-2">${text}</div>`;
    if (kind === 'success') setTimeout(() => { alertBox.innerHTML = ''; }, 4000);
  }

  function roomPayload(id) {
    const row = { id };
    fields.filter(f => f.dataset.roomId === id).forEach(f => { row[f.dataset.field] = f.value.trim(); });
    return row;
  }

  saveBtn.addEventListener('click', async () => {
    const ids = Array.from(changedRoomIds());
    if (!ids.length) return;

    const blank = ids.find(id => !roomPayload(id).number);
    if (blank) {
      showAlert('danger', 'A room number cannot be empty.');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
    try {
      const res = await fetch('/admin/rooms/bulk-edit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rooms: ids.map(roomPayload) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showAlert('danger', data.error || 'Could not save the changes. Nothing was saved.');
        refresh();
        return;
      }
      // Saved: the current values become the new baseline.
      fields.filter(f => ids.includes(f.dataset.roomId)).forEach(f => {
        if (f.tagName === 'INPUT') f.value = f.value.trim();
        f.dataset.original = f.value;
      });
      showAlert('success', `Saved ${data.saved} room${data.saved === 1 ? '' : 's'}.`);
    } catch (e) {
      showAlert('danger', 'Could not reach the server. Nothing was saved.');
    }
    refresh();
  });

  fields.forEach(f => {
    f.addEventListener('input', refresh);
    f.addEventListener('change', refresh);
  });

  // Submitting any row's own ✓ button (or adding/bulk-adding) is a deliberate
  // navigation, so don't nag about unsaved edits in that case.
  document.addEventListener('submit', () => { skipLeaveWarning = true; }, true);
  window.addEventListener('beforeunload', (e) => {
    if (!skipLeaveWarning && changedRoomIds().size) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  refresh();
})();
