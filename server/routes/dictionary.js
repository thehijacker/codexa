'use strict';
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const multer    = require('multer');
const AdmZip    = require('adm-zip');
const { DATA_DIR } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const StarDict  = require('../utils/stardict');

const TMP_DIR = path.join(DATA_DIR, 'tmp');

const router   = express.Router();
const DICT_DIR = path.join(DATA_DIR, 'dictionaries');
const cache    = new Map(); // relative-id → loaded StarDict instance

function ensureDictDir() {
  if (!fs.existsSync(DICT_DIR)) fs.mkdirSync(DICT_DIR, { recursive: true });
}

// Recursively find all .ifo files under DICT_DIR.
// Returns objects: { id, ifoPath }
// `id` is the path relative to DICT_DIR without the .ifo extension,
// e.g. "en-en/merriam-webster" for DICT_DIR/en-en/merriam-webster.ifo
function findAllIfo(dir = DICT_DIR, base = '') {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const e of entries) {
    if (e.isDirectory()) {
      results.push(...findAllIfo(path.join(dir, e.name), base ? `${base}/${e.name}` : e.name));
    } else if (e.isFile() && e.name.endsWith('.ifo')) {
      const stem = e.name.slice(0, -4);
      const id   = base ? `${base}/${stem}` : stem;
      results.push({ id, ifoPath: path.join(dir, e.name) });
    }
  }
  return results;
}

function loadDict(id) {
  if (cache.has(id)) return cache.get(id);
  // Resolve to an absolute path, then verify it's still inside DICT_DIR (no traversal)
  const resolved = path.resolve(DICT_DIR, id + '.ifo');
  if (!resolved.startsWith(path.resolve(DICT_DIR) + path.sep) && resolved !== path.resolve(DICT_DIR)) {
    const err = new Error('Invalid dictionary id: ' + id);
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(resolved)) {
    const err = new Error('Dictionary not found: ' + id);
    err.status = 404;
    throw err;
  }
  const d        = new StarDict(resolved);
  d.load();
  cache.set(id, d);
  return d;
}

// ── GET /api/dictionary ───────────────────────────────────────────────────────
// List all available dictionaries (recursive scan of DATA_DIR/dictionaries).
router.get('/', authenticateToken, (req, res) => {
  ensureDictDir();
  try {
    const dicts = findAllIfo().map(({ id, ifoPath }) => {
      try {
        const d    = loadDict(id);
        return { id, name: d.name, wordcount: d.wordcount };
      } catch { return null; }
    }).filter(Boolean);
    res.json(dicts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/dictionary/lookup?word=hello[&dicts=id1,id2] ─────────────────────
// `dicts` is a comma-separated list of relative ids in desired search order.
router.get('/lookup', authenticateToken, (req, res) => {
  const word = (req.query.word || '').trim();
  if (!word) return res.status(400).json({ error: 'error.word_required' });
  ensureDictDir();

  const requested = req.query.dicts
    ? req.query.dicts.split(',').map(s => s.trim()).filter(Boolean)
    : findAllIfo().map(e => e.id);

  const results = [];
  for (const id of requested) {
    try {
      const d    = loadDict(id);
      const hits = d.lookupFuzzy(word);
      for (const hit of hits) {
        results.push({ dict: id, dictName: d.name, word: hit.word, matchedForm: hit.matchedForm, definition: hit.definition, type: hit.type });
      }
    } catch { /* skip missing/broken dicts */ }
  }
  res.json({ word, results });
});

const uploadDict = multer({
  dest: TMP_DIR,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.zip');
    cb(ok ? null : new Error('error.zip_required'), ok);
  },
});

// ── POST /api/dictionary — upload one or many StarDict ZIP archives ────────────
router.post('/', authenticateToken, uploadDict.array('dict', 10), (req, res) => {
  ensureDictDir();
  const results = [];
  for (const file of req.files) {
    try {
      const zip = new AdmZip(file.path);
      const entries = zip.getEntries();
      const hasIfo  = entries.some(e => e.entryName.endsWith('.ifo'));
      if (!hasIfo) {
        results.push({ file: file.originalname, error: 'no .ifo found in ZIP' });
        continue;
      }
      const baseName = path.basename(file.originalname, '.zip').replace(/[^\w.\-]/g, '_');
      const destDir  = path.join(DICT_DIR, baseName);
      fs.mkdirSync(destDir, { recursive: true });
      zip.extractAllTo(destDir, true);
      results.push({ file: file.originalname, id: baseName });
    } catch (e) {
      results.push({ file: file.originalname, error: e.message });
    } finally {
      try { fs.unlinkSync(file.path); } catch {}
    }
  }
  res.json({ results });
});

// ── DELETE /api/dictionary/* — remove a dictionary folder ────────────────────
// id may be a slash-separated path like "en-en/merriam-webster"
router.delete('/*', authenticateToken, (req, res) => {
  const id       = req.params[0];
  const resolved = path.resolve(DICT_DIR, id);
  if (!resolved.startsWith(path.resolve(DICT_DIR) + path.sep)) {
    return res.status(400).json({ error: 'error.invalid_path' });
  }
  for (const k of cache.keys()) {
    if (k === id || k.startsWith(id + '/')) cache.delete(k);
  }
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'error.not_found' });
  fs.rmSync(resolved, { recursive: true, force: true });
  res.json({ ok: true });
});

module.exports = router;
