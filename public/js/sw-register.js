// Service worker registration — network-first updates, reload when a new version activates.
(function () {
  if (!('serviceWorker' in navigator)) return;

  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  function checkForUpdates(reg) {
    try { reg.update(); } catch { /* ignore */ }
  }

  navigator.serviceWorker.register('/sw.js')
    .then((reg) => {
      checkForUpdates(reg);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdates(reg);
      });
      window.addEventListener('focus', () => checkForUpdates(reg));
    })
    .catch(() => {});
})();
