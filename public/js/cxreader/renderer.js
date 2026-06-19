// CXReader — Chapter Renderer
// Renders a spine item into an iframe inside containerEl.
// Resource URLs (images, CSS) are rewritten to blob URLs from the manifest.

export class ChapterRenderer {
  constructor(manifest) {
    this._manifest = manifest;   // Map<id, {absPath, blobUrl, ...}> from EpubParser
    this._iframe   = null;
    this._srcBlobUrl = null;     // blob URL of the rendered HTML (for cleanup)
  }

  // Render spineItem into containerEl with readerCss injected.
  // Returns the live iframe element; DOM is fully painted when this resolves.
  async render(spineItem, containerEl, readerCss) {
    // Tear down previous chapter
    this._cleanup();

    // Build rewritten HTML string
    const html = await this._buildHtml(spineItem, readerCss);

    // Wrap in a blob so the iframe gets our origin (enables contentDocument access)
    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    this._srcBlobUrl = URL.createObjectURL(blob);

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;background:transparent;';
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    containerEl.appendChild(iframe);
    this._iframe = iframe;

    // Attach load listener BEFORE setting src
    await this._waitForLoad(iframe);

    return iframe;
  }

  get iframe() { return this._iframe; }

  destroy() { this._cleanup(); }

  // ── Private ───────────────────────────────────────────────────────────────────

  _cleanup() {
    if (this._iframe) { this._iframe.remove(); this._iframe = null; }
    if (this._srcBlobUrl) { URL.revokeObjectURL(this._srcBlobUrl); this._srcBlobUrl = null; }
  }

  async _buildHtml(spineItem, readerCss) {
    // Fetch chapter source via blob URL
    const raw = await fetch(spineItem.blobUrl).then(r => r.text());

    // Parse as HTML (handles both HTML5 and XHTML spine items)
    const doc = new DOMParser().parseFromString(raw, 'text/html');

    // Remove any <base> tags — we resolve URLs ourselves
    doc.querySelectorAll('base').forEach(el => el.remove());

    const chapterBase = spineItem.absPath.includes('/')
      ? spineItem.absPath.slice(0, spineItem.absPath.lastIndexOf('/') + 1)
      : '';

    // Inline stylesheets (fetch CSS text, rewrite url() refs, inject as <style>)
    const linkEls = [...doc.querySelectorAll('link[rel="stylesheet"]')];
    for (const link of linkEls) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const absPath = this._resolve(href, chapterBase);
      const blobUrl = this._blobFor(absPath);
      if (!blobUrl) continue;
      try {
        const cssText  = await fetch(blobUrl).then(r => r.text());
        const rewritten = this._rewriteCssUrls(cssText, absPath);
        const style = doc.createElement('style');
        style.textContent = rewritten;
        link.replaceWith(style);
      } catch { link.remove(); }
    }

    // Rewrite element resource attributes to blob URLs
    this._rewriteElements(doc, chapterBase);

    // Inject reader CSS last so it wins over book styles.
    // Split at the marker into two elements: cx-reader-fonts holds @font-face declarations
    // and is never replaced on reapplyCss, avoiding FOUT on every settings toggle.
    const CX_FONTS_MARKER = '/* cx-fonts-end */';
    const markerIdx = readerCss.indexOf(CX_FONTS_MARKER);
    const fontsCss = markerIdx >= 0 ? readerCss.slice(0, markerIdx) : '';
    const prefsCss = markerIdx >= 0 ? readerCss.slice(markerIdx + CX_FONTS_MARKER.length) : readerCss;
    const fontsStyle = doc.createElement('style');
    fontsStyle.id = 'cx-reader-fonts';
    fontsStyle.textContent = fontsCss;
    doc.head.appendChild(fontsStyle);
    const readerStyle = doc.createElement('style');
    readerStyle.id = 'cx-reader-css';
    readerStyle.textContent = prefsCss;
    doc.head.appendChild(readerStyle);

    // Intercept in-book link clicks — post href to parent so CXReader can navigate.
    // Without this, clicking <a href="chapter.xhtml"> navigates the iframe to a
    // blob-unresolvable URL and the browser blocks it with about:blank#blocked.
    const linkScript = doc.createElement('script');
    linkScript.textContent = `document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest&&e.target.closest('a[href]');
  if(!a)return;
  var h=a.getAttribute('href');
  if(!h||h.charAt(0)==='#'||h.indexOf('javascript:')===0)return;
  e.preventDefault();e.stopPropagation();
  try{window.parent.postMessage({type:'cx-link',href:h},'*');}catch(ex){}
},true);`;
    doc.body.appendChild(linkScript);

    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  }

  _rewriteElements(doc, base) {
    const sub = (el, attr) => {
      const val = el.getAttribute(attr);
      if (!val || /^(blob:|data:|https?:|#)/.test(val)) return;
      const url = this._blobFor(this._resolve(val.split('#')[0], base));
      if (url) el.setAttribute(attr, url);
    };

    doc.querySelectorAll('img').forEach(el => {
      sub(el, 'src');
      el.removeAttribute('srcset');    // srcset needs complex rewrite — skip
    });
    doc.querySelectorAll('image').forEach(el => {
      sub(el, 'href');
      sub(el, 'xlink:href');
    });
    doc.querySelectorAll('video[src],audio[src]').forEach(el => sub(el, 'src'));
    doc.querySelectorAll('source[src]').forEach(el => sub(el, 'src'));
  }

  _rewriteCssUrls(cssText, cssAbsPath) {
    const cssBase = cssAbsPath.includes('/')
      ? cssAbsPath.slice(0, cssAbsPath.lastIndexOf('/') + 1)
      : '';
    return cssText.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, href) => {
      if (/^(data:|blob:|https?:)/.test(href)) return match;
      const url = this._blobFor(this._resolve(href, cssBase));
      return url ? `url("${url}")` : match;
    });
  }

  _resolve(href, base) {
    const clean = href.split('#')[0].split('?')[0];
    if (!clean) return '';
    try {
      return new URL(clean, 'epub:///' + base).pathname.slice(1);
    } catch {
      return base + clean;
    }
  }

  _blobFor(absPath) {
    if (!absPath) return null;
    for (const item of this._manifest.values()) {
      if (item.absPath === absPath) return item.blobUrl;
    }
    return null;
  }

  _waitForLoad(iframe) {
    return new Promise(resolve => {
      const timeout = setTimeout(resolve, 15000);
      iframe.addEventListener('load', () => {
        const doc = iframe.contentDocument;
        if (!doc) { clearTimeout(timeout); resolve(); return; }
        const pending = [...doc.querySelectorAll('img')].filter(img => !img.complete);
        if (!pending.length) { clearTimeout(timeout); resolve(); return; }
        let remaining = pending.length;
        const done = () => { if (--remaining <= 0) { clearTimeout(timeout); resolve(); } };
        pending.forEach(img => {
          img.addEventListener('load',  done, { once: true });
          img.addEventListener('error', done, { once: true });
        });
      }, { once: true });
      iframe.src = this._srcBlobUrl;
    });
  }
}
