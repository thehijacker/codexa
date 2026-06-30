// Centralised logging context. Patches console.* so every line is prefixed with a local
// timestamp and the current user (when known). The user is carried per-request and per
// background job via AsyncLocalStorage, so existing console.log/warn/error calls are tagged
// automatically without changing each call site.
const { AsyncLocalStorage } = require('node:async_hooks');

const userStore = new AsyncLocalStorage();

// Run `fn` with `username` attached to the current async context. Any console.* call made
// while it (and anything it awaits) executes is tagged with that user.
function runWithUser(username, fn) {
  return userStore.run({ username }, fn);
}

function currentUsername() {
  return userStore.getStore()?.username || null;
}

// Local server time, e.g. "2026-06-30 14:23:01".
function localTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let _installed = false;
// Prepend "[timestamp] [user]" to every console line. Idempotent.
function installConsolePrefix() {
  if (_installed) return;
  _installed = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(`[${localTimestamp()}] [${currentUsername() || '-'}]`, ...args);
    };
  }
}

module.exports = { runWithUser, currentUsername, localTimestamp, installConsolePrefix };
