const MAX_ERROR_BYTES = 8192;
const MAX_MESSAGE_LENGTH = 300;

async function describeKOSyncError(response, secrets = []) {
  if (!response.body) return 'response body is empty';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_ERROR_BYTES) {
        await reader.cancel();
        return 'response body exceeds diagnostic limit';
      }
      chunks.push(value);
    }
  } catch {
    return 'response body could not be read';
  } finally {
    reader.releaseLock();
  }

  if (!length) return 'response body is empty';
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return 'response body is not valid JSON';
  }

  function safeText(value) {
    if (typeof value !== 'string') return null;
    let text = value;
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret) text = text.replaceAll(secret, '[redacted]');
    }
    return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, MAX_MESSAGE_LENGTH);
  }

  const message = safeText(data?.message) || safeText(data?.error);
  const errorCode = safeText(data?.errorCode);
  if (!message && !errorCode) return 'response JSON contains no error message or code';
  return [message && `message=${JSON.stringify(message)}`, errorCode && `code=${JSON.stringify(errorCode)}`]
    .filter(Boolean).join(' ');
}

module.exports = { describeKOSyncError };
