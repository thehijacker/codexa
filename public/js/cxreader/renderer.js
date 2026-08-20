// CXReader — Chapter Renderer
// Renders a spine item into an iframe inside containerEl.
// Resource URLs (images, CSS) are rewritten to blob URLs from the manifest.
import { warn } from '../logger.js';
import { stripImageWhiteBackgrounds } from '../img-bg-fix.js';

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

    // Parse as HTML (handles both HTML5 and XHTML spine items). Reassigned below (e-ink
    // only) to a live document if the pre-render white-background pass runs.
    let doc = new DOMParser().parseFromString(this._xhtmlToHtml(raw), 'text/html');

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
        const rewritten = this._clampLargeMargins(this._rewriteCssUrls(cssText, absPath));
        const style = doc.createElement('style');
        style.textContent = rewritten;
        link.replaceWith(style);
      } catch { link.remove(); }
    }
    // Inline <style> blocks (no url()s to resolve, but can carry the same margin issue)
    for (const styleEl of [...doc.querySelectorAll('style')]) {
      styleEl.textContent = this._clampLargeMargins(styleEl.textContent);
    }

    // Rewrite element resource attributes to blob (or data: on legacy WebViews) URLs
    await this._rewriteElements(doc, chapterBase);

    // stripImageWhiteBackgrounds (img-bg-fix.js) needs getComputedStyle to see the book's
    // own background-image CSS, which needs a live document with a window/layout — `doc`
    // here is a detached DOMParser document, and by definition this must run BEFORE
    // readerCss (added just below) is present, since on e-ink themes readerCss carries a
    // blanket `body * { background-image: none !important }` reset that would otherwise
    // make every candidate's computed style read back "none" (see the top-of-file comment
    // in img-bg-fix.js — confirmed live on a Boox Palma 2, where e-ink is the device's
    // saved default, so every chapter's very first render already has this problem; it's
    // not something a live post-render pass in reader.js can ever recover from once it's
    // baked into the HTML like that). So for e-ink chapters only, briefly attach the
    // in-progress document to a hidden throwaway iframe just to run detection with a real
    // layout engine, then keep working with THAT iframe's live document as `doc` for the
    // rest of this function — cheaper and far less invasive than hand-rolling a
    // getComputedStyle-free CSS-rule matcher. Skipped for fixed-layout pages, which never
    // get readerCss injected at all (see the `if (!fixedLayout)` block below) and so were
    // never affected by this in the first place.
    let tmpIframe = null;
    if (!fixedLayout && readerCss.includes('e-ink mode: strip all colours')) {
      let tmpUrl = null;
      try {
        tmpUrl = URL.createObjectURL(new Blob(
          ['<!DOCTYPE html>' + doc.documentElement.outerHTML], { type: 'text/html; charset=utf-8' }));
        tmpIframe = document.createElement('iframe');
        tmpIframe.setAttribute('sandbox', 'allow-same-origin');
        // Off-screen but real dimensions — a zero-size iframe can skip layout on some
        // engines, which would defeat the whole point of using a live document here.
        tmpIframe.style.cssText = 'position:fixed; left:-9999px; top:0; width:800px; height:1200px; border:none;';
        document.body.appendChild(tmpIframe);
        await new Promise((resolve, reject) => {
          tmpIframe.addEventListener('load', resolve, { once: true });
          tmpIframe.addEventListener('error', reject, { once: true });
          tmpIframe.src = tmpUrl;
        });
        // MUST await: the knockout work (image loads, canvas processing) is async, and
        // this function serializes doc.documentElement.outerHTML right after returning —
        // an un-awaited call here would silently lose the fix for anything not already
        // cached (see the Promise doc-comment on stripImageWhiteBackgrounds).
        await stripImageWhiteBackgrounds(tmpIframe.contentDocument, true);
        doc = tmpIframe.contentDocument; // continue the rest of this function on the live doc
      } catch (err) {
        warn('[cxreader] pre-render white-background pass failed, continuing unpatched:', err?.message);
        if (tmpIframe) { tmpIframe.remove(); tmpIframe = null; }
      } finally {
        if (tmpUrl) URL.revokeObjectURL(tmpUrl);
      }
    }

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

    const html = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
    // Only now, after outerHTML has been serialized out of it — removing earlier risks the
    // temp document losing its window association mid-use on some engines.
    if (tmpIframe) tmpIframe.remove();
    return html;
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

  // True on the old Android WebViews flagged by the flex-gap probe in reader.html.
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

  // XHTML allows self-closing non-void elements (e.g. `<a id="x"/>` as an empty anchor
  // target). HTML5 parsing ignores the trailing "/" on anything but a void element, so
  // the tag never closes and silently swallows every sibling that follows as its
  // descendants — an `<a>` used this way (common for footnote/pagebreak anchors) ends up
  // wrapping the rest of the chapter, and any `a *` styling then paints the whole chapter
  // with link coloring. Rewrite such tags to explicit open/close pairs before HTML parsing.
  static _VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  _xhtmlToHtml(raw) {
    return raw.replace(/<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^"'/>])*)\/>/g,
      (match, tag, attrs) => {
        return ChapterRenderer._VOID_ELEMENTS.has(tag.toLowerCase())
          ? match
          : `<${tag}${attrs}></${tag}>`;
      });
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

  // Some books fake layout with large fixed left/right margins on paragraphs (e.g.
  // right-indenting SMS-style dialogue ~10em on a wide print page). Sized for a print
  // page, that collapses reflowable text into an unreadably narrow column on phone-width
  // viewports. Cap the declared value instead of stripping it — this keeps the visual
  // "this paragraph is distinct" cue while bounding how much width it can eat. Only
  // longhand margin-left/right(/inline-start/end) are handled; shorthand `margin: a b c d`
  // is rare for this specific pattern and left untouched.
  static _MAX_MARGIN_EM = 2;

  _clampLargeMargins(cssText) {
    return cssText.replace(
      /(margin-(?:left|right|inline-start|inline-end)\s*:\s*)(-?[\d.]+)(em|rem)(\s*(?:!important)?\s*;)/gi,
      (match, prop, num, unit, tail) => {
        const val = parseFloat(num);
        const max = ChapterRenderer._MAX_MARGIN_EM;
        if (Math.abs(val) <= max) return match;
        const capped = val < 0 ? -max : max;
        return `${prop}${capped}${unit}${tail}`;
      }
    );
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
