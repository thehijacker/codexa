# Release notes — v1.0.7 (first Play Store release)

One file per Play Console locale, ready to paste into the "Release notes" language boxes when
creating the Internal testing release.

Filenames use Play Console's own locale codes (not always the same as this app's own i18n
codes in `public/locales/`) — pick the matching language in Play Console's dropdown for each:

| File       | Play Console language           | Matches app locale |
|------------|----------------------------------|---------------------|
| en-US.txt  | English (United States)          | en                  |
| sl.txt     | Slovenian (no region suffix — Play rejects `sl-SI`) | sl |
| de-DE.txt  | German                            | de                  |
| es-ES.txt  | Spanish (Spain)                   | es                  |
| fr-FR.txt  | French (France)                   | fr                  |
| it-IT.txt  | Italian                           | it                  |
| pt-PT.txt  | Portuguese (Portugal)             | pt                  |
| zh-CN.txt  | Chinese (Simplified)              | zh-CN               |

Note on Portuguese: Play also offers **pt-BR** (Brazil) as a separate locale with real
vocabulary differences (e.g. "arquivo" vs "ficheiro", "você" vs "tu"). `pt-PT` was picked here
because the app's own `public/locales/pt.json` already leans European Portuguese (uses
"ficheiro", "a descarregar", etc.) — if most of your actual users are Brazilian, ask for a
`pt-BR` variant instead, or add both.

**These are AI-drafted translations** (Claude), cross-checked against this app's own
`public/locales/*.json` for consistent terminology (dictionaries/highlights/offline/KOReader
sync all use the exact wording already used elsewhere in the app), but not reviewed by a native
speaker. Worth a quick sanity read before publishing, especially sl-SI since that's presumably
closest to home for you to verify yourself.

All 8 are well under Play's 500-character-per-locale limit for release notes.
