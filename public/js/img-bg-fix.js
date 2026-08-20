// ── Theme-friendly image backgrounds ────────────────────────────────────────
// Many EPUBs use small JPEG "ornament"/scene-break images (ink line-art on a flat
// white background) or whole-page black-and-white illustrations exported the same
// way. A JPEG has no alpha channel, so on any theme except near-white ones the
// image's square shows as a stark white box against the page. CSS
// `mix-blend-mode: multiply` (in buildEpubCss, reader.js) already targets this in
// principle — multiply(white, pageBg) mathematically equals pageBg — but that
// relies on GPU blend compositing, which is known to be unreliable inside CSS
// multi-column layouts across engines (Chrome, WebKit and old Android WebViews
// alike) — and pagination here is built entirely on multi-column. So instead of
// depending on compositing, this bakes real transparency into the image: sample
// it, and if it looks like flat line-art on a white background, redraw it onto a
// canvas with those near-white pixels turned genuinely transparent and swap the
// <img> to that PNG.
//
// Detection is two signals over the WHOLE image (downscaled for speed), not just
// its border: the fraction of near-white pixels must be high, AND the remaining
// "ink" pixels must be low-saturation (grayscale-ish, as real line art always is).
// An earlier version only sampled a border ring, on the theory that a real photo
// rarely has a uniform near-white edge — but many real-world scene-break/ornament
// images are cropped tight with almost no padding (e.g. a 75×9px "* * *" strip
// where the asterisks already touch the top/bottom edges), so squashing them into
// a square sample smeared the ink across the ring and made a genuinely
// white-background image fail a border-only check. Requiring low ink saturation
// (rather than border position) is what keeps real color photos from being
// falsely knocked out even though some of those can also have large bright areas.
//
// Two call sites use this module:
//  1. reader.js's injectIntoContents(), on the live, already-rendered chapter iframe.
//  2. cxreader/renderer.js's ChapterRenderer._buildHtml(), BEFORE the chapter's HTML is
//     ever serialized into the real iframe — required specifically for e-ink themes. On
//     e-ink, the reader's own CSS (built by buildEpubCss/buildEinkCss in reader.js)
//     includes a blanket `body * { background-image: none !important }` reset, and that
//     CSS is baked directly into the chapter's initial HTML by _buildHtml (not injected
//     live afterward) — so by the time call site (1) ever runs on a freshly-opened e-ink
//     chapter, the book's own background-image is already overridden to "none" and
//     permanently invisible to a getComputedStyle-based check (stripImageWhiteBackgrounds
//     only ever runs once per chapter document, self-guarded below). Confirmed live on a
//     Boox Palma 2, where e-ink is the device's saved default so EVERY chapter opens with
//     the reset already baked in from the very first render. Call site (2) runs detection
//     on a temporary, hidden iframe BEFORE that reset is added, so it always sees the
//     book's real CSS. Whichever call site runs first does the real work; the guard below
//     (a real DOM attribute) rides along through the HTML-string round-trip from (2) into
//     (1), so the other becomes a harmless no-op instead of double-processing.
import { warn } from './logger.js';

const IMG_BG_WHITE_THRESHOLD = 238;    // 0-255 per channel — how close to pure white counts as "background"
const IMG_BG_SAMPLE          = 40;     // downscale size used for the cheap pass/fail check
const IMG_BG_WHITE_FRAC_MIN  = 0.5;    // require at least this fraction of the image to be near-white
const IMG_BG_INK_SAT_MAX     = 40;     // and the non-white "ink" pixels to average under this saturation (0-255)
const IMG_BG_MAX_PIXELS      = 1400 * 1400; // skip full processing above this — too slow on weak/e-ink CPUs

