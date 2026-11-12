const test = require('node:test');
const assert = require('node:assert/strict');
const { bookOrbitListPath, fetchAllBookOrbitBooks } = require('./bookorbitListing');

test('smart-scope sync queries every page using the authenticated query endpoint', async () => {
  const ctx = { webBase: 'https://example.test/api/v1' };
  const first = Array.from({ length: 100 }, (_, id) => ({ id }));
  const calls = [];
  const api = async (...args) => {
    calls.push(args);
    return { ok: true, data: { items: calls.length === 1 ? first : [{ id: 100 }] } };
  };

  const books = await fetchAllBookOrbitBooks(api, 7, ctx, 'smartScope', 8);
  assert.deepEqual(books, [...first, { id: 100 }]);
  assert.deepEqual(calls, [
    [7, ctx, 'POST', '/smart-scopes/8/books/query', { pagination: { page: 0, size: 100 } }],
    [7, ctx, 'POST', '/smart-scopes/8/books/query', { pagination: { page: 1, size: 100 } }],
  ]);
});

test('collection sync retains the paginated GET endpoint, including exact page boundaries', async () => {
  const calls = [];
  const api = async (...args) => {
    calls.push(args);
    return { ok: true, data: { items: calls.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [] } };
  };

  const books = await fetchAllBookOrbitBooks(api, 3, {}, 'collection', 12);
  assert.equal(books.length, 100);
  assert.deepEqual(calls.map(args => args.slice(2)), [
    ['GET', '/collections/12/books?page=0&size=100'],
    ['GET', '/collections/12/books?page=1&size=100'],
  ]);
});

test('failures and malformed pages cannot be mistaken for a complete listing', async () => {
  let page = 0;
  const api = async () => ++page === 1
    ? { ok: true, data: { items: Array.from({ length: 100 }, (_, id) => ({ id })) } }
    : { ok: false, status: 403 };
  await assert.rejects(fetchAllBookOrbitBooks(api, 1, {}, 'smartScope', 8), /HTTP 403/);
  await assert.rejects(
    fetchAllBookOrbitBooks(async () => ({ ok: true, data: {} }), 1, {}, 'smartScope', 8),
    /Invalid BookOrbit book listing/,
  );
  assert.equal(bookOrbitListPath('unknown', 8), null);
  await assert.rejects(fetchAllBookOrbitBooks(api, 1, {}, 'unknown', 8), /Invalid BookOrbit source/);
});
