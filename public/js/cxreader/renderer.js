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
  async render(spineItem, containerEl, readerCss, fixedLayout = null) {
    // Tear down previous chapter
    this._cleanup();

    // Build rewritten HTML string
    const html = await this._buildHtml(spineItem, readerCss, fixedLayout);

    // Wrap in a blob so the iframe gets our origin (enables contentDocument access)
    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    this._srcBlobUrl = URL.createObjectURL(blob);

    const iframe = document.createElement('iframe');
    const pw = fixedLayout?.pageWidth, ph = fixedLayout?.pageHeight;
    if (pw > 0 && ph > 0) {
      const vw = containerEl.clientWidth  || window.innerWidth;
      const vh = containerEl.clientHeight || window.innerHeight;
      const scale = Math.min(vw / pw, vh / ph);
      const ml = Math.max(0, Math.round((vw - scale * pw) / 2));
      const mt = Math.max(0, Math.round((vh - scale * ph) / 2));
      iframe.style.cssText =
        `width:${pw}px;height:${ph}px;border:none;display:block;position:absolute;` +
        `transform:scale(${scale.toFixed(6)});transform-origin:top left;` +
        `left:${ml}px;top:${mt}px;`;
    } else {
      iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;background:transparent;';
    }
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

  async _buildHtml(spineItem, readerCss, fixedLayout = null) {
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

    // Rewrite element resource attributes to blob (or data: on legacy WebViews) URLs
    await this._rewriteElements(doc, chapterBase);

    // Inject reader CSS last so it wins over book styles.
    // Fixed-layout pages use the book's own precise CSS — skip injection to preserve layout.
    // Split at the marker into two elements: cx-reader-fonts holds @font-face declarations
    // and is never replaced on reapplyCss, avoiding FOUT on every settings toggle.
    if (!fixedLayout) {
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
    }

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

  async _rewriteElements(doc, base) {
    // Old WebViews (~Chrome <84) often fail to load a parent-created blob: resource
    // from inside a blob: iframe document, so book images never appear. There we
    // inline images as self-contained data: URIs instead, which always resolve.
    const legacy = this._isLegacyWebView();

    // Resolve a raw attribute value to a usable URL (blob, or data: on legacy).
    const urlFor = async (rawVal) => {
      if (!rawVal || /^(blob:|data:|https?:|#)/.test(rawVal)) return null;
      const blobUrl = this._blobFor(this._resolve(rawVal.split('#')[0], base));
      if (!blobUrl) return null;
      if (!legacy) return blobUrl;
      return (await this._toDataUrl(blobUrl)) || blobUrl;
    };

    for (const el of doc.querySelectorAll('img')) {
      el.removeAttribute('srcset');    // srcset needs complex rewrite — skip
      const u = await urlFor(el.getAttribute('src'));
      if (u) el.setAttribute('src', u);
    }
    // SVG-wrapped images (common for full-page chapter art). Old WebViews ignore the
    // SVG2 plain `href`, so the URL must also be set as xlink:href in its namespace.
    for (const el of doc.querySelectorAll('image')) {
      const u = await urlFor(el.getAttribute('href') || el.getAttribute('xlink:href'));
      if (u) {
        el.setAttribute('href', u);
        try { el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u); }
        catch { el.setAttribute('xlink:href', u); }
      }
    }
    // Media stays on blob URLs (data: URIs would be prohibitively large).
    const sub = (el, attr) => {
      const val = el.getAttribute(attr);
      if (!val || /^(blob:|data:|https?:|#)/.test(val)) return;
      const url = this._blobFor(this._resolve(val.split('#')[0], base));
      if (url) el.setAttribute(attr, url);
    };
    doc.querySelectorAll('video[src],audio[src]').forEach(el => sub(el, 'src'));
    doc.querySelectorAll('source[src]').forEach(el => sub(el, 'src'));
  }

  // True on the old Android WebViews flagged by the flex-gap probe in readerv4.html.
  _isLegacyWebView() {
    try { return document.documentElement.classList.contains('no-flexgap'); }
    catch { return false; }
  }

  // Fetch a (parent-origin) blob URL and convert it to a data: URI. Runs in the parent
  // document where the blob is accessible, so the result is safe to embed in the iframe.
  async _toDataUrl(blobUrl) {
    try {
      const blob = await fetch(blobUrl).then(r => r.blob());
      return await new Promise(resolve => {
        const fr = new FileReader();
        fr.onload  = () => resolve(fr.result);
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      });
    } catch { return null; }
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

  // Resolve a chapter-relative href to an absolute ZIP entry path (no leading slash),
  // matching EpubParser._resolve exactly. Must NOT use new URL() with the epub: scheme —
  // old WebViews mis-parse non-special schemes (e.g. produce "//EPUB/…"), so the path
  // never matches the manifest and images/resources silently fail to resolve.
  _resolve(href, base) {
    const clean = href.split('#')[0].split('?')[0];
    if (!clean) return '';
    if (clean.startsWith('/')) return this._normalizePath(clean.replace(/^\/+/, ''));
    return this._normalizePath(base + clean);
  }

  // Collapse . and .. segments and drop leading empty segments from a double-slash.
  _normalizePath(path) {
    const out = [];
    for (const p of path.split('/')) {
      if (p === '..') { if (out.length) out.pop(); }
      else if (p !== '.') out.push(p);
    }
    while (out.length && out[0] === '') out.shift();
    return out.join('/');
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
