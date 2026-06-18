# Codexa Reader — Complete Guide

This guide covers every feature available inside the Codexa EPUB reader. Open any book from the library to enter the reader.

---

## Table of Contents

1. [Interface Overview](#interface-overview)
2. [Navigation](#navigation)
3. [Table of Contents](#table-of-contents)
4. [Bookmarks](#bookmarks)
5. [Highlights & Annotations](#highlights--annotations)
6. [Search](#search)
7. [Dictionary Lookup](#dictionary-lookup)
8. [Footnotes](#footnotes)
9. [Reading Progress](#reading-progress)
10. [Jump to Position](#jump-to-position)
11. [Fullscreen Mode](#fullscreen-mode)
12. [Reading Settings](#reading-settings)
    - [Theme Tab](#theme-tab)
    - [Text Tab](#text-tab)
    - [Page Tab](#page-tab)
    - [Device Tab](#device-tab)
    - [Status Bar Tab](#status-bar-tab)
    - [Dictionaries Tab](#dictionaries-tab)
13. [Status Bar Overlays](#status-bar-overlays)
14. [Keyboard Shortcuts](#keyboard-shortcuts)
15. [Offline Reading](#offline-reading)
16. [KOReader Sync](#koreader-sync)
17. [Android App Features](#android-app-features)

---

## Interface Overview

![Reader interface overview](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/overview.png)

The reader has three main areas:

- **Header bar** — buttons for TOC, bookmarks, highlights, search, jump, settings, fullscreen, and back to library. Can be set to auto-hide while reading.
- **Reading area** — the book content rendered by epub.js. The left and right edges are tap/click zones for page navigation.
- **Status bar** — configurable overlay slots at the top and bottom of the screen showing page numbers, progress, time estimates, and more.

---

## Navigation

![Navigation tap zones](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/navigation.png)

### Tap / Click

- **Right half of the screen** → next page
- **Left half of the screen** → previous page

The tap zones are narrow strips along the edges. The centre of the screen is reserved for text selection and dictionary lookups.

### Swipe (touch)

- Swipe **left** → next page
- Swipe **right** → previous page

### Keyboard

| Key | Action |
|---|---|
| `→` / `Space` / `Page Down` | Next page |
| `←` / `Page Up` | Previous page |
| `Esc` | Close open panel, or return to library |
| `K` | Toggle Table of Contents |
| `I` | Toggle Search |
| `S` | Toggle Settings |
| `F` | Toggle fullscreen |

### Mouse Wheel

Mouse wheel page turning can be enabled in **Settings → Device → Mouse wheel navigation**.

### Volume Keys (Android)

When using the Codexa Android app, the hardware volume keys navigate pages. The direction can be swapped in **Settings → Device → Swap volume key direction**.

---

## Table of Contents

![Table of contents sidebar](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/toc.png)

Tap the **TOC button** (☰) in the header, or press `K`, to open the table of contents sidebar.

- The current chapter is highlighted.
- Tap any chapter to jump directly to it.
- The sidebar closes automatically after navigation.

---

## Bookmarks

![Bookmarks sidebar](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/bookmarks.png)

Tap the **Bookmarks button** (🔖) in the header to open the bookmarks sidebar. The button badge shows the number of saved bookmarks.

### Adding a Bookmark

Tap the **+** button inside the bookmarks sidebar to save your current reading position. The bookmark is labelled with the current chapter title by default.

### Managing Bookmarks

Each bookmark in the list shows its label and position (percentage). Available actions:

- **Tap the label** — jump to that position. A **Back** / **Accept** button pair appears so you can return to where you were or confirm the new position.
- **Edit label** — tap the pencil icon to rename a bookmark in place.
- **Delete** — tap the × button to remove a bookmark.

Bookmarks are stored per user and are available on all devices.

---

## Highlights & Annotations

![Annotation toolbar](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/annotation-toolbar.png)

### Creating a Highlight

1. Select text by pressing and holding (mobile) or clicking and dragging (desktop).
2. The **annotation toolbar** appears above or below the selection.
3. Tap a colour button to save the highlight immediately.

Available colours: **Yellow**, **Green**, **Blue**, **Pink**.

### Adding a Note

After the toolbar appears, tap the **pencil (✎)** button instead of a colour. A note editor opens where you can type up to 1 000 characters. Save with the **Save** button. The highlight is saved in the colour that was last selected, defaulting to yellow.

### Viewing All Annotations

![Annotations sidebar](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/annotations-sidebar.png)

Tap the **Highlights button** in the header to open the annotations sidebar. All highlights are listed in reading order with a colour indicator, the highlighted text, and any attached note.

Tap an entry to jump to its position in the book.

### Editing or Deleting a Highlight

Tap an existing highlight in the text. An **edit sheet** slides up from the bottom showing:

- The highlighted text
- Colour picker — tap a colour to change it
- **Edit note** button — opens the note editor
- **Delete** button — removes the highlight permanently

### Dictionary Lookup from Selection

After selecting text, tap the **magnifying glass (🔍)** button in the annotation toolbar to look up the selected word or phrase in the dictionary without saving a highlight.

---

## Search

![Search sidebar](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/search.png)

Tap the **Search button** (🔍) in the header, or press `I`, to open the search sidebar.

### Running a Search

Type a word or phrase in the search field and press **Enter** or tap the search button. The reader scans all chapters progressively, showing a running count as it goes (e.g. *Searching… 14 / 230*).

### Navigating Results

Results are grouped by chapter. Each result shows the surrounding excerpt with the match highlighted. Tap any result to jump to that location.

When you navigate to a result:

- A **Back arrow** (←) appears so you can return to your previous reading position.
- An **Accept** (✓) button keeps the new position and dismisses the back pointer.

### Closing Search Without Navigating

Close the sidebar with the **×** button or press `Esc`. Your reading position is unchanged.

---

## Dictionary Lookup

![Dictionary popup](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/dictionary.png)

### Looking Up a Word

Double-tap any word in the text. A bottom sheet slides up showing all definitions found across your enabled dictionaries.

- If multiple dictionaries are enabled, each result is labelled with its dictionary name.
- If no match is found, Codexa shows words with similar spelling.

### Configuring Dictionaries

Open **Settings → Dictionaries** to enable, disable, and reorder your installed dictionaries. Dictionaries higher in the list are shown first.

Admins can install new dictionaries from the Settings page by uploading a ZIP archive containing the StarDict files (`.ifo`, `.idx`, `.dict`).

---

## Footnotes

![Footnote popup](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/footnote.png)

Tap any footnote or endnote marker in the text. A popup slides up from the bottom displaying the note content inline — you don't need to leave your reading position. Tap **×** or anywhere outside the popup to dismiss it.

---

## Reading Progress

### Automatic Saving

Your position is saved automatically as you read and whenever you close the book. It is restored the next time you open the book on any device.

### Progress Indicator

The current reading percentage is shown in the status bar (configurable) and in the **Jump to position** panel. A thin progress bar can optionally be shown at the top or bottom of the screen.

### Interrupted Session Recovery

If you close the browser or app unexpectedly mid-chapter, Codexa shows a **resume banner** the next time you visit the library on any device. The banner shows the book title and your last percentage. Tap **Resume** to jump back in, or **Dismiss** to ignore it.

---

## Jump to Position

![Jump to position panel](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/jump-pct.png)

Tap the **percentage button** (%) in the header to open the jump panel.

- The slider shows your current position in the book.
- Drag the slider to any position and release to jump.
- Chapter markers on the slider show chapter boundaries.
- **Previous chapter** (‹‹) and **Next chapter** (››) buttons jump to the start of adjacent chapters.

---

## Fullscreen Mode

Tap the **fullscreen button** (⛶) in the header, or press `F`, to enter fullscreen. The browser chrome and address bar are hidden, maximising the reading area.

Press `F` again or `Esc` to exit fullscreen. A small exit button also appears in the corner.

---

## Reading Settings

![Settings panel](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/settings.png)

Tap the **Settings button** (⚙) in the header, or press `S`, to open the settings panel. Settings are organised into six tabs.

Settings apply globally. If you change a setting for a specific book and later want to go back to the global default, tap **Reset for this book** at the top of the settings panel.

---

### Theme Tab

![Theme settings](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/settings-theme.png)

**Theme** — choose one of six built-in colour schemes:

| Theme | Description |
|---|---|
| Light | White background, dark text |
| Sepia | Warm cream background, dark text |
| Dark | Dark grey background, light text |
| Sepia Dark | Warm dark background, light text |
| Midnight | Pure black background, light text |
| Nord | Cool blue-grey, muted palette |

**Override book styles** — forces the reader's fonts and colours on books that define their own CSS. Useful for books with hard-coded colours that don't adapt to dark themes.

**E-ink mode** — switches the entire interface to high-contrast black and white. Disables animations and colour transitions. Recommended for e-ink display devices.

**Page gap shadow** — shows a thin shadow along the book spine in two-page spread mode.

---

### Text Tab

![Text settings](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/settings-text.png)

**Font** — select from system fonts and any custom fonts uploaded by an admin. Each book can use a different font.

**Font size** — drag the slider to set the base text size (12 – 36 px). The current value is shown next to the slider.

**Line spacing** — controls vertical space between lines (1.0 – 3.0). Larger values give text more breathing room.

**Letter spacing** — adds horizontal space between characters (0 – 10 px). Useful for some dyslexia-friendly fonts.

**Paragraph indentation** — toggles a first-line indent. When enabled, a secondary slider sets the indent depth (0.5 – 4 em).

**Paragraph spacing** — adds extra vertical space between paragraphs (0 – 3 em).

**Chapter heading spacing** — when enabled, compresses the whitespace before chapter headings.

**Hide empty lines** — collapses paragraphs that contain only whitespace, reducing unnecessary vertical gaps.

**Left-align text** — disables CSS text justification and forces left-aligned text. Useful if hyphenation is off and justified text leaves large gaps.

**Word hyphenation** — enables automatic hyphenation at line breaks. The **language** dropdown lets you select the hyphenation dictionary language (auto-detected, or choose from: Slovenian, English, German, French, Italian, Spanish, Portuguese, Dutch, Polish, Czech, Croatian, Slovak, Russian, Ukrainian).

**Bionic reading** — bolds the first ~40% of each word. The eye jumps from bold prefix to bold prefix, which some readers find increases reading speed.

---

### Page Tab

![Page/layout settings](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/settings-page.png)

**Page layout** — toggle between **Single page** and **Two pages** (spread). Two-page mode shows left and right pages side by side, like an open book.

**Margins** — sets the horizontal margin between the text and the edge of the reading area (0 – 120 px).

**Auto-hide toolbar** — hides the header bar while reading. Move the pointer to the top of the screen (desktop) or tap the top edge (mobile) to reveal it temporarily.

**Screen edge padding** — adds insets around the reading area to prevent text from touching curved screen edges or notches. Separate sliders for top, bottom, left, and right.

---

### Device Tab

![Device settings](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/settings-device.png)

**Keep screen on** — prevents the display from sleeping while reading. Uses the browser WakeLock API (requires a secure context / HTTPS).

**Mouse wheel navigation** — when enabled, scrolling the mouse wheel turns pages. Useful on desktop without a keyboard.

**Portrait lock** — locks the screen orientation to portrait. Requires the device to support the Screen Orientation API (most mobile browsers in PWA mode).

**Volume key navigation** *(Android app only)* — enables using the hardware volume up/down buttons to turn pages.

**Swap volume key direction** *(Android app only)* — reverses which volume key goes forward and which goes back.

**Skip progress check on open** — when enabled, the reader opens at the beginning of the book instead of restoring your last position.

**Skip auto-save on close** — when enabled, your position is not saved when you leave the reader. The next open will restore the last explicitly saved position.

---

### Status Bar Tab

![Status bar settings](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/settings-statusbar.png)

The status bar system lets you place up to six information items anywhere around the reading area.

**Status bar font** — choose a separate font for the overlay text (defaults to system UI font).

**Font style** — Normal or Bold; optionally Italic.

**Font size** — set the overlay text size (8 – 18 px).

#### Available Information Items

Each item can be placed in one of seven positions — **off**, or one of the six slots: top-left, top-centre, top-right, bottom-left, bottom-centre, bottom-right.

| Item | Description |
|---|---|
| Chapter page (X/Y) | Current page and total pages in the current chapter |
| Book page (X/Y) | Absolute page number across the whole book |
| Pages left in chapter | How many pages remain until the end of the chapter |
| Pages left in book | How many pages remain in the entire book |
| Chapter progress % | Percentage through the current chapter |
| Book progress % | Percentage through the entire book |
| Time to end of chapter | Estimated minutes/hours to finish the chapter |
| Time to end of book | Estimated minutes/hours to finish the book |
| Current time | System clock |
| Book title | Title of the current book |
| Book author | Author of the current book |
| Chapter title | Title of the current chapter |

Time estimates are calculated from your personal reading speed, which is tracked automatically as you read.

#### Progress Bars

- **Book progress bar** — a thin line showing overall book progress. Toggle on/off, choose top or bottom, set thickness (1 – 8 px).
- **Chapter progress bar** — a thin line showing progress through the current chapter. Same options as above.

#### Separator Lines

Optional horizontal lines above or below the status bar area. Toggle on/off and set thickness (1 – 4 px).

---

### Dictionaries Tab

![Dictionary settings](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/settings-dicts.png)

Lists all dictionaries installed on the server. Each row shows the dictionary name and word count.

- **Toggle** (on/off) — enable or disable a dictionary for lookups. Disabled dictionaries are skipped entirely.
- **Up / Down arrows** — reorder dictionaries. When looking up a word, results from higher-priority dictionaries appear first.

Admins see an additional **Upload dictionary ZIP** button. The ZIP must contain a complete StarDict file set (`.ifo`, `.idx`, `.dict`).

---

## Status Bar Overlays

![Status bar overlays](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/statusbar.png)

The six overlay positions sit outside the text area and never overlap the reading content:

```
[ top-left ]   [ top-centre ]   [ top-right ]
─────────────────────────────────────────────  ← separator (optional)

         [ book text ]

─────────────────────────────────────────────  ← separator (optional)
[ bot-left ]   [ bot-centre ]   [ bot-right ]
```

Each position shows whatever information item is assigned to it (or nothing if set to Off). See the [Status Bar Tab](#status-bar-tab) section for the full list of available items.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `→` | Next page |
| `←` | Previous page |
| `Space` | Next page |
| `Page Down` | Next page |
| `Page Up` | Previous page |
| `K` | Toggle Table of Contents |
| `I` | Toggle Search |
| `S` | Toggle Settings |
| `F` | Toggle fullscreen |
| `Esc` | Close open panel — or return to library |

Shortcuts are disabled when focus is inside a text input (e.g. the search field or a note editor).

---

## Offline Reading

![Offline download](https://raw.githubusercontent.com/thehijacker/codexa/main/screenshots/reader/offline.png)

### Downloading a Book

1. Open the book's detail panel from the library (tap the cover, then **Book details**).
2. Tap **Download for offline reading**.
3. The book is cached by the service worker and will be available without an internet connection.

### Reading Offline

When the device has no network, the library automatically switches to showing only downloaded books. The reader works normally — all features including bookmarks, annotations, and settings are available offline.

### Removing a Downloaded Book

Open the book's detail panel and tap **Remove from device**, or open the **Downloaded** shelf in the library sidebar and manage books from there.

---

## KOReader Sync

Codexa can synchronise your reading position with KOReader devices.

### Built-in Sync Server

By default, Codexa acts as its own KOSync-compatible server. In KOReader:

1. Go to **Tools → KOReader Sync**
2. Set **Custom sync server** to your Codexa URL
3. Log in with your Codexa credentials

Positions are synced automatically when you open or close a book in either app.

### Manual Sync

Two tap areas in the bottom corners of the reading screen trigger a manual sync:

- **Bottom-left** — pull the latest position from the sync server
- **Bottom-right** — push your current position to the sync server

### Conflict Resolution

If the position on the server differs from your local position (e.g. you read on a different device), a dialog asks which position to use:

- **Stay here** — keep your current local position
- **Jump to X%** — jump to the synced position from the other device

### External KOSync Server

You can also connect to a separate external KOSync server in **Settings → KOReader Sync**. Enter the server URL, username, and password, then tap **Test connection** to verify.

---

## Android App Features

When Codexa is running inside the official Android app, additional hardware integration is available.

### Volume Key Navigation

Turn pages with the physical volume up/down buttons. Enable in **Settings → Device → Volume key navigation**.

To reverse which key goes forward, enable **Swap volume key direction** in the same section.

### E-Ink Mode Toggle

On devices with e-ink displays, the login screen and the settings page show an **E-ink mode** toggle. This applies the high-contrast black-and-white theme system-wide and is preserved across sessions.

### Screen On

Enable **Keep screen on** in **Settings → Device** to prevent the screen from going dark while reading.

### Portrait Lock

Enable **Portrait lock** in **Settings → Device** to prevent the screen from rotating while reading.
