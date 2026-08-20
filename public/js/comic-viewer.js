// ── Comic viewer gesture/zoom controller ────────────────────────────────────────
// Pure logic + DOM-transform module for the immersive comic (CBZ) page viewer — no event
// listeners of its own. reader.js owns all the actual DOM bindings on #epub-viewer (that's
// where nav-zone/vertNavZones/swipe-page-turn logic already lives) and calls into the
// methods here from its existing handlers, branching on comic-mode. Keeping it a pure
// caller-driven controller (rather than binding its own listeners) is what makes reader.js's
// existing touch/wheel/click plumbing the single source of truth for gesture ownership —
// important because a real touchscreen fires Pointer/Touch/Mouse events for the very same
// physical contact, and having two independent listener sets react to it is how you get
// double page-turns. It's also what will let a future PDF page-image mode reuse this file
// unchanged: PDF pages are expected to render into the same #epub-viewer container, through
// the same reader.js event handlers, just with isImmersivePageMode() extended to cover them.
//
// Applies its zoom/pan as a CSS transform directly on whichever `.cx-cbz-wrap` element
// currently exists under hostEl — looked up live on every call, never cached, since
// CXReader._renderCbzItem() replaces that element wholesale on every page turn.

const MIN_ZOOM      = 1;
const MAX_ZOOM       = 4;
const TAP_DRIFT_PX  = 10;   // touch movement under this still counts as a tap, not a drag
const TAP_MAX_MS    = 350;  // touch duration under this still counts as a tap

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export function createComicViewer({ hostEl }) {
  let scale = 1, panX = 0, panY = 0;
  let touchBaseline = null;   // last-seen [{x,y}, ...] snapshot, for incremental pinch/pan deltas
  let tapCandidate   = false;
  let tapStartX = 0, tapStartY = 0, tapStartTime = 0, dragged = false;
  let mouseDragBase  = null;
  let gestureBaseScale = 1;   // Safari native gesturestart/gesturechange baseline

  function wrap() { return hostEl.querySelector('.cx-cbz-wrap'); }

  function applyTransform() {
    const el = wrap();
    if (!el) return;
    el.style.transform = (scale === 1 && panX === 0 && panY === 0)
      ? '' : `translate(${panX}px,${panY}px) scale(${scale})`;
    hostEl.classList.toggle('cx-comic-zoomed', scale > 1);
  }

  // Approximates pan bounds from the host container's own box (the wrap is always inset:0,
  // so it matches). Not pixel-exact against the actual displayed (object-fit: contain) image
  // rect when the image's aspect ratio differs a lot from the viewport's, but close enough to
  // keep the page from being dragged wildly off-screen, which is all this needs to do.
  function clampPan() {
    const r = hostEl.getBoundingClientRect();
    const maxX = Math.max(0, (scale - 1) * r.width  / 2);
    const maxY = Math.max(0, (scale - 1) * r.height / 2);
    panX = clamp(panX, -maxX, maxX);
    panY = clamp(panY, -maxY, maxY);
  }

  // Zoom to `newScaleRaw`, keeping the content point currently under (clientX, clientY) fixed
  // on screen — the standard "zoom to cursor/pinch-midpoint" formula for a
  // translate(pan) scale(scale) transform anchored at the element's own center.
  function zoomAt(clientX, clientY, newScaleRaw) {
    const newScale = clamp(newScaleRaw, MIN_ZOOM, MAX_ZOOM);
    if (newScale === scale) return;
    const r  = hostEl.getBoundingClientRect();
    const cx = clientX - r.left - r.width  / 2;
    const cy = clientY - r.top  - r.height / 2;
    const k  = newScale / scale;
    panX = cx - (cx - panX) * k;
    panY = cy - (cy - panY) * k;
    scale = newScale;
    if (scale <= 1.001) { scale = 1; panX = 0; panY = 0; }
    clampPan();
    applyTransform();
  }

  function touchSnapshot(touchList) {
    return Array.from(touchList).map(t => ({ x: t.clientX, y: t.clientY }));
  }

  return {
    get zoom() { return scale; },

    reset() {
      scale = 1; panX = 0; panY = 0;
      touchBaseline = null; tapCandidate = false; dragged = false; mouseDragBase = null;
      applyTransform();
    },

    // ── Wheel (mouse wheel, and Chrome/Firefox trackpad pinch arriving as ctrlKey wheel) ──
    onWheel(e) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAt(e.clientX, e.clientY, scale * factor);
    },

    // ── Safari native trackpad pinch ──
    onGestureStart(e) { e.preventDefault(); gestureBaseScale = scale; },
    onGestureChange(e) { e.preventDefault(); zoomAt(e.clientX, e.clientY, gestureBaseScale * e.scale); },
    onGestureEnd(e) { e.preventDefault(); },

    // ── Desktop click-drag-to-pan (only meaningful once zoomed; reader.js only calls these
    //    while comicViewer.zoom > 1) ──
    onDragStart(x, y) { mouseDragBase = { x, y }; },
    onDragMove(x, y) {
      if (!mouseDragBase) return;
      panX += x - mouseDragBase.x;
      panY += y - mouseDragBase.y;
      mouseDragBase = { x, y };
      clampPan();
      applyTransform();
    },
    onDragEnd() { mouseDragBase = null; },

    // ── Touch: pan (1 finger, zoomed) + pinch-zoom (2 fingers) + tap detection ──
    // reader.js decides WHEN to route touches here at all (only once a pinch starts, or once
    // already zoomed in) — see isImmersivePageMode()'s call sites in reader.js. At fit-to-
    // screen zoom with a single finger, reader.js's existing nav-zone/swipe handling runs
    // unmodified instead, so this never needs to reimplement swipe-to-page-turn.
    onTouchStart(e) {
      touchBaseline = touchSnapshot(e.touches);
      tapCandidate  = e.touches.length === 1;
      if (tapCandidate) {
        tapStartX = touchBaseline[0].x; tapStartY = touchBaseline[0].y;
        tapStartTime = Date.now(); dragged = false;
      }
    },
    onTouchMove(e) {
      e.preventDefault();
      const snap = touchSnapshot(e.touches);
      if (snap.length === 2 && touchBaseline?.length === 2) {
        const [a, b]   = snap, [pa, pb] = touchBaseline;
        const dist     = Math.hypot(a.x - b.x, a.y - b.y);
        const prevDist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        const mid      = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const prevMid  = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
        if (prevDist > 0) zoomAt(mid.x, mid.y, scale * (dist / prevDist));
        panX += mid.x - prevMid.x;
        panY += mid.y - prevMid.y;
        clampPan();
        applyTransform();
      } else if (snap.length === 1 && touchBaseline?.length >= 1) {
        const t = snap[0], p = touchBaseline[0];
        if (scale > 1) {
          panX += t.x - p.x; panY += t.y - p.y;
          clampPan();
          applyTransform();
        }
        if (tapCandidate && Math.hypot(t.x - tapStartX, t.y - tapStartY) > TAP_DRIFT_PX) dragged = true;
      }
      touchBaseline = snap;
    },
    // Returns { type: 'tap', x, y } when the just-ended touch resolved to a simple tap
    // (no drag, no pinch, short enough), else null (a pan/pinch was already applied live —
    // there's nothing further for reader.js to do with it).
    onTouchEnd(e) {
      const remaining = touchSnapshot(e.touches);
      let result = null;
      if (tapCandidate && !dragged && remaining.length === 0 && Date.now() - tapStartTime < TAP_MAX_MS) {
        result = { type: 'tap', x: tapStartX, y: tapStartY };
      }
      touchBaseline = remaining.length ? remaining : null;
      return result;
    },
  };
}
