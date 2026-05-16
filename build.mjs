import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DIST   = path.join(__dirname, 'dist');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function collectJs(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJs(p));
    else if (entry.name.endsWith('.js')) files.push(p);
  }
  return files;
}

// Step 1: copy public/ → dist/
console.log('[build] Copying public/ → dist/ ...');
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
copyDir(PUBLIC, DIST);

// Step 2: transpile dist/js/**/*.js in-place
// bundle:false keeps each file's relative import paths intact
console.log('[build] Transpiling JS (target: chrome69) ...');
const jsFiles = collectJs(path.join(DIST, 'js'));
await esbuild.build({
  entryPoints: jsFiles,
  outdir: path.join(DIST, 'js'),
  allowOverwrite: true,
  bundle: false,
  target: 'chrome69',
  format: 'esm',
  logLevel: 'warning',
});

// Step 3: transpile sw.js (classic script — no import/export, just syntax lowering)
const swSrc = path.join(DIST, 'sw.js');
if (fs.existsSync(swSrc)) {
  await esbuild.build({
    entryPoints: [swSrc],
    outfile: swSrc,
    allowOverwrite: true,
    bundle: false,
    target: 'chrome69',
    logLevel: 'warning',
  });
}

console.log('[build] Done → dist/');
