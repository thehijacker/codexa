// CXReader — EPUB parser
// Parses an EPUB3/EPUB2 arrayBuffer using JSZip (global) and DOMParser.
// Returns a parsed book object usable by the renderer and paginator.

export class EpubParser {
  constructor() {
    this._zip     = null;
    this._opfBase = '';        // directory prefix for resolving OPF-relative hrefs
    this._blobUrls = new Map(); // absPath → blob URL (all manifest resources)
  }

  // ── Main entry point ─────────────────────────────────────────────────────────
  async parse(arrayBuffer) {
    this._zip = await JSZip.loadAsync(arrayBuffer);

    // 1. container.xml → OPF path
    const containerXml = await this._readText('META-INF/container.xml');
    const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
    const opfPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) throw new Error('[CXReader] container.xml: rootfile not found');

    // Strip any leading slash from the OPF path before computing the base directory.
    // Some container.xml files use an absolute path like /OEBPS/content.opf; the leading
    // slash is not part of the ZIP entry name and causes double-slash paths on old WebViews.
    const opfPathClean = opfPath.replace(/^\/+/, '');
    this._opfBase = opfPathClean.includes('/')
      ? opfPathClean.slice(0, opfPathClean.lastIndexOf('/') + 1)
      : '';

    // 2. OPF → metadata, manifest, spine
    const opfXml = await this._readText(opfPath);
    const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

    const metadata = this._parseMetadata(opfDoc);
    const rawManifest = this._parseRawManifest(opfDoc);
    const spineIds    = this._parseSpineOrder(opfDoc);

    // 3. Build blob URLs for all resources (CSS, images, fonts, HTML chapters)
    await this._buildBlobUrls(rawManifest);

    // 4. Assemble final manifest Map<id, item>
    const manifest = new Map();
    for (const [id, item] of Object.entries(rawManifest)) {
      const absPath = this._resolve(item.href);
      manifest.set(id, {
        id,
        href:      item.href,
        absPath,
        mediaType: item.mediaType,
        properties: item.properties,
        blobUrl:   this._blobUrls.get(absPath) ?? null,
      });
    }

    // 5. Ordered spine array (only linear items)
    const spine = spineIds.map((id, index) => {
      const item = manifest.get(id);
      return {
        id,
        index,
        href:      item.href,
        absPath:   item.absPath,
        blobUrl:   item.blobUrl,
        mediaType: item.mediaType,
      };
    });

    // 6. TOC — prefer EPUB3 nav document, fall back to EPUB2 NCX
    const navItem = [...manifest.values()].find(m => m.properties.includes('nav'));
    const ncxItem = (() => {
      const ncxId = opfDoc.querySelector('spine')?.getAttribute('toc');
      return ncxId ? manifest.get(ncxId) : [...manifest.values()].find(m => m.mediaType === 'application/x-dtbncx+xml');
    })();

    let toc = [];
    if (navItem) {
      toc = await this._parseNav(navItem.absPath);
    } else if (ncxItem) {
      toc = await this._parseNcx(ncxItem.absPath);
    }

