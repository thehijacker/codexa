// CXReader — in-book link-click interceptor.
// Injected into every rendered chapter iframe as an external <script src> (see renderer.js's
// _buildHtml) rather than inlined into the generated HTML — the app's CSP intentionally does
// NOT allow inline/nonce'd scripts inside book content (book HTML is untrusted, see
// _sanitizeDoc in renderer.js), only same-origin script files. Runs inside the chapter iframe
// itself, so `document` here is the book's document and `window.parent` is the reader page.
//
// Without this, clicking <a href="chapter.xhtml"> tries to navigate the iframe to a path that
// doesn't resolve against a blob: document (there's no real "chapter.xhtml" URL) and the
// browser just blocks it (about:blank#blocked) instead of letting CXReader handle the jump.
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  var h = a.getAttribute('href');
  if (!h || h.charAt(0) === '#' || h.indexOf('javascript:') === 0) return;
  e.preventDefault();
  e.stopPropagation();
  try { window.parent.postMessage({ type: 'cx-link', href: h }, '*'); } catch (ex) { /* ignore */ }
}, true);
