'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Strip pronunciation/stress accent marks from vowels, keeping distinct letters
 * (č, š, ž, ń, etc.) intact.  This lets us match dictionary headwords like
 * "hítro", "člôvek", "profíl" when the user types the unmarked form.
 *
 * Strips: á à â ä ã å  é è ê ë  í ì î ï  ó ò ô ö õ  ú ù û ü  ý ÿ
 * Keeps:  č š ž ć ń ř ł … (consonants with diacritics are distinct phonemes)
 */
const VOWEL_ACCENT_MAP = {
  'á':'a','à':'a','â':'a','ä':'a','ã':'a','å':'a',
  'é':'e','è':'e','ê':'e','ë':'e',
  'í':'i','ì':'i','î':'i','ï':'i',
  'ó':'o','ò':'o','ô':'o','ö':'o','õ':'o',
  'ú':'u','ù':'u','û':'u','ü':'u',
  'ý':'y','ÿ':'y',
};
const ACCENT_RE = /[áàâäãåéèêëíìîïóòôöõúùûüýÿ]/g;

function normalizeWord(w) {
  return w.toLowerCase().replace(ACCENT_RE, c => VOWEL_ACCENT_MAP[c] || c);
}

/**
 * Generate word-form candidates to try in order, most specific first.
 * First element is always the exact (lowercased) form.
 * Handles common English inflections and common Slavic/Slovenian patterns.
 */
function generateCandidates(raw) {
  const w    = raw.toLowerCase().trim();
  const seen = new Set();
  const out  = [];
  const add  = (s) => { if (s && s.length > 1 && !seen.has(s)) { seen.add(s); out.push(s); } };

  add(w);  // always try exact first

  // ── English inflections ──────────────────────────────────────────────────────

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

  // ── Slavic / Slovenian inflections ──────────────────────────────────────────
  // Many oblique/genitive forms lack the final vowel of the nominative.
  // Try appending common vowel endings to recover the base form.
  // e.g. nogavic→nogavica, knjig→knjiga, mož→moža, hiš→hiša

  if (w.length >= 3) {
    // Genitive plural → nominative singular: try adding -a / -e / -i
    add(w + 'a');
    add(w + 'e');
    add(w + 'i');

    // Slovenian feminine nouns: accusative sg. ends in -o, nominative in -a
    // e.g. popačenko → popačenka, žensko → ženska, knjigo → knjiga
    if (w.endsWith('o') && w.length > 3) { add(w.slice(0, -1)); add(w.slice(0, -1) + 'a'); }

    // Dative/locative sg. ends in -i or -u; try nominative -a / -e
    if (w.endsWith('i') && w.length > 3) { add(w.slice(0, -1) + 'a'); add(w.slice(0, -1) + 'e'); }
    if (w.endsWith('u') && w.length > 3) { add(w.slice(0, -1)); add(w.slice(0, -1) + 'a'); add(w.slice(0, -1) + 'e'); }

    // Slovenian masculine plural endings → nominative singular
    // -ji  (oficirji→oficir, možje→mož handled below)
    if (w.endsWith('ji')  && w.length > 3) add(w.slice(0, -2));         // oficirji→oficir
    // -evi / -ovi (sinovi→sin, bratovi→brat, moževi→mož)
    if (w.endsWith('evi') && w.length > 4) { add(w.slice(0, -3)); add(w.slice(0, -3) + 'e'); }
    if (w.endsWith('ovi') && w.length > 4) add(w.slice(0, -3));         // sinovi→sin
    // -je (možje→mož, bratje→brat)
    if (w.endsWith('je')  && w.length > 3) add(w.slice(0, -2));         // možje→mož
    // plain -i masculine plural (učitelji→učitelj, konji→konj)
    if (w.endsWith('i')   && w.length > 3) add(w.slice(0, -1));         // konji→konj
    // feminine plural -e (ženske→ženska via -e→-a is covered above; also žene→žena)
    if (w.endsWith('e')   && w.length > 3) add(w.slice(0, -1) + 'a');   // žene→žena

    if (w.endsWith('ega') && w.length > 4) add(w.slice(0, -3) + 'i');  // dobrega → dobri
    if (w.endsWith('emu') && w.length > 4) add(w.slice(0, -3) + 'i');  // dobremu → dobri
    if (w.endsWith('em')  && w.length > 3) add(w.slice(0, -2) + 'i');  // dobrem  → dobri
    if (w.endsWith('ih')  && w.length > 3) add(w.slice(0, -2) + 'i');  // dobrih  → dobri

    // Verb: known infinitive endings → also try stem directly
    if (w.endsWith('ati') && w.length > 4) add(w.slice(0, -3));        // gledati→gleda
    if (w.endsWith('iti') && w.length > 4) add(w.slice(0, -3));        // hoditi→hodi
    if (w.endsWith('eti') && w.length > 4) add(w.slice(0, -3));        // umeti→ume

    // Verb personal endings → reconstruct stem, then try all three infinitive forms
    // 1st/2nd/3rd person present: -am/-aš/-a (dela- class → delati)
    if (w.endsWith('am')  && w.length > 3) { const s = w.slice(0, -2); add(s); add(s + 'ti'); add(s + 'ati'); }  // delam→dela/delati
    if (w.endsWith('aš')  && w.length > 3) { const s = w.slice(0, -2); add(s); add(s + 'ti'); add(s + 'ati'); }  // delaš→dela/delati
    if (w.endsWith('iš')  && w.length > 3) { const s = w.slice(0, -2); add(s); add(s + 'ti'); add(s + 'iti'); }  // hodiš→hodi/hoditi
    if (w.endsWith('im')  && w.length > 3) { const s = w.slice(0, -2); add(s); add(s + 'ti'); add(s + 'iti'); }  // hodim→hodi/hoditi
    if (w.endsWith('eš')  && w.length > 3) { const s = w.slice(0, -2); add(s); add(s + 'ti'); add(s + 'eti'); }  // umeš→ume/umeti
    if (w.endsWith('em')  && w.length > 3) { const s = w.slice(0, -2); add(s + 'eti'); }                         // umem→umeti (em→i already done above)
  }

  return out;
}

