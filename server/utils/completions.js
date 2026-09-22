// Standalone on purpose — server/utils/bookCompletion.js requires server/services/bookorbitSync.js
// (for triggerSync), and bookorbitSync.js also needs to call logCompletion from its own
// BookOrbit-pull-status path. Putting logCompletion here instead of in bookCompletion.js lets
// both of those require it without creating a require() cycle between them.

// Logs one permanent book_completions row per genuine crossing into 'read' — called from every
// place that flips read_status to 'read' (bookCompletion.js's threshold path, the manual status
// route, and the BookOrbit-pull sync path), so "books finished" stays a true lifetime count even
// after the book is later deleted or re-hashed (see book_completions' own comment in db.js).
// `book` must have {id, title, author, read_status} — the read_status check is what makes this
// safe to call unconditionally from callers that already guard their own write on the same
// "wasn't already read" condition: a redundant call here is a no-op, not a duplicate row.
function logCompletion(db, userId, book, documentHash) {
  if (book.read_status === 'read') return;
  db.prepare(
    'INSERT INTO book_completions (user_id, book_id, document_hash, title, author) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, book.id, documentHash, book.title, book.author || '');
}

module.exports = { logCompletion };
