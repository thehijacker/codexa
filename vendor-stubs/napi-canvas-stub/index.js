/**
 * Stand-in for @napi-rs/canvas, substituted via package.json's "overrides".
 *
 * pdfjs-dist's Node ("legacy") build requires @napi-rs/canvas unconditionally at import
 * time (see its node_utils.js: a top-level `if (isNodeJS) { ... require("@napi-rs/canvas") }`
 * with no lazy-loading — it runs whether or not a page is ever rendered). That's a real,
 * platform-specific native (Rust NAPI) binary, and on at least one user's hardware it loaded
 * far enough to execute before hitting a CPU instruction their processor doesn't support —
 * an OS-level SIGILL (exit code 132) that kills the whole Node process outright. Unlike a
 * thrown JS error, that's not something try/catch or process.on('uncaughtException') can ever
 * catch (see server/utils/pdf.js and server/index.js's crash-safety handlers).
 *
 * This project only ever uses pdfjs-dist server-side for metadata (title/author/page count —
 * see server/utils/pdf.js), never for rendering, so the real @napi-rs/canvas is never actually
 * needed here — it was pulled in as a transitive optional dependency regardless. Overriding it
 * with this empty module means the risky native binary is never even present in node_modules,
 * so it can never load and can never crash the process, on any hardware. pdfjs-dist's own
 * require() call already wraps this in try/catch and degrades gracefully (it just skips
 * polyfilling DOMMatrix/ImageData/Path2D/canvas — all rendering-only concerns).
 */
module.exports = {};
