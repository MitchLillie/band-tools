chrome.runtime.sendMessage({ type: 'check_auth' }, resp => {
  if (!resp || !resp.ok) {
    console.warn('[BandTools] auth FAIL —', resp ? resp.error : 'no response');
  }
});

// Extract band_no from URL and send to background
const bandMatch = location.pathname.match(/\/band\/(\d+)/);
const bandNo = bandMatch ? Number(bandMatch[1]) : null;

if (bandNo) {
  chrome.runtime.sendMessage({ type: 'band_no_detected', value: bandNo });

  // Auto-detect current user's user_no via API
  chrome.storage.local.get('me_user_no', res => {
    if (!res.me_user_no) {
      chrome.runtime.sendMessage({ type: 'detect_me', band_no: bandNo }, resp => {
        if (resp?.ok && resp.result?.user_no) {
          console.log('[BandTools] detected me:', resp.result.user_no, resp.result.name);
        }
      });
    }
  });
}

// Also listen for SPA navigation
let lastPath = location.pathname;
const observer = new MutationObserver(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    const m = location.pathname.match(/\/band\/(\d+)/);
    if (m) chrome.runtime.sendMessage({ type: 'band_no_detected', value: Number(m[1]) });
  }
});
observer.observe(document.body, { childList: true, subtree: true });
