# Folio — Document Viewer

A private, in-browser viewer for documents, spreadsheets, code, media and archives.
Files are read locally with the browser's File API and are **never uploaded**.

Open `main.html` in a modern browser (Chrome, Edge, Safari or Firefox). No build step or server needed.

---

## Project structure

```
Doc_Viewer/
├── main.html            Page structure (no logic except the theme bootstrap)
├── README.md            This file
└── assets/
    ├── css/style.css    All styling: design tokens, components, breakpoints
    ├── js/app.js        All behaviour: file loading, previews, details, UI
    └── images/          (reserved for future assets)
```

Each file starts with a **table of contents**. Section numbers in comments (for example `section 14`) refer to those tables.

---

## Supported formats

| Kind | Extensions | Preview | Library |
|---|---|---|---|
| Image | png, jpg, gif, webp, svg, bmp, ico, avif, heic¹, tiff¹ | Image | — |
| Video | mp4, webm, ogv, mov, m4v | Player | — |
| Audio | mp3, wav, ogg, m4a, aac, flac, opus | Player | — |
| PDF | pdf | Pages drawn on canvas | PDF.js |
| Word | docx | Formatted document | mammoth + DOMPurify |
| Spreadsheet | xlsx, xls, xlsm, xlsb, ods | Table per sheet | SheetJS |
| Presentation | pptx | Text of each slide | JSZip |
| Table | csv, tsv | Table | — |
| JSON | json | Pretty-printed | — |
| Markdown | md | Formatted document | marked + DOMPurify |
| Web page | html, htm | Sandboxed frame (scripts blocked) | — |
| Text / code | txt, log, js, py, css, sql, yml, … | Line-numbered | — |
| Archive | zip | File listing | JSZip |
| Anything else | — | Hex dump + format detection | — |

¹ Depends on the browser (Safari supports HEIC and TIFF; Chrome does not).

Libraries are loaded from cdnjs **only when needed**, so those formats need an internet connection the first time. Everything else works offline.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `O` | Open files |
| `/` | Filter files |
| `J` / `K` | Next / previous file |
| `1` / `2` | Preview / Details tab |
| `?` | Open the help guide |
| `↑` `↓` `Home` `End` | Move through the file list (when it has focus) |
| `←` `→` | Switch tabs (when a tab has focus) |
| `Esc` | Close the settings menu or the phone drawer |

---

## Common changes

### Edit the in-app help
The help guide is plain HTML in **`main.html`**, inside `<dialog id="helpDialog">`. Edit the text directly. To add a section, copy a `<section class="help-section">` block, give its `<h3>` a new `id`, and add a matching link to `.help-toc`. If you add a keyboard shortcut, list it in three places: the help guide, the Settings menu, and the table above.

### Change colours, fonts or spacing
Edit the design tokens in **`style.css` → section 01**. The light theme is in `:root`. The dark theme appears **twice**: once for the manual setting and once for the "auto" setting. Keep both blocks identical.

Text colours are chosen to meet **WCAG 2.1 AA** contrast (at least 4.5:1). Re-check the contrast if you change `--text`, `--muted`, `--faint`, `--accent` or `--danger`.

### Add a new file type
In **`app.js`**:
1. Add the extensions to `EXTENSIONS_BY_KIND` (section 05).
2. Add a label to `KIND_LABELS` (section 05).
3. Add an `async` renderer with the same name to `renderers` (section 14). It receives `(item, ctx)` and returns an element. Push `[label, value]` rows to `ctx.info` or `ctx.props` to show them in Details.
4. Optional: add a size limit to `SIZE_LIMITS` (section 06).

### Tune performance limits
All limits are constants in **`app.js` → section 06**: preview sizes, the number of table rows, the file count, and the number of cached previews.

### Upgrade a library
In **`app.js` → section 04**, change the version in `src`, then regenerate its integrity hash:

```sh
curl -s "<new url>" | openssl dgst -sha512 -binary | base64
```

Put the result after `sha512-` in `integrity`. With a wrong hash the browser refuses the script, so the matching format will show an error.

---

## Standards followed

- **Accessibility:** WCAG 2.1 AA colour contrast. Includes a skip link, visible focus rings, the WAI-ARIA tabs pattern, live-region announcements, a closed phone drawer that the keyboard can't reach (`inert`), and support for reduced motion.
- **Security:** library scripts use Subresource Integrity (SRI). Rendered HTML is sanitised with DOMPurify. Previewed web pages run in an iframe sandbox with scripts blocked. Document links open with `rel="noopener noreferrer"`.
- **Responsive, mobile-first CSS:** breakpoints at 600px (tablet) and 900px (desktop).
- **Code style:** `'use strict'`, JSDoc on every function, small single-purpose functions, and no silent error handling (errors are shown to the user or logged with a `Folio:` prefix).
