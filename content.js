(function () {
  'use strict';

  // ---- Safe messaging wrapper ----

  async function sendMessage(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      if (/context invalidated/i.test(err.message)) {
        console.warn('[BandTools] Extension context invalidated — refresh this page.');
        throw new Error('Extension was reloaded. Refresh the page.');
      }
      throw err;
    }
  }

  // ---- Auth, band detection & admin check ----

  sendMessage({ type: 'check_auth' }).catch(() => {});

  const bandMatch = location.pathname.match(/\/band\/(\d+)/);
  const bandNo = bandMatch ? Number(bandMatch[1]) : null;

  let isAdmin = false;
  let adminCheckDone = false;

  if (bandNo) {
    sendMessage({ type: 'band_no_detected', value: bandNo }).catch(() => {});
    chrome.storage.local.get('me_user_no', res => {
      if (!res.me_user_no) {
        sendMessage({ type: 'detect_me', band_no: bandNo }).catch(() => {});
      }
    });
    // Check admin status
    sendMessage({ type: 'check_admin', band_no: bandNo }).then(resp => {
      if (resp?.ok && resp.result) {
        isAdmin = true;
        adminCheckDone = true;
        // Schedule button injection now that we know admin status
        scheduleInjection();
      }
    }).catch(() => {
      adminCheckDone = true;
    });
  } else {
    adminCheckDone = true;
  }

  // ---- Duplicate button injection ----

  const BTN_CLASS = '_bt_dup_btn';
  // Stash the schedule ID when clicking a calendar grid event (needed for modal injection)
  let lastClickedSchedId = null;

  // Intercept clicks on calendar grid events to capture the schedule ID
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-scheduleid]');
    if (el) {
      lastClickedSchedId = el.getAttribute('data-scheduleid');
    }
  }, true);

  function scheduleInjection() {
    if (!bandNo || !isAdmin) return;
    try {
      injectOnTitles();
    } catch (_) {}
  }

  /** Inject ⧉ on event title elements (detail page + modal overlay) */
  function injectOnTitles() {
    const titles = document.querySelectorAll(
      'section.scheduleSectionArea h2.title, ' +
      'div.scheduleHead h2.title, ' +
      'div.cScheduleView h2.title'
    );
    for (const titleEl of titles) {
      if (titleEl.tagName === 'H1') continue;
      if (titleEl.querySelector(`.${BTN_CLASS}`)) continue;

      // Detail page: get ID from URL. Modal: use stashed ID from click interceptor.
      const inModal = titleEl.closest('.layerContainerView');
      const schedId = inModal
        ? lastClickedSchedId
        : extractSchedId(location.pathname);
      if (!schedId) continue;

      const btn = makeBtn(schedId, 'detail');
      titleEl.appendChild(document.createTextNode(' '));
      titleEl.appendChild(btn);
    }
  }

  function extractSchedId(href) {
    const m = href.match(/\/schedule\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function makeBtn(schedId, mode) {
    const btn = document.createElement('button');
    btn.className = BTN_CLASS;
    btn.title = 'Duplicate event';
    btn.textContent = '⧉';

    if (mode === 'detail') {
      Object.assign(btn.style, {
        background: '#f1f3f4', border: '1px solid #dadce0', borderRadius: '4px',
        cursor: 'pointer', fontSize: '14px', lineHeight: '1', padding: '3px 7px',
        marginLeft: '8px', color: '#555', verticalAlign: 'middle',
      });
      btn.addEventListener('mouseenter', () => { if (!btn.dataset.state) btn.style.background = '#e8eaed'; });
      btn.addEventListener('mouseleave', () => { if (!btn.dataset.state) btn.style.background = '#f1f3f4'; });
    } else {
      Object.assign(btn.style, {
        background: 'transparent', border: '1px solid transparent', borderRadius: '3px',
        cursor: 'pointer', fontSize: '11px', lineHeight: '1', padding: '1px 4px',
        marginLeft: '4px', color: '#bbb', verticalAlign: 'middle',
      });
      btn.addEventListener('mouseenter', () => {
        if (!btn.dataset.state) { btn.style.background = '#f1f3f4'; btn.style.borderColor = '#dadce0'; btn.style.color = '#555'; }
      });
      btn.addEventListener('mouseleave', () => {
        if (!btn.dataset.state) { btn.style.background = 'transparent'; btn.style.borderColor = 'transparent'; btn.style.color = '#bbb'; }
      });
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showDuplicateDialog(schedId);
    });

    return btn;
  }

  // ---- Duplicate configuration dialog ----

  function showDuplicateDialog(schedId) {
    // Remove any existing dialog
    const existing = document.getElementById('_bt_dialog');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = '_bt_dialog';
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
      background: 'rgba(0,0,0,0.5)', zIndex: '999999',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });

    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#fff', borderRadius: '8px', padding: '24px',
      minWidth: '420px', maxWidth: '520px', maxHeight: '90vh', overflowY: 'auto',
      boxShadow: '0 4px 24px rgba(0,0,0,0.2)', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      fontSize: '13px', color: '#222',
    });

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <strong style="font-size:15px">Duplicate Event</strong>
        <button id="_bt_dlg_close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#999;padding:0;line-height:1">×</button>
      </div>
      <div id="_bt_dlg_body">
        <p style="color:#888;font-style:italic">Loading event details…</p>
      </div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Close handlers
    const close = () => overlay.remove();
    card.querySelector('#_bt_dlg_close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });

    // Load schedule data
    loadAndRenderForm(schedId, card.querySelector('#_bt_dlg_body'), close, overlay);
  }

  async function loadAndRenderForm(schedId, bodyEl, close, overlay) {
    try {
      const resp = await sendMessage({ type: 'get_schedule', band_no: bandNo, schedule_id: schedId });
      if (!resp?.ok) throw new Error(resp?.error || 'Failed to load event');
      const sched = resp.result?.schedule || resp.result || {};

      // Compute original duration for smart end-time updates
      const origDurationMs = sched.start_at && sched.end_at
        ? new Date(sched.end_at) - new Date(sched.start_at) : 0;

      bodyEl.innerHTML = `
        <form id="_bt_dlg_form" style="display:flex;flex-direction:column;gap:8px" data-orig-dur="${origDurationMs}">
          <label style="font-size:11px;color:#888;font-weight:600">
            Source Event ID
            <input type="text" value="${escAttr(schedId)}" readonly style="width:100%;padding:5px 7px;border:1px solid #ddd;border-radius:4px;font-size:13px;background:#f5f5f5;color:#888">
          </label>
          <label style="font-size:11px;color:#888;font-weight:600">
            Name
            <input type="text" id="_bt_f_name" value="${escAttr(sched.name || '')}" style="width:100%;padding:5px 7px;border:1px solid #ccc;border-radius:4px;font-size:13px">
          </label>
          <div style="display:flex;gap:8px">
            <label style="flex:1;font-size:11px;color:#888;font-weight:600">
              Start At
              <input type="datetime-local" id="_bt_f_start" value="${escAttr(toDatetimeLocal(sched.start_at))}" style="width:100%;padding:5px 7px;border:1px solid #ccc;border-radius:4px;font-size:13px">
            </label>
            <label style="flex:1;font-size:11px;color:#888;font-weight:600">
              End At
              <input type="datetime-local" id="_bt_f_end" value="${escAttr(toDatetimeLocal(sched.end_at))}" style="width:100%;padding:5px 7px;border:1px solid #ccc;border-radius:4px;font-size:13px">
            </label>
          </div>
          <label style="font-size:11px;color:#888;font-weight:600">
            Description
            <textarea id="_bt_f_desc" rows="3" style="width:100%;padding:5px 7px;border:1px solid #ccc;border-radius:4px;font-size:13px;resize:vertical;font-family:inherit">${escAttr(sched.description || '')}</textarea>
          </label>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:4px;font-size:13px;color:#222;cursor:pointer">
              <input type="checkbox" id="_bt_f_copyLoc" checked> Copy location
            </label>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
            <button type="button" id="_bt_dlg_cancel" style="padding:6px 14px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#555;font-size:13px;cursor:pointer">Cancel</button>
            <button type="submit" style="padding:6px 14px;border:none;border-radius:4px;background:#1a73e8;color:#fff;font-size:13px;cursor:pointer;font-weight:600">Create Duplicate</button>
          </div>
        </form>
        <div id="_bt_dlg_result" style="margin-top:8px"></div>
      `;

      // Wire up smart end-time recalculation
      const startInput = bodyEl.querySelector('#_bt_f_start');
      const endInput = bodyEl.querySelector('#_bt_f_end');
      startInput.addEventListener('change', () => {
        if (!origDurationMs) return;
        const startVal = startInput.value;
        if (!startVal) return;
        const startDate = new Date(startVal);
        if (isNaN(startDate.getTime())) return;
        const endDate = new Date(startDate.getTime() + origDurationMs);
        const pad = (n) => String(n).padStart(2, '0');
        endInput.value = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;
      });

      // Wire up cancel and form submit
      bodyEl.querySelector('#_bt_dlg_cancel').addEventListener('click', close);
      bodyEl.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await doDuplicate(schedId, bodyEl, close);
      });

    } catch (err) {
      bodyEl.innerHTML = `<p style="color:#c62828">${escHtml(err.message)}</p>
        <button type="button" style="margin-top:8px;padding:6px 14px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer" onclick="this.closest('#_bt_dialog').remove()">Close</button>`;
    }
  }

  async function doDuplicate(schedId, bodyEl, close) {
    const resultEl = bodyEl.querySelector('#_bt_dlg_result');
    const form = bodyEl.querySelector('#_bt_dlg_form');
    const submitBtn = form.querySelector('button[type="submit"]');

    const overrides = {};
    const name = document.getElementById('_bt_f_name').value.trim();
    const start = document.getElementById('_bt_f_start').value.trim();
    const end = document.getElementById('_bt_f_end').value.trim();
    const desc = document.getElementById('_bt_f_desc').value.trim();
    const copyLoc = document.getElementById('_bt_f_copyLoc').checked;

    if (name) overrides.name = name;
    if (start) overrides.start_at = fromDatetimeLocal(start);
    if (end) overrides.end_at = fromDatetimeLocal(end);
    if (desc) overrides.description = desc;
    overrides.is_all_day = false;
    overrides.is_secret = true;
    if (!copyLoc) overrides.location = null;

    resultEl.innerHTML = '<p style="color:#555;font-style:italic">Creating duplicate…</p>';
    submitBtn.disabled = true;

    try {
      const resp = await sendMessage({
        type: 'copy_schedule',
        band_no: bandNo,
        source_schedule_id: schedId,
        overrides,
        announceable: false,
      });
      if (!resp?.ok) throw new Error(resp?.error || 'No response');
      const newId = resp.result?.schedule?.schedule_id || '(unknown)';
      const evUrl = `https://www.band.us/band/${bandNo}/schedule/${encodeURIComponent(newId)}`;
      window.location.href = evUrl;
    } catch (err) {
      resultEl.innerHTML = `<p style="color:#c62828">✗ ${escHtml(err.message)}</p>`;
      submitBtn.disabled = false;
    }
  }

  // ---- Utilities ----

  function formatDt(iso) {
    if (!iso) return '';
    return iso.replace('T', ' ').slice(0, 16);
  }

  /** Convert ISO 8601 to datetime-local format (YYYY-MM-DDTHH:MM) */
  function toDatetimeLocal(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return ''; }
  }

  /** Convert datetime-local value to UTC ISO 8601 with Z suffix */
  function fromDatetimeLocal(val) {
    if (!val) return '';
    // val is YYYY-MM-DDTHH:MM in local time — parse as local, convert to UTC
    try {
      const d = new Date(val);
      if (isNaN(d.getTime())) return val + ':00';
      return d.toISOString().replace('.000Z', 'Z');
    } catch { return val + ':00'; }
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- DOM observer (only runs after admin check) ----

  const observer = new MutationObserver(() => { scheduleInjection(); });
  observer.observe(document.body, { childList: true, subtree: true });

  // Periodic re-scan
  setInterval(() => { scheduleInjection(); }, 3000);

  // ---- SPA navigation ----
  let lastPath = location.pathname;
  const navObserver = new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      const m = location.pathname.match(/\/band\/(\d+)/);
      if (m) sendMessage({ type: 'band_no_detected', value: Number(m[1]) }).catch(() => {});
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });
})();