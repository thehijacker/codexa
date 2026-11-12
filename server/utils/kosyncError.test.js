const test = require('node:test');
const assert = require('node:assert/strict');
const { describeKOSyncError } = require('./kosyncError');

test('reports BookOrbit hash and route errors without logging the whole response', async () => {
  const missingBook = Response.json({
    message: 'Book not found for the given document hash',
    path: '/api/v1/koreader/syncs/progress',
    requestId: 'private-request-id',
  }, { status: 404 });
  assert.equal(await describeKOSyncError(missingBook), 'message="Book not found for the given document hash"');

  const missingRoute = Response.json({ message: 'Cannot PUT /api/v1/koreader/syncs/progress' }, { status: 404 });
  assert.equal(await describeKOSyncError(missingRoute), 'message="Cannot PUT /api/v1/koreader/syncs/progress"');
});

test('reports App Attest codes and redacts credentials and log control characters', async () => {
  const response = Response.json({
    message: 'Rejected user secret key\nanother line',
    errorCode: 'APP_ATTEST_REQUIRED',
  }, { status: 403 });
  assert.equal(
    await describeKOSyncError(response, ['user', 'secret', 'key']),
    'message="Rejected [redacted] [redacted] [redacted] another line" code="APP_ATTEST_REQUIRED"',
  );
});

test('handles empty, invalid, oversized and unreadable responses', async () => {
  assert.equal(await describeKOSyncError(new Response(null, { status: 404 })), 'response body is empty');
  assert.equal(await describeKOSyncError(new Response('<html>Not found</html>', { status: 404 })), 'response body is not valid JSON');
  assert.equal(await describeKOSyncError(Response.json({ path: '/some/path' }, { status: 404 })), 'response JSON contains no error message or code');
  assert.equal(await describeKOSyncError(new Response('a'.repeat(8193), { status: 500 })), 'response body exceeds diagnostic limit');

  const broken = new ReadableStream({ start(controller) { controller.error(new Error('read failed')); } });
  assert.equal(await describeKOSyncError(new Response(broken, { status: 500 })), 'response body could not be read');
});

test('limits the length of server-supplied diagnostic text', async () => {
  const description = await describeKOSyncError(Response.json({ message: 'a'.repeat(500) }));
  assert.equal(description, `message="${'a'.repeat(300)}"`);
});
