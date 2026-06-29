# BookOrbit extended sync — session handoff

Status of the Codexa ↔ BookOrbit "extended sync" feature (annotations, reading sessions, book
status/rating). Progress sync already worked via KOSync and was **not** changed.

## TL;DR

Codexa now syncs **highlights, reading sessions, and read-status/rating** to a self-hosted
**BookOrbit** backend by acting as a **second BookOrbit web reader** (its JWT web API), because
CXReader is CFI-native like BookOrbit's own Foliate reader. It is **opt-in per user** and gated on
BookOrbit **account** credentials. Code is written; **must be built/run on the server** (per
`feedback_build_on_server` memory — `better-sqlite3` is Linux-built and won't load on Windows, so it
can't run locally). Needs end-to-end testing on the server.

## Key architecture facts (don't relitigate these)

- **BookOrbit is third-party**, self-hosted by the user at `https://bookorbit.kralj.top`. Its full
  source is in `temp/bookorbit-main` (NestJS server + Vue/Foliate client). Do **not** invent BookOrbit
  endpoints or change BookOrbit — Codexa must conform to BookOrbit's real API.
- **Do NOT use the KOReader plugin API for annotations.** `KoreaderAnnotationDto.posFormat` is
  `IsIn(['xpointer','pdf'])` — it rejects CFI. Codexa (CXReader) produces **epubcfi range CFIs**
  (`reader_v4.js` ~line 739/2190), so it must use BookOrbit's **web API** (origin `"web"`, CFI-native).
- The KOReader plugin (`temp/koreader-plugin`) was only a reference for what BookOrbit can sync.

## Real BookOrbit web API Codexa calls

Base = `<server>/api/v1` (derived from `kosync_url` by stripping `/koreader`). Auth = **JWT** via
`Authorization: Bearer` (accepted per BookOrbit `jwt.strategy.ts`).

- Auth: `POST /auth/login {username,password}` → `access_token`/`refresh_token` cookies; `POST /auth/refresh`.
- Annotations: `GET/POST /books/:bookId/annotations`, `PATCH/DELETE …/:id`. Create body
  `{cfi,text,color,style,note,chapterTitle,bookFileId}`. **GET returns a plain array, no percentage.**
  Styles: `highlight|underline|strikethrough|squiggly|invert`. Colors: names `yellow/green/blue/pink`
  (= Codexa's). Create requires non-empty `text`.
- Sessions: `POST /books/:bookId/sessions {startedAt(ISO), durationMinutes(1-1440), endProgress?}`.
- Read status: `PATCH /books/:id/status {status}` — `unread|want_to_read|reading|on_hold|rereading|read|skimmed|abandoned`.
- Rating: `POST /books/bulk-set-rating {bookIds:[id], rating}`.

### Book-id mapping (Codexa book → BookOrbit bookId/fileId)
Resolution order (cached in `bookorbit_sync_state`):
1. cached `bo_book_id`/`bo_file_id`;
2. **`POST <kosync_url>/plugin/match-check`** by partial-MD5 `books.file_hash_md5` — auth
   `x-auth-user`/`x-auth-key: md5(kosync_password_enc)` (the KOReader sync sub-account creds);
   returns `{matches:[{hash,bookId,bookFileId}]}`. **This is the primary path** (covers all books
   BookOrbit knows, not just OPDS-downloaded).
3. fallback: parse `book_opds_sources.acq_href` (`…/opds/<bookId>/download?fileId=<fileId>`).

## What was implemented (Codexa side — this repo)

- **`server/services/bookorbitSync.js`** (the whole client): account login + Bearer/refresh, pacing
  (150ms/call) + 429 backoff (Retry-After), `match-check` + OPDS mapping with caching, per-book
  reconcile of annotations (full two-way), sessions (one-way up, only "real" ≥60s & ≥2 pages),
  status (PATCH) + rating (bulk-set-rating). `runSync(userId, {bookId})` scopes to one book;
  no bookId = full sweep. `triggerSync(userId, bookId)` is fire-and-forget.
- **`server/db.js`** migrations: `user_settings.bookorbit_sync_enabled`,
  `bookorbit_account_username`, `bookorbit_account_password_enc`; `annotations.{bo_id,style,updated_at,
  deleted,origin}`; `books.{read_status,rating,status_modified}`; table `bookorbit_sync_state`
  (`bo_book_id,bo_file_id,ann_watermark,sessions_watermark,state_watermark,last_sync`).
- **Triggers (scoped to the affected book):** `routes/annotations.js` (POST/PUT/DELETE; DELETE
  soft-deletes when sync on), `routes/stats.js` (session close), `routes/books.js` (status/rating
  PUTs + **on book open** `/:id/opened`), `routes/settings.js` (on enable). Background **full** sweep
  every 30 min in `server/index.js`.
- **Settings:** `routes/settings.js` GET/PUT carry the toggle + account creds. UI in
  `public/index.html` + `public/js/settings.js` (BookOrbit block: account username/password + toggle,
  gated on URL + saved account password). i18n keys `settings.bookorbit_*` and `library.status_*` in
  all 7 `public/locales/*.json`.
- **Status/rating UI:** `public/js/library.js` — status `<select>` + star rating in the book info
  modal, status pill + stars on cards (`renderCardBadges`/`refreshCardBadges`). Codexa status values
  aligned to BookOrbit: `want_to_read|reading|read|abandoned`.
- **Annotation list 0%-location fix:** pulled annotations have no percentage; `renderAnnotationList`
  now computes location via `pctFromCfi()` → `CXReader.pctForCfi(cfi)` (new method in
  `public/js/cxreader/index.js`) or epub.js `book.locations.percentageFromCfi`.

## Behavior / known limitations

- Annotations: **full two-way** (push new/edit/delete, pull inserts + reflects server deletes).
- Status/rating: **push on local change; adopt remote only when local is empty** (BookOrbit web API
  doesn't expose per-field updatedAt for true newest-wins). Open question below.
- Sessions: **one-way up**, deduped by local session id watermark.
- Annotation edit push sends only color/style/note (Codexa highlight text/range are immutable once made).
- Pulled-annotation list location is **chapter-level** (CXReader CFIs are chapter-anchored), not exact.
- This is BookOrbit's **internal SPA API** → coupled to the BookOrbit version the user runs.

## TEST CHECKLIST (on the server, after build)

1. Settings → BookOrbit: enter **account** username/password (separate from KOReader sync creds),
   tick the toggle, save. Toggle should be disabled until URL + account password are saved.
2. Open a book that exists on BookOrbit → log shows `[bookorbit] … synced book <id>` (NOT all books).
   If it logs `book <id> is not in your BookOrbit library (skipping)` → its `file_hash_md5` didn't
   match BookOrbit (chase hash mismatch: confirm `books.file_hash_md5` == the `7d2f8a0b…`-style hash
   progress sync uses).
3. Make a highlight in Codexa → log `book <id>: annotations pushed 1, pulled/removed 0`; it appears in
   BookOrbit's web reader. A `POST …/annotations -> HTTP 4xx` line means BookOrbit rejected it.
4. Make a highlight in BookOrbit's web reader → next sync of that book (reopen, or the 30-min sweep)
   pulls it into Codexa; verify the annotation **list shows a real chapter %**, not 0%.
5. Delete a highlight on each side → propagates (Codexa delete = soft-delete tombstone then removed).
6. Set read status + star rating in Codexa (book info modal) → lands in BookOrbit. Card shows pill + stars.
7. Read a book ≥60s with ≥2 page turns, close it → a reading session POSTs once (no duplicate on reopen).
8. Confirm **no 429 storm** and that one action syncs **one** book, not 91. The only full sweep is the
   30-min background pass (paced).
9. Opt-out: toggle off → zero BookOrbit calls; annotation DELETE hard-deletes again.

## Possible next steps / open questions

- Make status/rating **fully bidirectional** (poll BookOrbit `/books/:id` detail each run for remote
  changes) instead of adopt-when-empty.
- For very large libraries, limit the 30-min full sweep to recently-opened/changed books.
- Decide whether to persist computed annotation `pct` (currently render-time only).
- Verify CXReader correctly renders BookOrbit-origin highlights' precise (non-chapter) CFIs.

## Reference

- Memory: `project_bookorbit_extended_sync` (in `.claude/.../memory/`) has the condensed version.
- BookOrbit source: `temp/bookorbit-main` (annotation controller/service/dto, `koreader-plugin.*`,
  `auth/jwt.strategy.ts`, `opds.controller.ts`, `packages/types/src/{annotation,koreader}.ts`).