function _looksLikeWhiteBgLineArt(img) {
  try {
    const c = (img.ownerDocument || document).createElement('canvas');
    c.width = c.height = IMG_BG_SAMPLE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, IMG_BG_SAMPLE, IMG_BG_SAMPLE);
    const { data } = ctx.getImageData(0, 0, IMG_BG_SAMPLE, IMG_BG_SAMPLE);
    let white = 0, inkSatSum = 0, inkCount = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      if (r >= IMG_BG_WHITE_THRESHOLD && g >= IMG_BG_WHITE_THRESHOLD && b >= IMG_BG_WHITE_THRESHOLD) {
        white++;
      } else {
        inkCount++;
        inkSatSum += Math.max(r, g, b) - Math.min(r, g, b);
      }
    }
    const whiteFrac = white / (IMG_BG_SAMPLE * IMG_BG_SAMPLE);
    const avgInkSat = inkCount ? inkSatSum / inkCount : 0;
    return whiteFrac >= IMG_BG_WHITE_FRAC_MIN && avgInkSat <= IMG_BG_INK_SAT_MAX;
  } catch { return false; }
}

// Returns a transparent-background PNG data URL for a loaded, white-bg-line-art
// image, or null if it's not a match (or too big / failed to process). Works on
// any loaded image-like element (an <img>, or a detached probe Image used for a
// CSS background-image — see stripImageWhiteBackgrounds below).
function _knockOutWhiteBackground(imgEl) {
  try {
    const w = imgEl.naturalWidth, h = imgEl.naturalHeight;
    if (!w || !h || w * h > IMG_BG_MAX_PIXELS) return null;
    if (!_looksLikeWhiteBgLineArt(imgEl)) return null;
    const c = (imgEl.ownerDocument || document).createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const hi = IMG_BG_WHITE_THRESHOLD, lo = hi - 30; // soft-edge fade between lo and hi, avoids a hard jaggy cutout
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] + d[i+1] + d[i+2]) / 3;
      if (lum >= hi) d[i+3] = 0;
      else if (lum > lo) d[i+3] = Math.round(d[i+3] * (hi - lum) / (hi - lo));
    }
    ctx.putImageData(imgData, 0, 0);
    return c.toDataURL('image/png');
  } catch (err) { warn('[reader] image background knockout failed:', err.message); return null; }
}

