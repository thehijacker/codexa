# 📚 Codexa

**Your own private reading platform for EPUB books _and_ comics — self-hosted, offline-capable, and built to sync with your e-reader.**

Codexa is a self-hosted EPUB and comic book reader with multi-user support, full offline reading, OPDS browsing, two-way KOReader sync, and built-in dictionary lookup — all in a single lightweight Node.js container. Read in any browser, install it as a PWA, or use the dedicated Android and iOS apps, and pick up exactly where you left off on any of them.

> 📜 Licensed under **AGPL-3.0** · 🐳 One-container Docker deploy · 🔒 No cloud, no tracking — your books stay on your server.

> 🤖 The Android app is approved for production on Google Play and will be available soon at [play.google.com/store/apps/details?id=com.codexa.reader](https://play.google.com/store/apps/details?id=com.codexa.reader).

---

## Why Codexa?

- **🛠️ Its own rendering engine (CXReader).** Codexa doesn't rely on a generic third-party EPUB library. CXReader is purpose-built for reliability, faithful typography, and rock-solid behaviour on slow **e-ink** screens — so awkward real-world EPUBs, fixed-layout manga, and CBZ/CBR comics all render with the same care.
- **📚 Books _and_ comics in one library.** First-class EPUB (including Kobo's **KEPUB**), fixed-layout EPUB, **CBZ & CBR**, and **PDF** — no separate apps.
- **🔄 Real two-way KOReader sync.** A built-in KOSync-compatible server keeps your e-reader and your phone on the same page — no extra software, no cloud.
- **🖥️ Truly works everywhere.** Desktop browsers, mobile PWA, Android (Google Play or sideloaded APK), and iOS IPA, with a one-tap **Display size** control that scales the UI on everything from phones to big e-ink tablets to desktop monitors.
- **🔌 Plays well with your stack.** Browse and download from any OPDS catalogue (Calibre-Web, Komga, Kavita, Ubooquity…) and sync whole folders into shelves.
- **🛰️ Deep BookOrbit integration.** Native library browser, peek books before downloading them, and optional two-way sync of highlights, reading sessions, progress, and status/rating with a self-hosted BookOrbit server.
- **🏠 Self-hosted and private.** Multi-user, JWT-authenticated, and everything — books, covers, highlights, positions — lives on **your** server.

---

## Screenshots

| Library | OPDS Browser | Book Info |
|:---:|:---:|:---:|
| ![Library](docs/screenshots/library.png) | ![OPDS Browser](docs/screenshots/opds_browser.png) | ![Book Info](docs/screenshots/book_info.png) |
| **Reader** | **Dictionary** | **Search** |
| ![Reader](docs/screenshots/reader.png) | ![Dictionary](docs/screenshots/dictionary.png) | ![Search](docs/screenshots/search.png) |
| **TOC** | **Settings** | **E-Ink** |
| ![TOC](docs/screenshots/toc.png) | ![Settings](docs/screenshots/settings.png) | ![E-Ink](docs/screenshots/e-ink.png) |

### Mobile

| Library | Reader | Dictionary | E-Ink |
|:---:|:---:|:---:|:---:|
| ![Mobile Library](docs/screenshots/mobile/library.png) | ![Mobile Reader](docs/screenshots/mobile/reader.png) | ![Mobile Dictionary](docs/screenshots/mobile/dictionary.png) | ![Mobile E-Ink](docs/screenshots/mobile/eink.png) |

---

## Features

### Reading
- **CXReader** — Codexa's own custom-built EPUB engine; replaces epub.js for better reliability and e-ink compatibility; also reads Kobo's **KEPUB** files
- **CBZ & CBR comic books** — read comic archives directly; two-page spread on desktop; automatic CBR→CBZ conversion; ComicInfo.xml metadata
- **PDF documents** — read PDFs with the same paginated, two-page-spread, and continuous-scroll engine as comics, including offline caching (no text layer/search — PDFs are treated as page images, like a comic)
- **Fixed-layout EPUB** — manga, children's books, and art books rendered at pixel-accurate dimensions via CSS transform scaling
- **Exact position restore** — saves the page number per chapter; reopens on the precise page (not just approximate %)
- **Peek mode** — open any book read-only without saving your position, including books not yet downloaded from a connected BookOrbit server or OPDS catalogue
- **Bookmarks** — add, label, and jump to bookmarks; badge shows bookmark count
- **Highlights & annotations** — highlight in four colours (yellow, green, blue, pink) with optional notes; tap any highlight to edit or delete
- **Search** — full-text search within a book with result navigation and back/accept buttons
- **Dictionary lookup** — double-click a word on desktop, or select text and tap the dictionary icon on mobile; supports multiple local StarDict dictionaries (`.ifo/.idx/.dict`); defaults to dictionaries matching a book's own language on first open
- **CJK-aware word selection** — proper Chinese/Japanese/Korean word segmentation (not just per-character), including single-character lookups; on mobile, selecting CJK text uses the OS's own native selection handles so a selection can be extended/adjusted normally
- **Footnote popup** — inline footnote and endnote display without leaving the page
- **Bionic reading** — emphasises word prefixes to guide the eye for faster reading
- **Two-page spread** — optional side-by-side layout for wider screens
- **Fullscreen mode** — hides all browser chrome for distraction-free reading
- **Auto-hide toolbar** — header slides away while reading; reappears on hover/tap

### Themes & Display
- **7 reading themes** — Light, Sepia, Dark, Sepia Dark, Midnight, Nord, plus a fully **Custom** theme with free colour picking
- **E-ink mode** — high-contrast black-and-white optimised for e-ink displays
- **Display size** — one-tap UI scaling (Auto / Large / Larger / Largest) that works on phones, tablets, e-ink readers, **and desktop browsers**
- **Custom fonts** — upload `.ttf/.otf/.woff/.woff2` fonts (admin); apply per-book
- **Extensive text settings** — font, size, line height, letter spacing, paragraph indent, paragraph spacing, justification, hyphenation with per-language support
- **Configurable status bar** — up to 6 overlay slots (top/bottom × left/centre/right) showing any combination of: chapter/book page numbers, pages left, progress %, time-to-finish, title, author, chapter, and current time
- **Screen edge padding** — adjustable insets for curved-screen phones and notches
- **Reader-settings presets** — save your theme, font, and layout settings as a named preset and switch between them from the Theme tab; presets sync across all your devices, while each device remembers which preset it's currently using (dictionary selection is not included in presets)

### Sync & Progress
- **Automatic progress saving** — position saved locally and to the server; restored on any device
- **KOReader sync** — built-in KOSync-compatible server; connect KOReader devices with no extra software
- **External KOSync server** — also works with a separate KOSync server; conflict-resolution dialog when positions differ
- **BookOrbit extended sync** — optional two-way sync of highlights, reading sessions, live reading progress, and book status/rating with a self-hosted BookOrbit server
- **BookOrbit Dash** — a dedicated sidebar panel showing account-wide reading stats from a connected BookOrbit server: current/longest reading streak, an editable yearly reading goal, a currently-reading shelf, library overview (books/authors/series/storage), and a daily highlight pulled from your synced annotations
- **Interrupted session recovery** — banner on next visit offers one-tap resume if the app was closed mid-chapter

### Offline & Mobile
- **Offline reading** — download any book to the device; read without internet
- **PWA** — installable on desktop and mobile; safe-area and notch handling for iOS/Android
- **Android app** — available on [Google Play](https://play.google.com/store/apps/details?id=com.codexa.reader) (coming soon) or as a sideloadable APK; volume-key page navigation, portrait lock, screen-on toggle, hardware e-ink mode toggle, custom HTTP headers on the server connection with SSO login staying inside the app
- **iOS app** — sideload or install via TestFlight
- **Responsive layout** — works on phones, tablets, and desktops

### Library
- **Multi-user** — JWT authentication, per-user library and settings
- **Shelves** — organise books into named collections; bulk assign/remove
- **OPDS browser** — browse any OPDS catalogue (Calibre-Web, Komga, Kavita, …) with a BookOrbit-style folder tree and card grid, grid density control, and per-server reachability status; download books or peek them read-only without downloading first
- **OPDS shelf sync** — bulk-download an entire OPDS folder into a shelf; stale-book detection
- **BookOrbit library browser** — native browsing of a self-hosted BookOrbit server's libraries, smart scopes, collections, series, and authors; add books to Codexa, peek them without downloading, edit collection membership, and view any book on BookOrbit directly
- **BookOrbit collection/smart scope sync** — link a shelf to a BookOrbit collection or smart scope for one-click resync, same as OPDS shelf sync
- **Related books** — "Similar books," "More by author," and "More in series" recommendations powered by a connected BookOrbit server, shown in both the local book info modal and the BookOrbit library's own book detail modal
- **Reading statistics** — time read, pages turned, sessions, books started/finished, per-book history
- **Series support** — series name, number, and one-click series filter
- **Sort & search** — sort by date, title, author, progress, or series; real-time library search

### Admin
- **User management** — view all users, delete accounts
- **Font management** — upload (with progress indicator) and delete custom fonts available to all users
- **Dictionary management** — upload StarDict ZIP archives (with progress indicator), delete dictionaries
- **Registration control** — enable or disable new-user sign-up
- **OIDC login** — optional single sign-on via Google, Apple, or a self-hosted provider (Dex, Authelia, Keycloak, ...), alongside local accounts — see [OIDC Login](#oidc-login-google-apple-self-hosted) below

### Internationalisation
- **8 languages** — English, Slovenian, German, Spanish, French, Italian, Portuguese, Simplified Chinese

---

## Quick Start with Docker

### 1. Copy the sample compose file

```bash
cp docker-compose.sample.yaml docker-compose.yaml
```

### 2. Set a strong JWT secret

```bash
# Generate a secret:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# …or:
openssl rand -hex 64
```

Paste the output into `docker-compose.yaml` as the value of `JWT_SECRET`.

### 3. Start

```bash
docker compose up -d
```

Codexa is now running at **http://localhost:3000**.  
Register the first account — there is no default admin password.

---

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | **yes** | — | Long random string (≥ 64 chars). Changing it invalidates all sessions. |
| `PORT` | no | `3000` | TCP port the server listens on |
| `DATA_DIR` | no | `./data` | Path to persistent data (books, covers, fonts, DB) |
| `CORS_ORIGIN` | no | _(same-origin)_ | Allowed CORS origin, e.g. `https://books.example.com` |
| `DEBUG` | no | `false` | Set to `true` to enable verbose browser console logging (all `[reader]`, `[api]`, `[kosync]`, etc. messages). Off by default — only warnings and errors are shown. |
| `OIDC_PROVIDERS` | no | _(none)_ | Comma-separated list of OIDC provider keys to enable. See [OIDC Login](#oidc-login-google-apple-self-hosted). |
| `OIDC_BASE_URL` | only if `OIDC_PROVIDERS` set | — | Public base URL Codexa is reachable at, used to build the OIDC callback URL |
| `OIDC_<KEY>_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_NAME` | only for each key in `OIDC_PROVIDERS` | — | Per-provider OIDC credentials and display name |

---

## OIDC Login (Google, Apple, self-hosted)

Codexa supports logging in via any standard OIDC provider as an alternative to local
username/password registration — Google, Apple, or a self-hosted identity provider you
run yourself. It's disabled by default; setting `OIDC_PROVIDERS` turns it on.

The first successful login from a given identity is matched against existing accounts in
two steps:

1. **By provider + subject ID** — if this exact identity has logged in before, it reuses
   that account.
2. **By verified email** — otherwise, if the provider vouches for the email (sends
   `email_verified: true`) and it matches the email on an existing, not-yet-linked local
   account (set via Settings → Email, or at registration), that account is linked instead
   of creating a new one. This is what lets someone who already registered locally start
   using OIDC without ending up with a second, empty account — the emails on both sides
   (Codexa's Settings and your OIDC provider's user config) just need to match.

If neither matches, a new account is **auto-created**. There is no separate admin approval
step inside Codexa — access control lives at whichever identity provider you point Codexa
at. That's exactly what makes a self-hosted provider with a fixed user list (below) work as
a way to "predefine" who can log in.

> **Note:** an email match only ever links to an account that isn't already linked to some
> other identity — it won't reassign an account that's already tied to a different provider.
> A provider that doesn't assert `email_verified` (or doesn't send an email at all) always
> falls through to creating a new account, never links by an unverified email — otherwise a
> malicious or misconfigured provider could take over an unrelated local account just by
> claiming its email address.

> **Note:** Facebook isn't included — it doesn't implement standard OIDC (no discovery
> document, no `id_token`), so it can't use this generic integration.

> **Note:** An account created via OIDC has no local password, so it can't be used to log
> in to [KOReader Sync](#koreader-sync-setup) (which authenticates with username/password).
> Set one via Settings → Change Password first if you need that account to also work with
> KOReader Sync.

### Example: Google

1. Create an OAuth 2.0 Client ID in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (Web application), with an authorized redirect URI of `https://<your-domain>/api/auth/oidc/google/callback`.
2. Set the environment variables:
   ```
   OIDC_PROVIDERS=google
   OIDC_BASE_URL=https://<your-domain>
   OIDC_GOOGLE_ISSUER=https://accounts.google.com
   OIDC_GOOGLE_CLIENT_ID=<your client id>
   OIDC_GOOGLE_CLIENT_SECRET=<your client secret>
   OIDC_GOOGLE_NAME=Google
   ```

Apple (Sign in with Apple) works the same way with `OIDC_APPLE_ISSUER=https://appleid.apple.com`,
except Apple's "client secret" is itself a JWT you generate and sign with an Apple private
key, valid for at most 6 months — you'll need to regenerate and redeploy it periodically.

### Example: self-hosted provider with predefined users (Dex)

If you'd rather not open the door to a third-party account at all, you can run your own
minimal OIDC provider with a fixed list of users you define yourself. [Dex](https://dexidp.io/)
is a good fit for this — a single small container, no database, users declared directly in
its config file.

`dex-config.yaml`:
```yaml
issuer: https://auth.example.com/dex
storage:
  type: memory
web:
  http: 0.0.0.0:5556
staticClients:
  - id: codexa
    name: Codexa
    secret: <a-random-client-secret>
    redirectURIs:
      - https://books.example.com/api/auth/oidc/dex/callback
enablePasswordDB: true
staticPasswords:
  - email: "alice@domain.com"
    # Generate with: htpasswd -bnBC 10 "" '<password>' | tr -d ':\n'
    hash: "<bcrypt hash>"
    username: "alice"
    userID: "1"
  - email: "bob@doma.com"
    hash: "<bcrypt hash>"
    username: "bob"
    userID: "2"
```

Add Dex as a second service in your `docker-compose.yaml`:
```yaml
services:
  codexa:
    image: ghcr.io/thehijacker/codexa:latest
    # ...existing config...
    environment:
      JWT_SECRET: "..."
      OIDC_PROVIDERS: "dex"
      OIDC_BASE_URL: "https://books.example.com"
      OIDC_DEX_ISSUER: "https://auth.example.com/dex"
      OIDC_DEX_CLIENT_ID: "codexa"
      OIDC_DEX_CLIENT_SECRET: "<the same random client secret as above>"
      OIDC_DEX_NAME: "Home SSO"

  dex:
    image: dexidp/dex:latest
    container_name: dex
    restart: unless-stopped
    ports:
      - "5556:5556"
    volumes:
      - ./dex-config.yaml:/etc/dex/config.yaml
    command: ["dex", "serve", "/etc/dex/config.yaml"]
```

Put both `books.example.com` and `auth.example.com` behind your reverse proxy (see
[Self-Hosting Behind a Reverse Proxy](#self-hosting-behind-a-reverse-proxy)) with HTTPS —
OIDC providers generally require HTTPS redirect URIs. Only the usernames/passwords you add
to `staticPasswords` will ever be able to log in to Codexa this way.

---

## Data Directory Layout

```
data/
├── codexa.db          # SQLite database (WAL mode)
├── books/             # Uploaded EPUB and CBZ files (CBR auto-converted to CBZ)
├── covers/            # Extracted cover images
├── fonts/             # User-uploaded fonts (.ttf/.otf/.woff/.woff2)
└── dictionaries/      # StarDict dictionary files (.ifo / .idx / .dict)
```

Mount this directory as a Docker volume to persist all data across container updates.

---

## Updating

```bash
docker compose pull
docker compose up -d
```

The database schema is migrated automatically on startup.

---

## KOReader Sync Setup

Codexa includes a built-in KOSync-compatible server.

In KOReader:
1. Go to **Tools → KOReader Sync**
2. Set **Custom sync server** to your Codexa URL (e.g. `https://books.example.com`)
3. Log in with the same credentials you use on Codexa

Optionally, you can also connect to an external KOSync server in **Settings → KOReader Sync**.

---

## OPDS

Navigate to **Online library** in the sidebar (it appears once at least one server is configured).
Add any OPDS-compatible catalogue (Calibre-Web, Komga, Kavita, Ubooquity, Bookwyrm…) in **Settings → OPDS Servers**.

Browse via a folder tree on the left and a card grid on the right. Every book card can be
**downloaded** or **peeked** — Peek opens the book read-only without downloading it into your
library at all; the file is fetched to a temporary location and cleaned up automatically as soon
as you close the reader.

---

## BookOrbit

Add your server URL in **Settings → BookOrbit** to enable the native library browser (libraries, smart scopes, collections, series, authors) and, optionally, two-way sync of highlights, reading sessions, reading progress, and status/rating. Requires BookOrbit **v2.1.0 or higher**.

Once extended sync is on, two more things become available:
- **BookOrbit Dash** — a sidebar panel with account-wide reading stats: reading streak, an editable yearly reading goal, currently-reading shelf, library overview, and a daily highlight from your synced annotations. These use BookOrbit's own reading-session and dashboard APIs — since Codexa already reports reading sessions to BookOrbit as part of extended sync, the numbers reflect real activity from the moment sync is turned on.
- **Related books** — a "Related" tab (Similar books / More by author / More in series) on book detail views, both for your own library and while browsing BookOrbit's catalogue. Powered by BookOrbit's recommendation engine — books with too little reading/rating history may show fewer or no results, and a very old BookOrbit server without these APIs will simply show an empty tab.

---

## Dictionary Lookup

Place StarDict dictionary files in `data/dictionaries/`.  
Supported extensions: `.ifo`, `.idx`, `.dict`, `.dict.dz`

Enable and reorder dictionaries in **Reader → Settings → Dictionaries**.

Admins can upload packaged dictionaries (ZIP archives containing the StarDict files) directly from the Settings page.

---

## Offline Reading

Open any book or comic's detail panel and tap **Download for offline reading**. The file is cached by the service worker and will be available even without a network connection. Remove cached books from the same panel, or from the **Downloaded** shelf in the sidebar.

---

## Keyboard Shortcuts

Shortcuts work when focus is not inside a text input.

### Navigation

| Key | Action |
|---|---|
| `→` / `Space` / `Page Down` | Next page |
| `←` / `Page Up` | Previous page |

### Panels

| Key | Action |
|---|---|
| `K` | Open / close Table of Contents |
| `I` | Open / close in-book Search |
| `S` | Open / close Reader Settings |
| `Esc` | Close open panel — or return to Library |

### View

| Key | Action |
|---|---|
| `F` | Toggle fullscreen |

---

## Building from Source

```bash
git clone https://github.com/thehijacker/codexa.git
cd codexa
cp .env.example .env
# Edit .env and set JWT_SECRET
npm install
npm start
```

Requires **Node.js ≥ 18**.

---

## Self-Hosting Behind a Reverse Proxy

Codexa serves plain HTTP. Put it behind **nginx**, **Caddy**, or **Traefik** for HTTPS.

Minimal nginx example:

```nginx
server {
    listen 443 ssl;
    server_name books.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        client_max_body_size 300M;
    }
}
```

---

## License

[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) © Andrej Kralj

You are free to use, modify, and self-host this software. If you distribute a modified version (including over a network), you must release the source under the same licence.
