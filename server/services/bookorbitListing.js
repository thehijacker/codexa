function bookOrbitListPath(source, id) {
  if (source === 'collection') return `/collections/${id}/books`;
  if (source === 'smartScope') return `/smart-scopes/${id}/books/query`;
  return null;
}

// Fetch the complete listing before sync so an incomplete response cannot mark books as stale.
async function fetchAllBookOrbitBooks(api, userId, ctx, source, id) {
  const boPath = bookOrbitListPath(source, id);
  if (!boPath) throw new Error('Invalid BookOrbit source');
  const all = [];
  const size = 100;
  for (let page = 0;; page++) {
    const r = source === 'smartScope'
      ? await api(userId, ctx, 'POST', boPath, { pagination: { page, size } })
      : await api(userId, ctx, 'GET', `${boPath}?${new URLSearchParams({ page: String(page), size: String(size) })}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!Array.isArray(r.data?.items)) throw new Error('Invalid BookOrbit book listing');
    all.push(...r.data.items);
    if (r.data.items.length < size) return all;
  }
}

module.exports = { bookOrbitListPath, fetchAllBookOrbitBooks };