// Walk every image once per chapter document and knock out white backgrounds on the
// ones that look like line-art. Covers two cases:
//  1. Real <img> elements — the common case.
//  2. A CSS `background-image` on an otherwise-empty element — many EPUBs render a
//     scene-break/ornament as e.g. `<hr class="transition"/>` styled with
//     `background: url(asterisks.jpg) no-repeat center` in the book's own
//     stylesheet, so the image never appears as an <img> at all. Checking every
//     element's computed style would be needlessly expensive on weak/e-ink CPUs, so
//     this is restricted to <hr> (essentially always decorative) plus elements with
//     no text and no children (a background-image is the only thing they can be
//     rendering — real content elements are skipped).
//
// `eink` is passed explicitly (rather than read from a global) because this runs
// against two different documents — the live reader page (reader.js) and a detached
// pre-render pass (cxreader/renderer.js) — that don't share reader.js's module scope.
//
// Returns a Promise that resolves once every image's async knockout work (loading +
// canvas processing) has settled. The live reader.js call site doesn't need to await
// this — it's a background enhancement on an already-visible page, images just pop in
// once ready — but cxreader/renderer.js's pre-render pass MUST await it: it serializes
// doc.documentElement.outerHTML right after calling this, and every knockout here
// (probe image loads, canvas work) is otherwise still in flight at that point, so an
// un-awaited call there would silently lose the fix for anything but already-cached
// images. Bounded by a timeout so one stuck image can't hang a chapter render forever.
export function stripImageWhiteBackgrounds(doc, eink) {
  if (doc.documentElement.dataset.brImgBgFixed) return Promise.resolve();
  doc.documentElement.dataset.brImgBgFixed = '1';

  const pending = [];

  doc.querySelectorAll('img').forEach(img => {
    const process = () => { const url = _knockOutWhiteBackground(img); if (url) img.src = url; };
    if (img.complete && img.naturalWidth) process();
    else if (!img.complete) pending.push(new Promise(resolve => {
      img.addEventListener('load', () => { process(); resolve(); }, { once: true });
      img.addEventListener('error', resolve, { once: true }); // don't hang on a genuinely broken image
    }));
  });

  const win = doc.defaultView;
  if (!win) return Promise.all(pending);
  const candidates = new Set(doc.querySelectorAll('hr'));
  doc.querySelectorAll('div, span, p, li, td').forEach(el => {
    if (el.childElementCount === 0 && el.textContent.trim() === '') candidates.add(el);
  });
  let bgFixCounter = 0;
  candidates.forEach(el => {
    let bg;
    try { bg = win.getComputedStyle(el).backgroundImage; } catch { return; }
    const m = /^url\(["']?(.+?)["']?\)$/.exec(bg || '');
    if (!m || !m[1]) return;
    const probe = new (win.Image || Image)();
    pending.push(new Promise(resolve => {
      probe.onerror = resolve;
      probe.onload = () => {
        const url = _knockOutWhiteBackground(probe);
        if (!url) { resolve(); return; }
        // Override via a real stylesheet rule keyed to this element's id — not an inline style.
        // E-ink mode has a blanket `body * { background-image: none !important }` (buildEinkCss,
        // to strip any stray colour background images), and a first attempt at this used
        // `el.style.setProperty(..., 'important')` on the theory that inline !important always
        // outranks a stylesheet !important — true per spec, but that didn't survive on at least
        // one real device (Boox/Onyx's WebView), so this avoids the inline-vs-stylesheet fight
        // altogether: an ID selector (specificity 1,0,0) beats `body *` (0,0,1) outright, with no
        // dependence on origin/importance tie-breaking that a quirky engine could get wrong.
        if (!el.id) el.id = `br-bg-fix-${++bgFixCounter}`;
        let styleEl = doc.getElementById('br-bg-fix-styles');
        if (!styleEl) {
          styleEl = doc.createElement('style');
          styleEl.id = 'br-bg-fix-styles';
          (doc.body || doc.documentElement).appendChild(styleEl);
        }
        // E-ink also forces every other element to pure black/white text/borders, but this is a
        // background-image, which that pass can't reach — the JPEG's ink colour (rarely pure
        // black) would otherwise be the one spot of colour left on an e-ink page. Match the
        // treatment real <img> elements get there (see the `img { filter: grayscale(...) }`
        // rule in buildEinkCss) for consistency.
        const einkFilter = eink ? ' filter: grayscale(100%) !important;' : '';
        // background-repeat/-position are re-declared explicitly too, not just background-image:
        // e-ink's reset rule (and figure's transparent-bg rule) use the `background:` SHORTHAND,
        // which resets every sub-property it doesn't mention back to its default — including
        // background-repeat (default: repeat) and background-position (default: 0% 0%). Confirmed
        // live: leaving those out made the restored image tile across the whole element instead
        // of showing once, centered, as the book's own (now-overridden) CSS originally intended.
        // These ornamental images are effectively always meant to appear once and centered, so
        // hard-coding that here (rather than trying to recover the book's original values from its
        // stylesheet, which the same reset rules may have already clobbered by the time we'd read
        // them) is simpler and correct for the vast majority of real books.
        styleEl.textContent += `#${el.id} { background-image: url("${url}") !important; background-repeat: no-repeat !important; background-position: center !important;${einkFilter} }\n`;
        resolve();
      };
      probe.src = m[1];
    }));
  });
  // Bounded wait: one stuck image shouldn't be able to hang a chapter render forever
  // (matters for the renderer.js pre-render caller, which awaits this before serializing).
  return Promise.race([
    Promise.all(pending),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);
}