    console.log(`[CXReader] parsed: "${metadata.title}" by "${metadata.author}" | spine=${spine.length} toc=${toc.length}`);
    return { spine, manifest, metadata, toc, opfBase: this._opfBase };
  }

  // Revoke all blob URLs (call on destroy)
  revokeBlobUrls() {
    this._blobUrls.forEach(url => URL.revokeObjectURL(url));
    this._blobUrls.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  async _readText(path) {
    const file = this._zip.file(path) || this._zip.file(decodeURIComponent(path));
    if (!file) throw new Error(`[CXReader] file not found in ZIP: ${path}`);
    return file.async('text');
  }

  // Resolve an OPF-relative href to an absolute ZIP entry path (no leading slash).
  // Does NOT use new URL() with custom schemes — that's unreliable on old WebViews where
  // non-http(s) schemes may produce wrong pathnames or throw silently.
  _resolve(href) {
    const clean = href.split('#')[0].split('?')[0];
    if (!clean) return '';
    // Absolute path (starts with /): strip all leading slashes — ZIP entries never have them.
    if (clean.startsWith('/')) return this._normalizePath(clean.replace(/^\/+/, ''));
    // Relative: join with the OPF directory and normalise . / .. segments.
    return this._normalizePath(this._opfBase + clean);
  }

  // Collapse . and .. segments and remove any remaining leading slashes.
  _normalizePath(path) {
    const parts = path.split('/');
    const out = [];
    for (const p of parts) {
      if (p === '..') { if (out.length) out.pop(); }
      else if (p !== '.') out.push(p);
    }
    // Drop any empty leading segment that a double-slash left behind.
    while (out.length && out[0] === '') out.shift();
    return out.join('/');
  }

  _parseMetadata(opfDoc) {
    const get = (selector) => {
      const el = opfDoc.querySelector(selector);
      return el ? el.textContent.trim() : '';
    };
    return {
      title:      get('metadata title') || get('dc\\:title') || '',
      author:     get('metadata creator') || get('dc\\:creator') || '',
      language:   get('metadata language') || get('dc\\:language') || '',
      identifier: get('metadata identifier') || get('dc\\:identifier') || '',
      description: get('metadata description') || get('dc\\:description') || '',
    };
  }

  _parseRawManifest(opfDoc) {
    const items = {};
    opfDoc.querySelectorAll('manifest item, manifest > item').forEach(el => {
      const id         = el.getAttribute('id');
      const href       = el.getAttribute('href');
      const mediaType  = el.getAttribute('media-type') || '';
      const properties = el.getAttribute('properties') || '';
      if (id && href) {
        items[id] = { href, mediaType, properties };
      }
    });
    return items;
  }

  _parseSpineOrder(opfDoc) {
    const ids = [];
    opfDoc.querySelectorAll('spine itemref').forEach(el => {
      const idref  = el.getAttribute('idref');
      const linear = el.getAttribute('linear');
      if (idref && linear !== 'no') ids.push(idref);
    });
    return ids;
  }

  async _buildBlobUrls(rawManifest) {
    const entries = Object.values(rawManifest);
    await Promise.all(entries.map(async ({ href }) => {
      const absPath = this._resolve(href);
      if (this._blobUrls.has(absPath)) return;
      const file = this._zip.file(absPath) || this._zip.file(decodeURIComponent(absPath));
      if (!file) return;
      try {
        const blob = await file.async('blob');
        this._blobUrls.set(absPath, URL.createObjectURL(blob));
      } catch { /* skip unreadable entries */ }
    }));
  }

  // ── TOC parsers ───────────────────────────────────────────────────────────────

  async _parseNav(absPath) {
    const html = await this._readText(absPath);
    const doc  = new DOMParser().parseFromString(html, 'application/xhtml+xml');
    const navEl = doc.querySelector('nav[epub\\:type="toc"], nav[*|type="toc"], nav');
    if (!navEl) return [];
    const navBase = absPath.includes('/') ? absPath.slice(0, absPath.lastIndexOf('/') + 1) : '';
    return this._parseNavList(navEl.querySelector('ol'), navBase);
  }

  _parseNavList(olEl, base) {
    if (!olEl) return [];
    return [...olEl.children].filter(li => li.tagName === 'LI').map(li => {
      const aEl  = li.querySelector(':scope > a');
      const span = li.querySelector(':scope > span');
      const label = (aEl || span)?.textContent.trim() || '';
      const href  = aEl?.getAttribute('href') || '';
      const absHref = href ? this._resolve(base + href.split('#')[0]) + (href.includes('#') ? '#' + href.split('#')[1] : '') : '';
      const children = this._parseNavList(li.querySelector(':scope > ol'), base);
      return { label, href: absHref, children };
    }).filter(item => item.label);
  }

  async _parseNcx(absPath) {
    const xml  = await this._readText(absPath);
    const doc  = new DOMParser().parseFromString(xml, 'application/xml');
    const ncxBase = absPath.includes('/') ? absPath.slice(0, absPath.lastIndexOf('/') + 1) : '';
    return this._parseNcxPoints(doc.querySelectorAll('navMap > navPoint'), ncxBase);
  }

  _parseNcxPoints(navPoints, base) {
    return [...navPoints].map(np => {
      const label = np.querySelector('navLabel text')?.textContent.trim() || '';
      const src   = np.querySelector('content')?.getAttribute('src') || '';
      const absHref = src ? this._resolve(base + src.split('#')[0]) + (src.includes('#') ? '#' + src.split('#')[1] : '') : '';
      const children = this._parseNcxPoints(np.querySelectorAll(':scope > navPoint'), base);
      return { label, href: absHref, children };
    }).filter(item => item.label);
  }
}