/**
 * Reads a StarDict dictionary (.ifo + .idx + .dict or .dict.dz).
 *
 * The .idx is loaded entirely into memory.  A normalized HashMap is built for
 * fast, accent-insensitive lookups (handles headwords like "hítro", "člôvek").
 * The optional .syn file is parsed to map synonym/alternate forms to headwords.
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
    this.entries  = [];      // [{word, offset, size}], in idx file order
    this._normIndex = null;  // Map: normalizeWord(headword) → entry[]  (all matching entries)
    this._synIndex  = null;  // Map: normalizeWord(synonym)  → entry[]  (from .syn file)
    this._dictBuf = null;    // lazy-loaded
    this._loaded  = false;
  }

  load() {
    if (this._loaded) return;
    this._parseIfo();
    this._parseIdx();
    this._buildNormIndex();
    this._parseSyn();
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
    const buf     = fs.readFileSync(idxPath);
    // idxoffsetbits=64 means offsets are 8 bytes instead of the default 4
    const use64   = parseInt(this.meta.idxoffsetbits) === 64;
    const offsetBytes = use64 ? 8 : 4;
    let pos = 0;
    while (pos < buf.length) {
      // Null-terminated UTF-8 word
      let end = pos;
      while (end < buf.length && buf[end] !== 0) end++;
      const word = buf.slice(pos, end).toString('utf8');
      pos = end + 1;
      if (pos + offsetBytes + 4 > buf.length) break;
      let offset;
      if (use64) {
        // Read as two 32-bit halves; safe for files up to 2^53 bytes
        const hi = buf.readUInt32BE(pos);
        const lo = buf.readUInt32BE(pos + 4);
        offset = hi * 0x100000000 + lo;
      } else {
        offset = buf.readUInt32BE(pos);
      }
      const size = buf.readUInt32BE(pos + offsetBytes);
      pos += offsetBytes + 4;
      this.entries.push({ word, offset, size });
    }
  }

  /**
   * Build a Map from normalizeWord(headword) → entry[] for O(1) accent-insensitive
   * lookup.  Stores ALL entries for each normalized key so that headwords that only
   * differ in accent marks (e.g. "POP" vs "pop" vs "pôp") are all returned.
   */
  _buildNormIndex() {
    this._normIndex = new Map();
    for (const entry of this.entries) {
      const key = normalizeWord(entry.word);
      if (this._normIndex.has(key)) {
        this._normIndex.get(key).push(entry);
      } else {
        this._normIndex.set(key, [entry]);
      }
    }
  }

  /**
   * Parse the optional .syn file which maps synonym/alternate word forms directly
   * to headword entries.  Format: null-terminated UTF-8 word + uint32BE index into
   * this.entries[].  This gives dictionary-provided morphology for free.
   */
  _parseSyn() {
    const synPath = path.join(this.dir, this.base + '.syn');
    if (!fs.existsSync(synPath)) return;
    this._synIndex = new Map();
    const buf = fs.readFileSync(synPath);
    let pos = 0;
    while (pos < buf.length) {
      let end = pos;
      while (end < buf.length && buf[end] !== 0) end++;
      const word = buf.slice(pos, end).toString('utf8');
      pos = end + 1;
      if (pos + 4 > buf.length) break;
      const idx = buf.readUInt32BE(pos);
      pos += 4;
      const entry = this.entries[idx];
      if (!entry) continue;
      const key = normalizeWord(word);
      if (this._synIndex.has(key)) {
        this._synIndex.get(key).push(entry);
      } else {
        this._synIndex.set(key, [entry]);
      }
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

  _readEntry(entry) {
    const def  = this._loadDict().slice(entry.offset, entry.offset + entry.size).toString('utf8');
    const type = (this.meta.sametypesequence || 'm')[0];
    return { word: entry.word, definition: def, type };
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Accent-insensitive word lookup.
   * Checks .syn synonyms first (dictionary-provided alternate forms), then the
   * main headword index.  Returns array of { word, definition, type } — multiple
   * results when headwords differ only in accent marks or when .syn has multiple
   * targets.  Returns empty array when nothing is found.
   */
  lookup(word) {
    const key = normalizeWord(word);

    // .syn has highest priority: it maps exact inflected forms to headwords
    if (this._synIndex) {
      const synEntries = this._synIndex.get(key);
      if (synEntries?.length) return synEntries.map(e => this._readEntry(e));
    }

    const entries = this._normIndex?.get(key);
    if (!entries?.length) return [];
    return entries.map(e => this._readEntry(e));
  }

  /**
   * Like lookup(), but also tries morphological variants (suffixes stripped) when
   * the exact word is not found.  Returns array of results (same shape as lookup())
   * plus `matchedForm` on each item indicating which candidate actually hit.
   */
  lookupFuzzy(word) {
    for (const candidate of generateCandidates(word)) {
      const hits = this.lookup(candidate);
      if (hits.length) return hits.map(h => ({ ...h, matchedForm: candidate }));
    }
    return [];
  }

  /**
   * Return up to `limit` headwords whose normalized form starts with `prefix`.
   * Useful for autocomplete.
   */
  suggest(prefix, limit = 10) {
    const pfx = normalizeWord(prefix);
    const results = [];
    for (const entry of this.entries) {
      if (normalizeWord(entry.word).startsWith(pfx)) {
        results.push(entry.word);
        if (results.length >= limit) break;
      }
    }
    return results;
  }
}

module.exports = StarDict;
