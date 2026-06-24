// CXReader — CBZ parser
// Parses a CBZ (ZIP of images) into the same book-object shape as EpubParser.parse().
// JSZip is used as a global (loaded via <script> in readerv4.html).

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

export class CbzParser {
  async parse(zip) {
    const imageFiles = Object.values(zip.files)
      .filter(f => !f.dir && IMAGE_EXT.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!imageFiles.length) throw new Error('[CXReader] CBZ: no images found');

    const blobUrls = new Map();
    await Promise.all(imageFiles.map(async f => {
      const blob = await f.async('blob');
      blobUrls.set(f.name, URL.createObjectURL(blob));
    }));

    let title = '', author = '', description = '', series = '', seriesNumber = '', genre = '';
    try {
      const ci = zip.file('ComicInfo.xml');
      if (ci) {
        const xml = await ci.async('text');
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const t = (tag) => doc.querySelector(tag)?.textContent?.trim() || '';
        title        = t('Title');
        author       = [t('Writer'), t('Penciller')].filter(Boolean).join(', ');
        description  = t('Summary');
        series       = t('Series');
        seriesNumber = t('Number');
        genre        = t('Genre');
      }
    } catch { /* ignore */ }

    const spine = imageFiles.map((f, index) => ({
      id: f.name, index, href: f.name, absPath: f.name,
      mediaType: 'image/*', blobUrl: blobUrls.get(f.name),
    }));

    return {
      spine,
      manifest: new Map(),
      metadata: { title, author, description, series, seriesNumber, genre, language: '', identifier: '' },
      toc: [],
      opfBase: '',
      spineWeights: spine.map(() => 1),
      isCbz: true,
      _blobUrls: blobUrls,
    };
  }
}
