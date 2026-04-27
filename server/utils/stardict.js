'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Generate word-form candidates to try in order, most specific first.
 * Handles common English inflections: plurals, past tense, gerund, comparative/superlative, adverbs.
 * The first element is always the exact (lowercased) form.
 * Used by StarDict.lookupFuzzy() so definitions are found even for inflected forms.
 */
function generateCandidates(raw) {
  const w    = raw.toLowerCase().trim();
  const seen = new Set();
  const out  = [];
  const add  = (s) => { if (s && s.length > 1 && !seen.has(s)) { seen.add(s); out.push(s); } };

  add(w);  // always try exact first

  // -ly adverbs: quickly → quick, heavily → heavy (via ily→y)
  if (w.endsWith('ily') && w.length > 4) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ly')  && w.length > 4) add(w.slice(0, -2));

  // Irregular / consonant-swap plurals
  if (w.endsWith('ves') && w.length > 4) { add(w.slice(0, -3) + 'f'); add(w.slice(0, -3) + 'fe'); } // leaves→leaf, knives→knife
  if (w.endsWith('ies') && w.length > 4) add(w.slice(0, -3) + 'y'); // flies→fly, tries→try

  // Gerund / present participle -ing
  if (w.endsWith('ing') && w.length > 5) {
    const base = w.slice(0, -3);
    add(base + 'e');  // making→make, writing→write
    add(base);        // thinking→think, running (base=runn)
    // doubled final consonant: running→run, swimming→swim
    if (base.length >= 2 && base.at(-1) === base.at(-2)) add(base.slice(0, -1));
  }

  // Past tense / past participle -ed
  if (w.endsWith('ied') && w.length > 4) add(w.slice(0, -3) + 'y');  // tried→try, carried→carry
  if (w.endsWith('ed')  && w.length > 3) {
    const base = w.slice(0, -2);
    add(w.slice(0, -1));  // observed→observe, loved→love (remove just d)
    add(base);            // watched→watch, looked→look
    // doubled consonant: begged→beg, controlled→control
    if (base.length >= 2 && base.at(-1) === base.at(-2)) add(base.slice(0, -1));
  }

  // Comparative -er / superlative -est
  if (w.endsWith('est') && w.length > 5) {
    const base = w.slice(0, -3);
    add(base + 'e');  // nicest→nice
    add(base);        // fastest→fast
    if (base.length >= 2 && base.at(-1) === base.at(-2)) add(base.slice(0, -1)); // biggest→big
  }
  if (w.endsWith('er') && w.length > 4) {
    const base = w.slice(0, -2);
    add(base + 'e');  // nicer→nice
    add(base);        // faster→fast
    if (base.length >= 2 && base.at(-1) === base.at(-2)) add(base.slice(0, -1)); // bigger→big
  }

  // Plain -es and -s plurals / 3rd-person singular (after more specific rules above)
  if (w.endsWith('es') && w.length > 3) { add(w.slice(0, -1)); add(w.slice(0, -2)); } // boxes→box, goes→go
  if (w.endsWith('s')  && w.length > 3) add(w.slice(0, -1));   // humans→human, runs→run

  return out;
}

/**
 * Reads a StarDict dictionary (.ifo + .idx + .dict or .dict.dz).
 *
 * The .idx is loaded entirely into memory for O(log n) binary search.
 * The .dict (or .dict.dz) is loaded lazily on first lookup and cached.
 *
 * sametypesequence values we handle:
 *   m — plain text (most common)
 *   h — HTML
 *   g — Pango markup (treated as plain text)
 *   others — returned as-is (plain text fallback)
 */
class StarDict {
  constructor(ifoPath) {
    this.ifoPath  = ifoPath;
    this.dir      = path.dirname(ifoPath);
    this.base     = path.basename(ifoPath, '.ifo');
    this.meta     = {};
    this.entries  = [];      // [{word, offset, size}], sorted ascending (case-folded by StarDict spec)
    this._dictBuf = null;    // lazy-loaded
    this._loaded  = false;
  }

  load() {
    if (this._loaded) return;
    this._parseIfo();
    this._parseIdx();
    this._loaded = true;
  }

  get name()      { return this.meta.bookname  || this.base; }
  get wordcount() { return parseInt(this.meta.wordcount) || this.entries.length; }

  // ── Private helpers ──────────────────────────────────────────────────────────

  _parseIfo() {
    const lines = fs.readFileSync(this.ifoPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const i = line.indexOf('=');
      if (i > 0) this.meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }

  _parseIdx() {
    const idxPath = path.join(this.dir, this.base + '.idx');
    const buf = fs.readFileSync(idxPath);
    let pos = 0;
    while (pos < buf.length) {
      // Null-terminated UTF-8 word
      let end = pos;
      while (end < buf.length && buf[end] !== 0) end++;
      const word = buf.slice(pos, end).toString('utf8');
      pos = end + 1;
      if (pos + 8 > buf.length) break;
      const offset = buf.readUInt32BE(pos);
      const size   = buf.readUInt32BE(pos + 4);
      pos += 8;
      this.entries.push({ word, offset, size });
    }
  }

  _loadDict() {
    if (this._dictBuf) return this._dictBuf;
    const dictPath   = path.join(this.dir, this.base + '.dict');
    const dictDzPath = dictPath + '.dz';
    if (fs.existsSync(dictDzPath)) {
      // dictzip is regular gzip — zlib can decompress it in full
      this._dictBuf = zlib.gunzipSync(fs.readFileSync(dictDzPath));
    } else if (fs.existsSync(dictPath)) {
      this._dictBuf = fs.readFileSync(dictPath);
    } else {
      throw new Error(`No .dict or .dict.dz found for: ${this.base}`);
    }
    return this._dictBuf;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Exact-word lookup (case-insensitive).
   * Returns { word, definition, type } or null.
   * `type` is the first char of sametypesequence ('m', 'h', 'g', …).
   */
  lookup(word) {
    const target = word.toLowerCase();
    let lo = 0, hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const w   = this.entries[mid].word.toLowerCase();
      if (w === target) {
        const { offset, size } = this.entries[mid];
        const def  = this._loadDict().slice(offset, offset + size).toString('utf8');
        const type = (this.meta.sametypesequence || 'm')[0];
        return { word: this.entries[mid].word, definition: def, type };
      }
      if (w < target) lo = mid + 1;
      else            hi = mid - 1;
    }
    return null;
  }

  /**
   * Like lookup(), but also tries morphological variants (suffixes stripped) when
   * the exact word is not found.  Returns the same shape as lookup() plus
   * `{ matchedForm }` indicating which candidate actually hit.
   */
  lookupFuzzy(word) {
    for (const candidate of generateCandidates(word)) {
      const hit = this.lookup(candidate);
      if (hit) return { ...hit, matchedForm: candidate };
    }
    return null;
  }

  /**
   * Return up to `limit` headwords whose lowercase form starts with `prefix`.
   * Useful for autocomplete.
   */
  suggest(prefix, limit = 10) {
    const pfx = prefix.toLowerCase();
    let lo = 0, hi = this.entries.length - 1, start = this.entries.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].word.toLowerCase() >= pfx) { start = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return this.entries.slice(start, start + limit).map(e => e.word);
  }
}

module.exports = StarDict;
