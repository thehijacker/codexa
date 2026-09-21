# PDF paper inversion research

## Recommendation

Use an image-preserving **Paper inversion** mode, not CSS `filter: invert(1)`.
Post-process each completed PDF.js page canvas before it enters the viewer.
Replace only opaque, exact paper white with a dark paper colour.
Replace only opaque, exact ink black with a light ink colour.
Keep every other pixel unchanged, including colour and grayscale images.

This is the safest compatible option for Codexa's shared web and Android WebView renderer.
It runs in the existing `_renderPdfCanvas` seam before canvases reach paginated or continuous layouts.
The current renderer creates one raster canvas for the complete PDF page, including text, vectors, and images.

## Source capabilities

Codexa bundles PDF.js 4.10.38 and calls `PDFPageProxy.render` with one `CanvasRenderingContext2D`.
The [PDF.js render API](https://github.com/mozilla/pdf.js/blob/v4.10.38/src/display/api.js#L1369-L1472) accepts `pageColors`.
However, PDF.js applies `pageColors` only after it paints the complete canvas.
Its [canvas implementation](https://github.com/mozilla/pdf.js/blob/v4.10.38/src/display/canvas.js#L959-L990) redraws that canvas through a high-contrast filter.
The [filter implementation](https://github.com/mozilla/pdf.js/blob/v4.10.38/src/display/filter_factory.js#L212-L248) converts every pixel to luminance before recolouring it.
Therefore, `pageColors` damages embedded photographs and artwork.

CSS `invert()` also operates on all input colour samples.
The [CSS filter specification summary](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/filter-function/invert) defines complete inversion as `invert(1)`.
It cannot distinguish PDF text from a photograph inside the same canvas.
Android WebView uses the same web canvas and CSS path as the browser build.

The standard `CanvasRenderingContext2D` API provides a `filter` property, but it applies to draw operations rather than PDF object types.
See [Canvas filters](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/filter).
It cannot recover image boundaries after PDF.js has rasterized a page.

## Behaviour and limits

Exact white or black pixels inside an image will also change.
This is rare and much less disruptive than inverting all image colours.
Anti-aliased black text contains dark gray edge pixels.
Those pixels remain dark, so the feature must be tested with text-heavy PDFs.

Do not expand the first version into threshold-based neutral-colour replacement.
Thresholding will alter grayscale photographs and scans.
If edge contrast is insufficient, offer a separate high-contrast mode using PDF.js `pageColors`.
Label that mode as altering artwork.

## Acceptance checks

1. A text PDF shows dark paper and light primary text.
2. A colour photo PDF keeps hue and most luminance values unchanged.
3. The option persists with existing reader preferences.
4. Page turns and the continuous render window apply the mode consistently.
5. Android WebView and browser render identical canvas pixels for the same option.
