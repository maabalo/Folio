/* ==========================================================================
   Folio — app.js
   --------------------------------------------------------------------------
   A private, in-browser document viewer. Files are read locally with the
   File API and are never uploaded anywhere.

   Table of contents
     01. DOM helpers
     02. Formatting helpers
     03. Toast & status bar
     04. External libraries (lazy-loaded, integrity-checked)
     05. File type detection
     06. Limits (tune performance here)
     07. App state & element references
     08. Shared preview building blocks (code view, tables, CSV…)
     09. Safe HTML (Word & Markdown)
     10. Office metadata
     11. PDF helpers
     12. Spreadsheet helpers
     13. Presentation helpers
     14. Renderers — one function per file kind
     15. Running a renderer (size limits, errors, retry)
     16. Preview cache (memory management)
     17. Details tab
     18. Checksum
     19. Selecting a file
     20. Tabs
     21. File list (explorer)
     22. Keyboard navigation & shortcuts
     23. Mobile drawer
     24. Opening files (pickers, drag & drop)
     25. Help guide
     26. Settings & theme
     27. Init

   How to add a new file type:
     1. Add its extensions to EXTENSIONS_BY_KIND (section 05).
     2. Add a label to KIND_LABELS (section 05).
     3. Add a renderer with the same name to `renderers` (section 14).
     4. Optional: add a size limit to SIZE_LIMITS (section 06).
   ========================================================================== */

(() => {
  'use strict';

  /* ========================================================================
     01. DOM helpers
     ======================================================================== */

  /**
   * Shorthand for document.querySelector.
   * @param {string} selector CSS selector.
   * @returns {Element|null}
   */
  const $ = (selector) => document.querySelector(selector);

  /**
   * Create an element in one call.
   * Attributes starting with "on" become event listeners; `class` sets className;
   * null/false values are skipped; `true` creates an empty boolean attribute.
   * @example el('button', { class: 'btn', onclick: save }, 'Save')
   * @param {string} tag Tag name.
   * @param {Object|null} attrs Attributes and listeners.
   * @param {...(Node|string|null|Array)} children Child nodes or text.
   * @returns {HTMLElement}
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child != null) node.append(child);
    }
    return node;
  }

  /**
   * A one-line message box (styled like a log line: "info …" / "error …").
   * @param {string} text Message.
   * @param {boolean} [isError=false] Use error styling.
   * @returns {HTMLParagraphElement}
   */
  function notice(text, isError = false) {
    return el('p', { class: isError ? 'notice is-error' : 'notice' }, text);
  }

  /**
   * Spinner + label shown while something loads.
   * @param {string} text Label.
   * @returns {HTMLDivElement}
   */
  function loadingRow(text) {
    return el('div', { class: 'loading' }, el('span', { class: 'spinner' }), text);
  }

  /* ========================================================================
     02. Formatting helpers
     ======================================================================== */

  /** @param {number} n @returns {string} Number with locale separators, e.g. "12,345". */
  const formatNumber = (n) => Number(n).toLocaleString();

  /**
   * Human-readable file size.
   * @param {number} bytes
   * @returns {string} e.g. "2.4 MB"
   */
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = -1;
    do {
      value /= 1024;
      unitIndex++;
    } while (value >= 1024 && unitIndex < units.length - 1);
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
  }

  /**
   * Localised date and time.
   * @param {number} ms Milliseconds since epoch.
   * @returns {string} e.g. "Oct 29, 2026, 9:41 PM" or "—" if missing.
   */
  function formatDate(ms) {
    if (!ms || Number.isNaN(ms)) return '—';
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  /**
   * Media length as m:ss or h:mm:ss.
   * @param {number} seconds
   * @returns {string}
   */
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return 'Unknown';
    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
  }

  /**
   * Lower-case extension without the dot.
   * @param {string} name File name.
   * @returns {string} e.g. "pdf", or "" when there is none.
   */
  function extensionOf(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  /**
   * True for hidden paths such as ".DS_Store" or ".git/config".
   * @param {string} path Relative path.
   * @returns {boolean}
   */
  const isHiddenPath = (path) => path.split('/').some((segment) => segment.startsWith('.'));

  /** Greatest common divisor — used to reduce aspect ratios (1920:1080 → 16:9). */
  const greatestCommonDivisor = (a, b) => (b ? greatestCommonDivisor(b, a % b) : a);

  /** @param {string} text @returns {number} Count of whitespace-separated words. */
  const countWords = (text) => (text.match(/\S+/g) || []).length;

  /* ========================================================================
     03. Toast & status bar
     ======================================================================== */

  let toastTimer = null;

  /**
   * Show a short message at the bottom of the screen for 4 seconds.
   * Also announced to screen readers (role="status" in main.html).
   * @param {string} message
   */
  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 4000);
  }

  /**
   * Update the status bar's state indicator (desktop).
   * The coloured dot is styled per state in style.css (section 15).
   * @param {'idle'|'loading'|'ready'|'error'} name
   * @param {string} [label=name] Text shown next to the dot.
   */
  function setStatus(name, label = name) {
    els.statusState.dataset.state = name;
    els.statusState.textContent = label;
  }

  /* ========================================================================
     04. External libraries — loaded only when a file type needs them.
     `integrity` (Subresource Integrity) makes the browser refuse a script
     whose contents differ from the published file.
     To upgrade a library: change the version in `src` AND regenerate the
     hash, e.g.  curl -s <url> | openssl dgst -sha512 -binary | base64
     ======================================================================== */

  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/';

  /** @type {Object<string, {src: string, global: string, integrity: string}>} */
  const LIBRARIES = {
    // Word (.docx) → HTML
    mammoth: {
      src: `${CDN}mammoth/1.6.0/mammoth.browser.min.js`,
      global: 'mammoth',
      integrity: 'sha512-sG5Q7boJL+ft/weuz6Mmi9XBD+bEzE9AI2FMP4YMFxp3FpTFUQSQQm5K5cSgJCyed6bWs3W8f8h0lp36lHXhQA==',
    },
    // Excel / OpenDocument spreadsheets
    xlsx: {
      src: `${CDN}xlsx/0.18.5/xlsx.full.min.js`,
      global: 'XLSX',
      integrity: 'sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA==',
    },
    // ZIP archives and Office package internals
    jszip: {
      src: `${CDN}jszip/3.10.1/jszip.min.js`,
      global: 'JSZip',
      integrity: 'sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==',
    },
    // Markdown → HTML
    marked: {
      src: `${CDN}marked/4.3.0/marked.min.js`,
      global: 'marked',
      integrity: 'sha512-zAs8dHhwlTbfcVGRX1x0EZAH/L99NjAFzX6muwOcOJc7dbGFNaW4O7b9QOyCMRYBNjO+E0Kx6yLDsiPQhhWm7g==',
    },
    // HTML sanitiser (removes scripts and other unsafe content)
    purify: {
      src: `${CDN}dompurify/3.0.6/purify.min.js`,
      global: 'DOMPurify',
      integrity: 'sha512-H+rglffZ6f5gF7UJgvH4Naa+fGCgjrHKMgoFOGmcPTRwR6oILo5R+gtzNrpDp7iMV3udbymBVjkeZGNz1Em4rQ==',
    },
    // PDF rendering
    pdfjs: {
      src: `${CDN}pdf.js/3.11.174/pdf.min.js`,
      global: 'pdfjsLib',
      integrity: 'sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==',
    },
    // PDF.js worker, loaded as a normal script so it can be integrity-checked.
    // PDF.js detects the `pdfjsWorker` global and runs it on the main thread.
    pdfworker: {
      src: `${CDN}pdf.js/3.11.174/pdf.worker.min.js`,
      global: 'pdfjsWorker',
      integrity: 'sha512-BbrZ76UNZq5BhH7LL7pn9A4TKQpQeNCHOo65/akfelcIBbcVvYWOFQKPXIrykE3qZxYjmDX573oa4Ywsc7rpTw==',
    },
  };

  /** In-flight or finished loads, so each library is fetched only once. */
  const libraryPromises = {};

  /**
   * Load a library from LIBRARIES by injecting a <script> tag.
   * @param {keyof LIBRARIES} name
   * @returns {Promise<any>} Resolves to the library's global object.
   */
  function loadLibrary(name) {
    const lib = LIBRARIES[name];
    if (window[lib.global]) return Promise.resolve(window[lib.global]);

    if (!libraryPromises[name]) {
      libraryPromises[name] = new Promise((resolve, reject) => {
        const script = el('script', { src: lib.src, integrity: lib.integrity, crossorigin: 'anonymous' });
        script.onload = () => resolve(window[lib.global]);
        script.onerror = () => {
          // Forget the failed attempt so the next try can load it again.
          delete libraryPromises[name];
          script.remove();
          reject(new Error('The viewer for this file type could not load. Check your internet connection and try again.'));
        };
        document.head.append(script);
      });
    }
    return libraryPromises[name];
  }

  /* ========================================================================
     05. File type detection
     ======================================================================== */

  /** Extensions handled by each renderer (space-separated, lower-case). */
  const EXTENSIONS_BY_KIND = {
    image: 'png jpg jpeg jfif gif webp svg bmp ico avif apng tif tiff heic heif',
    video: 'mp4 webm ogv mov m4v',
    audio: 'mp3 wav ogg oga m4a aac flac opus weba',
    pdf: 'pdf',
    markdown: 'md markdown mdown mkd',
    html: 'html htm xhtml',
    csv: 'csv tsv',
    json: 'json geojson webmanifest',
    docx: 'docx docm',
    sheet: 'xlsx xlsm xlsb xls ods',
    pptx: 'pptx pptm',
    zip: 'zip',
    text: 'txt text log ini cfg conf env yml yaml toml xml plist rtf tex srt vtt properties ' +
      'css scss sass less js mjs cjs ts tsx jsx vue svelte py rb php java kt kts swift go rs ' +
      'c h cc cpp hpp cs m mm dart lua pl r sql sh bash zsh fish bat cmd ps1 gradle ' +
      'dockerfile makefile gitignore gitattributes editorconfig license readme',
  };

  /** Reverse lookup built from the table above: { pdf: 'pdf', md: 'markdown', … } */
  const KIND_BY_EXTENSION = {};
  for (const [kind, list] of Object.entries(EXTENSIONS_BY_KIND)) {
    for (const ext of list.split(' ')) KIND_BY_EXTENSION[ext] = kind;
  }

  /** Human-readable names shown in the UI. */
  const KIND_LABELS = {
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    pdf: 'PDF document',
    markdown: 'Markdown',
    html: 'Web page',
    csv: 'Table',
    json: 'JSON data',
    docx: 'Word document',
    sheet: 'Spreadsheet',
    pptx: 'Presentation',
    zip: 'Archive',
    text: 'Text',
    binary: 'Binary file',
    unknown: 'File',
  };

  /**
   * Guess a file's kind from its extension, then its MIME type.
   * Returns "unknown" when neither matches — sniffKind() decides later.
   * @param {File} file
   * @returns {string} A key of KIND_LABELS.
   */
  function detectKind(file) {
    // Files without a dot (Makefile, LICENSE) are matched by their full name.
    const ext = extensionOf(file.name) || file.name.toLowerCase();
    if (KIND_BY_EXTENSION[ext]) return KIND_BY_EXTENSION[ext];

    const mediaType = file.type.split('/')[0];
    if (['image', 'video', 'audio', 'text'].includes(mediaType)) return mediaType;
    return 'unknown';
  }

  /**
   * Magic numbers: the first bytes of a file reveal its real format.
   * Each entry: [bytes, label, optional renderer kind].
   */
  const SIGNATURES = [
    [[0x25, 0x50, 0x44, 0x46], 'PDF document', 'pdf'],
    [[0x89, 0x50, 0x4e, 0x47], 'PNG image', 'image'],
    [[0xff, 0xd8, 0xff], 'JPEG image', 'image'],
    [[0x47, 0x49, 0x46, 0x38], 'GIF image', 'image'],
    [[0x50, 0x4b, 0x03, 0x04], 'ZIP container (ZIP, Office, OpenDocument, EPUB)'],
    [[0xd0, 0xcf, 0x11, 0xe0], 'Legacy Microsoft Office (DOC, XLS, PPT)'],
    [[0x7b, 0x5c, 0x72, 0x74, 0x66], 'Rich Text Format'],
    [[0x1f, 0x8b], 'Gzip archive'],
    [[0x52, 0x61, 0x72, 0x21], 'RAR archive'],
    [[0x37, 0x7a, 0xbc, 0xaf], '7-Zip archive'],
    [[0x49, 0x44, 0x33], 'MP3 audio'],
    [[0x4f, 0x67, 0x67, 0x53], 'Ogg media'],
    [[0x52, 0x49, 0x46, 0x46], 'RIFF container (WAV, AVI, WebP)'],
    [[0x4d, 0x5a], 'Windows executable'],
    [[0x7f, 0x45, 0x4c, 0x46], 'Linux executable'],
    [[0xcf, 0xfa, 0xed, 0xfe], 'macOS executable'],
    [[0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], 'SQLite database'],
    [[0x25, 0x21], 'PostScript document'],
  ];

  /**
   * Match the first bytes of a file against SIGNATURES.
   * @param {Uint8Array} bytes Start of the file.
   * @returns {{label: string, kind?: string}|null}
   */
  function signatureOf(bytes) {
    for (const [magic, label, kind] of SIGNATURES) {
      if (magic.every((byte, i) => bytes[i] === byte)) return { label, kind };
    }
    // MP4/MOV/HEIC store "ftyp" at byte 4 rather than at the start.
    const isIsoMedia = String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp';
    return isIsoMedia ? { label: 'ISO media (MP4, MOV, HEIC)' } : null;
  }

  /**
   * Decide whether a file with an unknown extension is text or binary
   * by inspecting its first 8 KB.
   * @param {File} file
   * @returns {Promise<string>} A renderer kind.
   */
  async function sniffKind(file) {
    const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
    const signature = signatureOf(bytes);
    if (signature?.kind) return signature.kind;
    if (signature || bytes.includes(0)) return 'binary';

    // Text if fewer than 2% of characters fail to decode as UTF-8.
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const invalidChars = (decoded.match(/�/g) || []).length;
    return invalidChars / Math.max(decoded.length, 1) < 0.02 ? 'text' : 'binary';
  }

  /* ========================================================================
     06. Limits — raise or lower these to trade features for speed/memory
     ======================================================================== */

  const TEXT_PREVIEW_LIMIT = 1_000_000; // characters shown in text previews
  const STATS_SIZE_LIMIT = 20e6; // bytes read in full for word/line counts
  const HASH_SIZE_LIMIT = 200e6; // largest file that gets a SHA-256 checksum
  const MAX_LINES = 20_000; // lines rendered in the code view
  const MAX_ROWS = 1_000; // rows rendered in tables
  const MAX_FILES = 2_000; // files the explorer will hold
  const MAX_CACHED_PREVIEWS = 8; // older previews are dropped to free memory

  /** Above these sizes a kind is shown as raw data instead, so the tab never freezes. */
  const SIZE_LIMITS = {
    pdf: 300e6,
    markdown: 10e6,
    html: 10e6,
    csv: 50e6,
    json: 50e6,
    docx: 50e6,
    sheet: 50e6,
    pptx: 100e6,
    zip: 500e6,
  };

  /* ========================================================================
     07. App state & element references
     ======================================================================== */

  /**
   * @typedef {Object} Item One opened file.
   * @property {number} id Unique id.
   * @property {File} file The File object.
   * @property {string} path Relative path (folder/file.ext).
   * @property {string} kind Renderer kind (see KIND_LABELS).
   * @property {Promise<Object>|null} [result] Cached render result.
   * @property {string|null} [url] Object URL for media/images.
   * @property {Object|null} [pdfDoc] Open PDF.js document.
   * @property {string} [hash] SHA-256 once calculated.
   */

  /** Single source of truth for the app's runtime state. */
  const state = {
    /** @type {Item[]} */
    items: [],
    currentId: null, // id of the file on screen
    tab: 'preview', // 'preview' | 'details'
    nextId: 1,
    cachedIds: [], // ids with a cached preview, most recent last
    filter: '', // explorer filter text
  };

  /** Cached element references (ids are defined in main.html). */
  const els = {
    fileInput: $('#fileInput'),
    folderInput: $('#folderInput'),
    sidebar: $('#sidebar'),
    scrim: $('#scrim'),
    drawerBtn: $('#drawerBtn'),
    clearBtn: $('#clearBtn'),
    filterRow: $('#filterRow'),
    fileFilter: $('#fileFilter'),
    fileList: $('#fileList'),
    fileCount: $('#fileCount'),
    listEmpty: $('#listEmpty'),
    noMatches: $('#noMatches'),
    emptyState: $('#emptyState'),
    docView: $('#docView'),
    docPath: $('#docPath'),
    docTitle: $('#docTitle'),
    docMeta: $('#docMeta'),
    tabPreview: $('#tabPreview'),
    tabDetails: $('#tabDetails'),
    panelPreview: $('#panelPreview'),
    panelDetails: $('#panelDetails'),
    dropOverlay: $('#dropOverlay'),
    settingsBtn: $('#settingsBtn'),
    settingsMenu: $('#settingsMenu'),
    helpBtn: $('#helpBtn'),
    helpDialog: $('#helpDialog'),
    statusState: $('#statusState'),
    statusFile: $('#statusFile'),
    statusCount: $('#statusCount'),
    statusTheme: $('#statusTheme'),
  };

  /** Matches the desktop breakpoint in style.css (section 17). */
  const desktopQuery = window.matchMedia('(min-width: 900px)');

  /** @param {number} id @returns {Item|undefined} */
  const findItem = (id) => state.items.find((item) => item.id === id);

  /**
   * Object URL for an item (created once, revoked in releasePreview).
   * @param {Item} item
   * @returns {string}
   */
  function objectUrlFor(item) {
    if (!item.url) item.url = URL.createObjectURL(item.file);
    return item.url;
  }

  /* ========================================================================
     08. Shared preview building blocks
     ======================================================================== */

  /**
   * Text with line numbers (numbers come from a CSS counter).
   * @param {string} text Content to show.
   * @param {boolean} isTruncated Whether `text` is only the start of the file.
   * @returns {HTMLDivElement}
   */
  function codeView(text, isTruncated) {
    const lines = text.split(/\r\n|\r|\n/);
    const pre = el('pre', { class: 'code', tabindex: '0' });
    const fragment = document.createDocumentFragment();
    for (const line of lines.slice(0, MAX_LINES)) {
      fragment.append(el('span', { class: 'ln' }, line), '\n');
    }
    pre.append(fragment);

    const showNotice = isTruncated || lines.length > MAX_LINES;
    return el('div', null, showNotice ? notice('Large file — only the beginning is shown.') : null, pre);
  }

  /**
   * Add line / word / character counts to the Details tab.
   * @param {string} text
   * @param {Object} ctx Render context (see newContext).
   */
  function addTextStats(text, ctx) {
    const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
    ctx.info.push(
      ['Lines', formatNumber(lines)],
      ['Words', formatNumber(countWords(text))],
      ['Characters', formatNumber(text.length)],
    );
    if (text) ctx.info.push(['Line endings', /\r\n/.test(text) ? 'CRLF (Windows)' : 'LF (macOS / Linux)']);
  }

  /**
   * Spreadsheet column name for a zero-based index (0 → A, 26 → AA).
   * @param {number} index
   * @returns {string}
   */
  function columnLetter(index) {
    let letters = '';
    let n = index + 1;
    while (n > 0) {
      const remainder = (n - 1) % 26;
      letters = String.fromCharCode(65 + remainder) + letters;
      n = Math.floor((n - 1) / 26);
    }
    return letters;
  }

  /**
   * Make a row exactly `length` cells long, as strings.
   * @param {Array} row
   * @param {number} length
   * @returns {string[]}
   */
  function padRow(row, length) {
    return Array.from({ length }, (_, i) => (row[i] == null ? '' : String(row[i])));
  }

  /**
   * Table header row: A/B/C letters for sheets, or the first data row.
   * @returns {HTMLTableSectionElement|null}
   */
  function tableHead(rows, columnCount, { header, sheet }) {
    if (!sheet && !header) return null;
    const labels = sheet
      ? Array.from({ length: columnCount }, (_, i) => columnLetter(i))
      : padRow(rows[0], columnCount);
    return el('thead', null, el('tr', null,
      el('th', { class: 'rn' }),
      labels.map((label) => el('th', { title: label }, label))));
  }

  /**
   * Table body with row numbers, capped at MAX_ROWS.
   * @returns {HTMLTableSectionElement}
   */
  function tableBody(rows, columnCount) {
    const tbody = el('tbody');
    const fragment = document.createDocumentFragment();
    rows.slice(0, MAX_ROWS).forEach((row, i) => {
      fragment.append(el('tr', null,
        el('th', { class: 'rn' }, String(i + 1)),
        padRow(row, columnCount).map((cell) => el('td', { title: cell }, cell))));
    });
    tbody.append(fragment);
    return tbody;
  }

  /**
   * A scrollable table with sticky header and row numbers.
   * @param {Array<Array>} rows Cell values.
   * @param {Object} [options]
   * @param {boolean} [options.header=true] Treat the first row as the header.
   * @param {boolean} [options.sheet=false] Show A/B/C column letters like Excel.
   * @param {number|null} [options.totalRows] Real row count when `rows` is already cut short.
   * @returns {HTMLDivElement}
   */
  function tableView(rows, { header = true, sheet = false, totalRows = null } = {}) {
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const bodyRows = header && !sheet ? rows.slice(1) : rows;
    const table = el('table', { class: sheet ? 'data-table is-sheet' : 'data-table' },
      tableHead(rows, columnCount, { header, sheet }),
      tableBody(bodyRows, columnCount));

    const shown = Math.min(bodyRows.length, MAX_ROWS);
    const total = totalRows ?? bodyRows.length;
    const limitNotice = total > shown
      ? notice(`Showing the first ${formatNumber(shown)} of ${formatNumber(total)} rows.`)
      : null;
    return el('div', null, limitNotice, el('div', { class: 'table-wrap', tabindex: '0' }, table));
  }

  /**
   * Minimal RFC 4180 CSV parser (handles quotes, escaped quotes and newlines in fields).
   * @param {string} text
   * @param {string} delimiter
   * @returns {string[][]}
   */
  function parseCSV(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (inQuotes) {
        if (char === '"' && text[i + 1] === '"') {
          field += '"'; // "" inside quotes is a literal quote
          i++;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        row.push(field);
        field = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i++; // treat CRLF as one line break
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += char;
      }
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /**
   * Pick the delimiter that splits the first line into the most columns.
   * @param {string} text
   * @returns {string} One of , ; \t |
   */
  function guessDelimiter(text) {
    const firstLine = text.slice(0, text.search(/\r|\n|$/));
    return [',', ';', '\t', '|']
      .map((d) => [d, firstLine.split(d).length])
      .sort((a, b) => b[1] - a[1])[0][0];
  }

  /**
   * Classic hex dump: offset, 16 bytes in hex, then printable ASCII.
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function hexDump(bytes) {
    const lines = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const chunk = [...bytes.subarray(offset, offset + 16)];
      const hex = chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
      const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
      lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
    }
    return lines.join('\n');
  }

  /**
   * Wait until a <video>/<audio> knows its duration (or fails / times out).
   * @param {HTMLMediaElement} media
   * @returns {Promise<void>}
   */
  function waitForMedia(media) {
    return new Promise((resolve) => {
      media.addEventListener('loadedmetadata', resolve, { once: true });
      media.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 5000); // some formats never fire either event
    });
  }

  /* ========================================================================
     09. Safe HTML for Word & Markdown
     ======================================================================== */

  /** Styles could restyle or cover the app; forms could navigate away from it. */
  const PURIFY_CONFIG = {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style'],
  };

  /**
   * Sanitise HTML into `container` and make links open in a new tab.
   * Requires the "purify" library to be loaded first.
   * @param {HTMLElement} container
   * @param {string} html Untrusted HTML.
   */
  function setSafeHtml(container, html) {
    container.innerHTML = window.DOMPurify.sanitize(html, PURIFY_CONFIG);
    for (const link of container.querySelectorAll('a[href]')) {
      if (link.getAttribute('href').startsWith('#')) continue; // in-page anchors stay
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }

  /* ========================================================================
     10. Office metadata — docx / xlsx / pptx are ZIP packages that keep
     author, title and dates in docProps/core.xml and docProps/app.xml.
     ======================================================================== */

  /** [XML tag, label shown in Details] */
  const CORE_PROPERTIES = [
    ['title', 'Title'],
    ['subject', 'Subject'],
    ['creator', 'Author'],
    ['lastModifiedBy', 'Last modified by'],
    ['created', 'Created'],
    ['modified', 'Modified'],
    ['revision', 'Revision'],
  ];
  const APP_PROPERTIES = [['Pages', 'Pages'], ['Application', 'Created with']];

  /**
   * Parse an XML file inside a zip.
   * @returns {Promise<Document|null>} null when the file does not exist.
   */
  async function readXml(zip, path) {
    const entry = zip.file(path);
    if (!entry) return null;
    return new DOMParser().parseFromString(await entry.async('string'), 'application/xml');
  }

  /** Text of the first element with this local name (namespace ignored). */
  function xmlValue(doc, tagName) {
    return doc?.getElementsByTagNameNS('*', tagName)[0]?.textContent.trim() || '';
  }

  /** Copy core.xml fields into ctx.props, formatting dates. */
  function addCoreProperties(doc, ctx) {
    for (const [tag, label] of CORE_PROPERTIES) {
      let value = xmlValue(doc, tag);
      if (!value) continue;
      if (tag === 'created' || tag === 'modified') value = formatDate(Date.parse(value));
      ctx.props.push([label, value]);
    }
  }

  /** Copy app.xml fields into ctx.props. */
  function addAppProperties(doc, ctx) {
    for (const [tag, label] of APP_PROPERTIES) {
      const value = xmlValue(doc, tag);
      if (value) ctx.props.push([label, value]);
    }
  }

  /**
   * Read author / title / dates from an Office file.
   * Failures are reported in Details rather than breaking the preview.
   * @param {ArrayBuffer} buffer File contents.
   * @param {Object} ctx Render context.
   * @returns {Promise<Object|null>} The opened JSZip instance for reuse, or null.
   */
  async function readOfficeProperties(buffer, ctx) {
    try {
      const JSZip = await loadLibrary('jszip');
      const zip = await JSZip.loadAsync(buffer);
      addCoreProperties(await readXml(zip, 'docProps/core.xml'), ctx);
      addAppProperties(await readXml(zip, 'docProps/app.xml'), ctx);
      return zip;
    } catch (err) {
      console.warn('Folio: could not read document properties', err);
      ctx.warnings.push('Document properties could not be read.');
      return null;
    }
  }

  /* ========================================================================
     11. PDF helpers — PDF.js draws pages onto <canvas>, which works on
     phones too (mobile browsers cannot show PDFs inside a page).
     ======================================================================== */

  /**
   * Load PDF.js plus its worker script.
   * @returns {Promise<Object>} The pdfjsLib global.
   */
  async function loadPdfJs() {
    const [pdfjs] = await Promise.all([loadLibrary('pdfjs'), loadLibrary('pdfworker')]);
    pdfjs.GlobalWorkerOptions.workerSrc = LIBRARIES.pdfworker.src;
    return pdfjs;
  }

  /**
   * Open a PDF, translating PDF.js errors into readable messages.
   * @returns {Promise<Object>} PDFDocumentProxy.
   */
  async function openPdf(pdfjs, file) {
    try {
      return await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    } catch (err) {
      if (err?.name === 'PasswordException') throw new Error('This PDF is password protected, so it cannot be previewed.');
      throw new Error('This PDF appears to be damaged and could not be opened.');
    }
  }

  /** [PDF info key, label shown in Details] */
  const PDF_INFO_FIELDS = [
    ['Title', 'Title'],
    ['Author', 'Author'],
    ['Subject', 'Subject'],
    ['Creator', 'Created with'],
    ['Producer', 'Produced by'],
    ['CreationDate', 'Created'],
    ['ModDate', 'Modified'],
  ];

  /** Copy the PDF's built-in metadata into the Details tab. */
  async function addPdfMetadata(pdfjs, doc, ctx) {
    try {
      const { info } = await doc.getMetadata();
      if (info.PDFFormatVersion) ctx.info.push(['PDF version', info.PDFFormatVersion]);
      for (const [key, label] of PDF_INFO_FIELDS) {
        let value = typeof info[key] === 'string' ? info[key].trim() : '';
        if (!value) continue;
        // PDF dates look like "D:20231005120000+02'00'"
        if (key.endsWith('Date')) value = formatDate(pdfjs.PDFDateString?.toDateObject(value)?.getTime());
        ctx.props.push([label, value]);
      }
    } catch (err) {
      console.warn('Folio: could not read PDF metadata', err);
      ctx.warnings.push('Document properties could not be read.');
    }
  }

  /**
   * Draw one page into its placeholder at the placeholder's width
   * (pixel ratio capped at 2 to limit memory).
   * @param {Object} doc PDFDocumentProxy.
   * @param {HTMLElement} holder Placeholder with data-page="n".
   */
  async function drawPdfPage(doc, holder) {
    const page = await doc.getPage(Number(holder.dataset.page));
    const base = page.getViewport({ scale: 1 });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const scale = ((holder.clientWidth || base.width) / base.width) * pixelRatio;
    const viewport = page.getViewport({ scale });

    const canvas = el('canvas', { width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    holder.style.aspectRatio = `${base.width} / ${base.height}`;
    holder.replaceChildren(canvas);
    page.cleanup();
  }

  /**
   * One placeholder per page; each is drawn only when scrolled near the
   * screen (IntersectionObserver), so long PDFs open instantly.
   * @param {Object} doc PDFDocumentProxy.
   * @returns {Promise<HTMLDivElement>}
   */
  async function pdfPagesView(doc) {
    const firstPage = await doc.getPage(1);
    const { width, height } = firstPage.getViewport({ scale: 1 });
    const container = el('div', { class: 'pdf-pages' });
    container.style.setProperty('--page-ratio', `${width} / ${height}`);

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        drawPdfPage(doc, entry.target).catch((err) => {
          console.error('Folio: PDF page failed to draw', err);
          entry.target.replaceChildren(notice(`Page ${entry.target.dataset.page} could not be drawn.`, true));
        });
      }
    }, { rootMargin: '800px 0px' }); // start drawing ~1 screen ahead

    for (let n = 1; n <= doc.numPages; n++) {
      const holder = el('div', { class: 'pdf-page', 'data-page': n, role: 'img', 'aria-label': `Page ${n}` });
      container.append(holder);
      observer.observe(holder);
    }
    return container;
  }

  /* ========================================================================
     12. Spreadsheet helpers
     ======================================================================== */

  /**
   * Real sheet size. `!fullref` is set when reading was capped with sheetRows.
   * @returns {Object|null} SheetJS range { s, e }.
   */
  function sheetRange(XLSX, worksheet) {
    const ref = worksheet['!fullref'] || worksheet['!ref'];
    return ref ? XLSX.utils.decode_range(ref) : null;
  }

  /** e.g. "1,204 rows × 12 columns" */
  function sheetSizeLabel(XLSX, worksheet) {
    const range = sheetRange(XLSX, worksheet);
    if (!range) return 'Empty';
    return `${formatNumber(range.e.r + 1)} rows × ${formatNumber(range.e.c + 1)} columns`;
  }

  /** Render one worksheet as a table. */
  function sheetTable(XLSX, worksheet) {
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '' });
    if (!rows.length) return notice('This sheet is empty.');
    const range = sheetRange(XLSX, worksheet);
    return tableView(rows, { sheet: true, totalRows: range ? range.e.r + 1 : rows.length });
  }

  /**
   * Pill buttons that switch which sheet is displayed.
   * @returns {HTMLDivElement}
   */
  function sheetSwitcher(XLSX, workbook) {
    const bar = el('div', { class: 'pills', role: 'group', 'aria-label': 'Sheets' });
    const body = el('div');

    const showSheet = (name, button) => {
      for (const pill of bar.children) pill.setAttribute('aria-pressed', String(pill === button));
      body.replaceChildren(sheetTable(XLSX, workbook.Sheets[name]));
    };

    for (const name of workbook.SheetNames) {
      const button = el('button', { class: 'pill', type: 'button', onclick: () => showSheet(name, button) }, name);
      bar.append(button);
    }
    showSheet(workbook.SheetNames[0], bar.firstChild);
    return el('div', null, workbook.SheetNames.length > 1 ? bar : null, body);
  }

  /* ========================================================================
     13. Presentation helpers
     ======================================================================== */

  /** Paths of ppt/slides/slideN.xml in numeric order. */
  function slidePaths(zip) {
    const slideNumber = (path) => Number(path.match(/(\d+)\.xml$/)[1]);
    return Object.keys(zip.files)
      .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
      .sort((a, b) => slideNumber(a) - slideNumber(b));
  }

  /**
   * Text of a slide: each <a:p> paragraph becomes one line.
   * @returns {Promise<string[]>}
   */
  async function slideParagraphs(zip, path) {
    const doc = await readXml(zip, path);
    return [...doc.getElementsByTagNameNS('*', 'p')]
      .map((p) => [...p.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join(''))
      .filter((text) => text.trim());
  }

  /** Card showing slide number, first line as title, the rest as body. */
  function slideCard(index, paragraphs) {
    return el('div', { class: 'slide' },
      el('span', { class: 'slide-num' }, String(index + 1).padStart(2, '0')),
      el('div', { class: 'slide-title' }, paragraphs[0] || 'Untitled'),
      paragraphs.slice(1).map((text) => el('p', null, text)));
  }

  /* ========================================================================
     14. Renderers — one per kind (keys must match KIND_LABELS).
     Signature: async (item, ctx) => HTMLElement
       • item  the file being previewed
       • ctx   collects Details rows: ctx.info (content facts),
               ctx.props (document properties), ctx.warnings
     Throw an Error with a friendly message to show the error view.
     ======================================================================== */

  const renderers = {
    /** Images: shown as-is; adds dimensions and aspect ratio. */
    async image(item, ctx) {
      const img = el('img', { alt: item.file.name });
      const settled = new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
      });
      img.src = objectUrlFor(item);
      await settled;
      if (!img.naturalWidth) throw new Error('Your browser cannot display this image format.');

      const { naturalWidth: w, naturalHeight: h } = img;
      const divisor = greatestCommonDivisor(w, h);
      ctx.info.push(
        ['Dimensions', `${formatNumber(w)} × ${formatNumber(h)} px`],
        ['Aspect ratio', `${w / divisor}:${h / divisor}`],
        ['Megapixels', ((w * h) / 1e6).toFixed(2)],
      );
      return el('div', { class: 'stage' }, img);
    },

    /** Video: native player; adds duration and resolution. */
    async video(item, ctx) {
      const video = el('video', { controls: true, preload: 'metadata', playsinline: true });
      video.src = objectUrlFor(item);
      await waitForMedia(video);
      if (video.error) throw new Error('Your browser cannot play this video format.');

      ctx.info.push(['Duration', formatDuration(video.duration)]);
      if (video.videoWidth) ctx.info.push(['Resolution', `${video.videoWidth} × ${video.videoHeight}`]);
      return el('div', { class: 'stage' }, video);
    },

    /** Audio: native player; adds duration. */
    async audio(item, ctx) {
      const audio = el('audio', { controls: true, preload: 'metadata' });
      audio.src = objectUrlFor(item);
      await waitForMedia(audio);
      if (audio.error) throw new Error('Your browser cannot play this audio format.');

      ctx.info.push(['Duration', formatDuration(audio.duration)]);
      return el('div', { class: 'stage' }, audio);
    },

    /** PDF: pages drawn with PDF.js; adds page count and metadata. */
    async pdf(item, ctx) {
      const pdfjs = await loadPdfJs();
      const doc = await openPdf(pdfjs, item.file);
      item.pdfDoc = doc; // destroyed when the preview is released
      ctx.info.push(['Pages', formatNumber(doc.numPages)]);
      await addPdfMetadata(pdfjs, doc, ctx);
      return pdfPagesView(doc);
    },

    /** Plain text & code: line-numbered view of the first 1 MB. */
    async text(item, ctx) {
      const { file } = item;
      const preview = await file.slice(0, TEXT_PREVIEW_LIMIT).text();
      if (file.size <= STATS_SIZE_LIMIT) {
        addTextStats(file.size <= TEXT_PREVIEW_LIMIT ? preview : await file.text(), ctx);
      }
      ctx.info.push(['Encoding', 'UTF-8 (assumed)']);
      return preview ? codeView(preview, file.size > TEXT_PREVIEW_LIMIT) : notice('This file is empty.');
    },

    /** Markdown: rendered to sanitised HTML. */
    async markdown(item, ctx) {
      const [text] = await Promise.all([item.file.text(), loadLibrary('marked'), loadLibrary('purify')]);
      addTextStats(text, ctx);
      ctx.info.push(['Headings', formatNumber((text.match(/^#{1,6}\s/gm) || []).length)]);

      const article = el('div', { class: 'prose' });
      setSafeHtml(article, window.marked.parse(text));
      return article;
    },

    /** HTML: rendered inside a sandboxed iframe where scripts cannot run. */
    async html(item, ctx) {
      const text = await item.file.text();
      addHtmlStats(text, ctx);
      return el('iframe', { class: 'frame', sandbox: '', srcdoc: text, title: item.file.name });
    },

    /** CSV / TSV: parsed into a table. */
    async csv(item, ctx) {
      const text = await item.file.text();
      const delimiter = extensionOf(item.file.name) === 'tsv' ? '\t' : guessDelimiter(text);
      const rows = parseCSV(text, delimiter);
      const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
      const delimiterNames = { ',': 'Comma', ';': 'Semicolon', '\t': 'Tab', '|': 'Pipe' };

      ctx.info.push(
        ['Rows', `${formatNumber(Math.max(rows.length - 1, 0))} + header`],
        ['Columns', formatNumber(columnCount)],
        ['Delimiter', delimiterNames[delimiter]],
      );
      return rows.length ? tableView(rows) : notice('This file is empty.');
    },

    /** JSON: validated and pretty-printed; invalid JSON is shown as text. */
    async json(item, ctx) {
      const text = await item.file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        ctx.info.push(['Valid JSON', `No — ${err.message}`]);
        return el('div', null,
          notice('This JSON has errors, so it is shown as plain text.', true),
          codeView(text.slice(0, TEXT_PREVIEW_LIMIT), text.length > TEXT_PREVIEW_LIMIT));
      }

      ctx.info.push(['Valid JSON', 'Yes'], ['Top level', describeJson(data)]);
      const pretty = JSON.stringify(data, null, 2);
      return codeView(pretty.slice(0, TEXT_PREVIEW_LIMIT), pretty.length > TEXT_PREVIEW_LIMIT);
    },

    /** Word: converted to HTML by mammoth, then sanitised. */
    async docx(item, ctx) {
      const buffer = await item.file.arrayBuffer();
      const [mammoth] = await Promise.all([loadLibrary('mammoth'), loadLibrary('purify')]);
      // mammoth may detach the buffer, so give it a copy.
      const result = await mammoth.convertToHtml({ arrayBuffer: buffer.slice(0) });

      const article = el('div', { class: 'prose' });
      setSafeHtml(article, result.value);
      addDocxStats(article, ctx);
      await readOfficeProperties(buffer, ctx);

      const isBlank = !article.textContent.trim() && !article.querySelector('img');
      return isBlank ? notice('This document has no visible content.') : article;
    },

    /** Spreadsheets: one table per sheet with a switcher. */
    async sheet(item, ctx) {
      const buffer = await item.file.arrayBuffer();
      const XLSX = await loadLibrary('xlsx');
      // sheetRows stops parsing after the rows we can display.
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true, sheetRows: MAX_ROWS });

      ctx.info.push(['Sheets', formatNumber(workbook.SheetNames.length)]);
      for (const name of workbook.SheetNames) {
        ctx.info.push([name, sheetSizeLabel(XLSX, workbook.Sheets[name])]);
      }
      // Only the modern XML formats carry docProps metadata.
      if (['xlsx', 'xlsm'].includes(extensionOf(item.file.name))) await readOfficeProperties(buffer, ctx);

      return workbook.SheetNames.length ? sheetSwitcher(XLSX, workbook) : notice('This workbook has no sheets.');
    },

    /** PowerPoint: text of every slide as cards. */
    async pptx(item, ctx) {
      const buffer = await item.file.arrayBuffer();
      const zip = (await readOfficeProperties(buffer, ctx))
        || (await (await loadLibrary('jszip')).loadAsync(buffer));
      const paths = slidePaths(zip);
      ctx.info.push(['Slides', formatNumber(paths.length)]);
      if (!paths.length) return notice('This presentation has no slides.');

      const cards = [];
      for (const [index, path] of paths.entries()) {
        cards.push(slideCard(index, await slideParagraphs(zip, path)));
      }
      return el('div', null,
        notice('Showing the text of each slide. Layouts and images are not included.'),
        el('div', { class: 'slides' }, cards));
    },

    /** ZIP: list of entries with sizes and dates. */
    async zip(item, ctx) {
      const JSZip = await loadLibrary('jszip');
      const zip = await JSZip.loadAsync(item.file);
      const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));
      addZipStats(item.file.size, entries, ctx);
      if (!entries.length) return notice('This archive is empty.');

      const rows = entries.map((entry) => [
        entry.name,
        entry.dir ? '—' : formatBytes(zipEntrySize(entry)),
        formatDate(entry.date?.getTime()),
      ]);
      return tableView([['Name', 'Size', 'Modified'], ...rows]);
    },

    /** Anything else: hex dump of the first 1 KB plus a format guess. */
    async binary(item, ctx) {
      const bytes = new Uint8Array(await item.file.slice(0, 1024).arrayBuffer());
      const signature = signatureOf(bytes);
      if (signature) ctx.info.push(['Detected format', signature.label]);

      const ext = extensionOf(item.file.name);
      const subject = ext ? `.${ext} files` : 'this file';
      return el('div', null,
        notice(`No visual preview for ${subject}. Showing the first 1 KB of raw data.`),
        el('pre', { class: 'hex', tabindex: '0' }, hexDump(bytes)));
    },
  };

  /* Renderer-specific stats, kept separate so each renderer stays short. */

  /** Page title and link / image / script counts for HTML files. */
  function addHtmlStats(text, ctx) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    if (doc.title.trim()) ctx.info.push(['Page title', doc.title.trim()]);
    ctx.info.push(
      ['Links', formatNumber(doc.querySelectorAll('a[href]').length)],
      ['Images', formatNumber(doc.querySelectorAll('img').length)],
      ['Scripts', formatNumber(doc.querySelectorAll('script').length)],
    );
    addTextStats(text, ctx);
  }

  /** Word, paragraph, table and image counts for Word files. */
  function addDocxStats(article, ctx) {
    ctx.info.push(
      ['Words', formatNumber(countWords(article.textContent))],
      ['Paragraphs', formatNumber(article.querySelectorAll('p').length)],
      ['Tables', formatNumber(article.querySelectorAll('table').length)],
      ['Images', formatNumber(article.querySelectorAll('img').length)],
    );
  }

  /** e.g. "Array · 120 items" or "Object · 8 keys" */
  function describeJson(data) {
    if (Array.isArray(data)) return `Array · ${formatNumber(data.length)} items`;
    if (data && typeof data === 'object') return `Object · ${formatNumber(Object.keys(data).length)} keys`;
    return typeof data;
  }

  /** JSZip has no public API for uncompressed size; falls back to 0. */
  const zipEntrySize = (entry) => entry._data?.uncompressedSize || 0;

  /** File / folder counts, total size and compression for ZIP files. */
  function addZipStats(archiveSize, entries, ctx) {
    const files = entries.filter((entry) => !entry.dir);
    const totalSize = files.reduce((sum, entry) => sum + zipEntrySize(entry), 0);
    const saved = totalSize ? Math.max(0, Math.round((1 - archiveSize / totalSize) * 100)) : 0;
    ctx.info.push(
      ['Files', formatNumber(files.length)],
      ['Folders', formatNumber(entries.length - files.length)],
      ['Uncompressed size', formatBytes(totalSize)],
      ['Space saved', `${saved}%`],
    );
  }

  /* ========================================================================
     15. Running a renderer
     ======================================================================== */

  /**
   * Fresh render context that renderers fill for the Details tab.
   * @returns {{info: Array, props: Array, warnings: string[]}}
   */
  const newContext = () => ({ info: [], props: [], warnings: [] });

  /** Raw-data view for files above their kind's SIZE_LIMITS entry. */
  async function tooLargeView(item, limit, ctx) {
    const raw = await renderers.binary(item, ctx);
    raw.prepend(notice(
      `This file is ${formatBytes(item.file.size)}, which is too large to preview safely ` +
      `(limit for this type: ${formatBytes(limit)}).`));
    return raw;
  }

  /** Error message + "Try again" button, followed by the raw-data view. */
  async function errorView(item, err) {
    const retry = el('button', { class: 'btn', type: 'button', onclick: () => retryItem(item.id) }, 'try again');
    const node = el('div', null,
      el('div', { class: 'error-block' }, notice(err.message || 'This file could not be previewed.', true), retry));
    try {
      node.append(await renderers.binary(item, newContext()));
    } catch (fallbackErr) {
      console.error('Folio: raw-data fallback also failed', fallbackErr);
    }
    return node;
  }

  /**
   * Pick and run the right renderer for an item.
   * @param {Item} item
   * @returns {Promise<{node: HTMLElement, ctx: Object, failed?: boolean}>}
   *   `failed` results are not cached, so they are retried on the next visit.
   */
  async function renderItem(item) {
    const ctx = newContext();
    try {
      if (item.kind === 'unknown') item.kind = await sniffKind(item.file);
      const limit = SIZE_LIMITS[item.kind];
      if (limit && item.file.size > limit) return { node: await tooLargeView(item, limit, ctx), ctx };
      return { node: await renderers[item.kind](item, ctx), ctx };
    } catch (err) {
      console.error(`Folio: preview failed for "${item.file.name}"`, err);
      return { node: await errorView(item, err), ctx, failed: true };
    }
  }

  /* ========================================================================
     16. Preview cache — keeps the last MAX_CACHED_PREVIEWS previews in
     memory so switching back is instant; older ones are freed.
     ======================================================================== */

  /**
   * Free everything a preview holds (DOM, PDF document, object URL).
   * @param {Item} item
   */
  function releasePreview(item) {
    item.result = null;
    if (item.pdfDoc) {
      item.pdfDoc.destroy();
      item.pdfDoc = null;
    }
    if (item.url) {
      URL.revokeObjectURL(item.url);
      item.url = null;
    }
  }

  /**
   * Mark an item as most recently used and evict the oldest previews.
   * The preview currently on screen is never evicted.
   * @param {Item} item
   */
  function rememberPreview(item) {
    state.cachedIds = state.cachedIds.filter((id) => id !== item.id);
    state.cachedIds.push(item.id);
    while (state.cachedIds.length > MAX_CACHED_PREVIEWS) {
      const oldestId = state.cachedIds.shift();
      if (oldestId === state.currentId) {
        state.cachedIds.push(oldestId);
        continue;
      }
      const oldest = findItem(oldestId);
      if (oldest) releasePreview(oldest);
    }
  }

  /** Drop an item from the cache entirely (used when it is removed). */
  function forgetPreview(item) {
    state.cachedIds = state.cachedIds.filter((id) => id !== item.id);
    releasePreview(item);
  }

  /* ========================================================================
     17. Details tab
     ======================================================================== */

  /**
   * A titled group of label/value rows.
   * @param {string} title Section heading (shown as "// title").
   * @param {Array<[string, (string|Node), boolean?]>} rows [label, value, isMonospace]
   * @returns {HTMLElement}
   */
  function detailsSection(title, rows) {
    return el('section', { class: 'details-section' },
      el('h2', { class: 'details-title' }, title),
      el('dl', { class: 'details-list' }, rows.map(([label, value, isMono]) =>
        el('div', { class: 'details-row' },
          el('dt', null, label),
          el('dd', { class: isMono ? 'mono' : null }, value)))));
  }

  /** Name, kind, size, dates — available for every file without reading it. */
  function generalRows(item) {
    const { file } = item;
    const ext = extensionOf(file.name);
    const rows = [
      ['Name', file.name],
      ['Kind', KIND_LABELS[item.kind]],
      ['Extension', ext ? `.${ext}` : 'None', true],
      ['MIME type', file.type || 'Unknown', true],
      ['Size', `${formatBytes(file.size)}  ·  ${formatNumber(file.size)} bytes`],
      ['Last modified', formatDate(file.lastModified)],
    ];
    if (item.path && item.path !== file.name) rows.push(['Location', item.path, true]);
    return rows;
  }

  /**
   * Checksum section. The value is filled in by startChecksum().
   * @returns {HTMLElement|null} null when Web Crypto is unavailable.
   */
  function checksumSection(item) {
    if (!window.crypto?.subtle) return null; // not available on insecure origins
    if (item.file.size > HASH_SIZE_LIMIT) {
      return detailsSection('Checksum', [['SHA-256', 'Skipped — file is larger than 200 MB']]);
    }
    const value = el('span', { 'data-hash': '' }, item.hash || 'Calculating…');
    return detailsSection('Checksum', [['SHA-256', value, true]]);
  }

  /**
   * Rebuild the Details tab.
   * @param {Item} item
   * @param {Object|null} result Render result, or null while still loading.
   */
  function renderDetails(item, result) {
    const sections = [detailsSection('General', generalRows(item))];

    if (!result) {
      sections.push(loadingRow('analyzing…'));
    } else {
      const { info, props, warnings } = result.ctx;
      if (info.length) sections.push(detailsSection('Content', info));
      if (props.length) sections.push(detailsSection('Document properties', props));
      warnings.forEach((text) => sections.push(notice(text, true)));
    }

    sections.push(checksumSection(item));
    els.panelDetails.replaceChildren(...sections.filter(Boolean));
    startChecksum();
  }

  /* ========================================================================
     18. Checksum — calculated only while the Details tab is open
     ======================================================================== */

  let checksumTimer = null;

  /**
   * SHA-256 of the whole file (cached on the item).
   * @param {Item} item
   * @returns {Promise<string>} Hex digest, or a failure message.
   */
  function computeHash(item) {
    if (!item.hashPromise) {
      item.hashPromise = item.file.arrayBuffer()
        .then((buffer) => crypto.subtle.digest('SHA-256', buffer))
        .then((digest) => {
          item.hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
          return item.hash;
        })
        .catch((err) => {
          console.warn('Folio: checksum failed', err);
          item.hashPromise = null; // allow another attempt later
          return 'Could not calculate';
        });
    }
    return item.hashPromise;
  }

  /**
   * Fill in the checksum if the Details tab is visible. A short delay means
   * arrowing quickly through files does not hash every one of them.
   */
  function startChecksum() {
    clearTimeout(checksumTimer);
    const item = findItem(state.currentId);
    const target = els.panelDetails.querySelector('[data-hash]');
    if (!item || !target || state.tab !== 'details') return;
    if (item.hash) {
      target.textContent = item.hash;
      return;
    }
    checksumTimer = setTimeout(async () => {
      const hash = await computeHash(item);
      const current = els.panelDetails.querySelector('[data-hash]');
      if (state.currentId === item.id && current) current.textContent = hash;
    }, 400);
  }

  /* ========================================================================
     19. Selecting a file
     ======================================================================== */

  /** Pause any playing audio/video in the preview. */
  function pauseMedia() {
    els.panelPreview.querySelectorAll('video, audio').forEach((media) => media.pause());
  }

  /**
   * Fill the document header: path, title and summary chips.
   * @param {Item} item
   */
  function showDocHeader(item) {
    els.emptyState.hidden = true;
    els.docView.hidden = false;
    els.docPath.textContent = `~/${item.path || item.file.name}`;
    els.docTitle.textContent = item.file.name;
    els.docMeta.replaceChildren(
      el('li', null, KIND_LABELS[item.kind]),
      el('li', null, formatBytes(item.file.size)),
      el('li', null, formatDate(item.file.lastModified)),
    );
    els.statusFile.textContent = `${item.path || item.file.name}  ·  ${KIND_LABELS[item.kind]}  ·  ${formatBytes(item.file.size)}`;
  }

  /** Return to the "Drop files to inspect" screen. */
  function showEmptyState() {
    state.currentId = null;
    els.docView.hidden = true;
    els.emptyState.hidden = false;
    els.panelPreview.replaceChildren();
    els.panelDetails.replaceChildren();
    els.statusFile.textContent = '';
    setStatus('idle');
  }

  /**
   * Show a file: header first, then its (cached or new) preview and details.
   * @param {number} id Item id.
   * @param {Object} [options]
   * @param {boolean} [options.keepDrawer=false] Keep the phone drawer open (keyboard navigation).
   */
  async function selectItem(id, { keepDrawer = false } = {}) {
    const item = findItem(id);
    if (!item) return;

    pauseMedia();
    state.currentId = id;
    if (!keepDrawer) closeDrawer();
    updateActiveItem();
    showDocHeader(item);

    if (!item.result) {
      setStatus('loading', 'loading…');
      els.panelPreview.replaceChildren(loadingRow('loading preview…'));
      renderDetails(item, null);
      item.result = renderItem(item);
    }

    const result = await item.result;
    if (!findItem(id)) return; // removed while loading

    // Track finished previews even if the user moved on, so memory stays bounded.
    if (result.failed) item.result = null; // try again on the next visit
    else rememberPreview(item);
    if (state.currentId !== id) return;

    showDocHeader(item); // kind may have changed after sniffing
    els.panelPreview.replaceChildren(result.node);
    renderDetails(item, result);
    updateListLabel(item);
    setStatus(result.failed ? 'error' : 'ready', result.failed ? 'preview failed' : 'ready');
  }

  /** Re-run a failed preview (the "Try again" button). */
  function retryItem(id) {
    const item = findItem(id);
    if (!item) return;
    item.result = null;
    if (item.kind === 'binary') item.kind = detectKind(item.file);
    selectItem(id);
  }

  /* ========================================================================
     20. Tabs (WAI-ARIA tabs pattern)
     ======================================================================== */

  /**
   * Switch between the Preview and Details tabs.
   * @param {'preview'|'details'} tab
   * @param {boolean} [moveFocus=false] Focus the tab button (keyboard use).
   */
  function setTab(tab, moveFocus = false) {
    state.tab = tab;
    const isPreview = tab === 'preview';

    els.tabPreview.setAttribute('aria-selected', String(isPreview));
    els.tabDetails.setAttribute('aria-selected', String(!isPreview));
    els.tabPreview.tabIndex = isPreview ? 0 : -1;
    els.tabDetails.tabIndex = isPreview ? -1 : 0;
    els.panelPreview.hidden = !isPreview;
    els.panelDetails.hidden = isPreview;

    if (isPreview) {
      clearTimeout(checksumTimer);
    } else {
      pauseMedia();
      startChecksum();
    }
    if (moveFocus) (isPreview ? els.tabPreview : els.tabDetails).focus();
  }

  /** Click and ←/→ handling for the tab buttons. */
  function bindTabs() {
    els.tabPreview.addEventListener('click', () => setTab('preview'));
    els.tabDetails.addEventListener('click', () => setTab('details'));

    for (const tab of [els.tabPreview, els.tabDetails]) {
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        setTab(state.tab === 'preview' ? 'details' : 'preview', true);
      });
    }
  }

  /* ========================================================================
     21. File list (explorer)
     ======================================================================== */

  /** Second line of a file row, e.g. "pdf · 2.4 MB". */
  const fileSubLabel = (item) => `${KIND_LABELS[item.kind].toLowerCase()} · ${formatBytes(item.file.size)}`;

  /**
   * One row in the explorer: select button + remove (×) button.
   * @param {Item} item
   * @returns {HTMLLIElement}
   */
  function fileListItem(item) {
    const ext = extensionOf(item.file.name) || '—';

    return el('li', { class: 'file-item', 'data-id': item.id },
      el('button', {
        class: 'file-btn',
        type: 'button',
        title: item.path || item.file.name,
        onclick: () => selectItem(item.id),
      },
        el('span', { class: 'ext-tag', 'aria-hidden': 'true' }, ext.slice(0, 4)),
        el('span', { class: 'file-meta' },
          el('span', { class: 'file-name' }, item.file.name),
          el('span', { class: 'file-sub' }, fileSubLabel(item)))),
      el('button', {
        class: 'remove-btn',
        type: 'button',
        'aria-label': `Remove ${item.file.name}`,
        onclick: () => removeItem(item.id),
      }, '×'));
  }

  /** Full rebuild of the explorer — only when files are added or removed. */
  function renderList() {
    const count = state.items.length;
    els.fileCount.textContent = count;
    els.statusCount.textContent = `${formatNumber(count)} file${count === 1 ? '' : 's'}`;
    els.listEmpty.hidden = count > 0;
    els.clearBtn.hidden = count === 0;
    els.filterRow.hidden = count < 2;
    els.drawerBtn.setAttribute('aria-label', `Show files (${count})`);
    els.fileList.replaceChildren(...state.items.map(fileListItem));
    applyFilter();
    updateActiveItem();
  }

  /** @param {number} id @returns {HTMLLIElement|null} */
  const listItemFor = (id) => els.fileList.querySelector(`.file-item[data-id="${id}"]`);

  /** Cheap update when only the selection changes (keeps keyboard focus). */
  function updateActiveItem() {
    for (const li of els.fileList.querySelectorAll('.file-item.is-active')) {
      li.classList.remove('is-active');
      li.querySelector('.file-btn').removeAttribute('aria-current');
    }
    const active = listItemFor(state.currentId);
    if (!active) return;
    active.classList.add('is-active');
    active.querySelector('.file-btn').setAttribute('aria-current', 'true');
    if (isSidebarVisible()) active.scrollIntoView({ block: 'nearest' });
  }

  /** Kind can change after sniffing, so refresh that one row's label. */
  function updateListLabel(item) {
    const sub = listItemFor(item.id)?.querySelector('.file-sub');
    if (sub) sub.textContent = fileSubLabel(item);
  }

  /** Hide rows that don't match the filter text (matches name or folder path). */
  function applyFilter() {
    const query = state.filter.trim().toLowerCase();
    const itemsById = new Map(state.items.map((item) => [item.id, item]));
    let visible = 0;
    for (const li of els.fileList.children) {
      const item = itemsById.get(Number(li.dataset.id));
      const matches = !query || (item.path || item.file.name).toLowerCase().includes(query);
      li.hidden = !matches;
      if (matches) visible++;
    }
    els.noMatches.hidden = !(state.items.length && visible === 0);
  }

  /**
   * Add files to the explorer, skipping hidden files and enforcing MAX_FILES.
   * @param {Array<{file: File, path: string}>} entries
   */
  function addFiles(entries) {
    const visibleEntries = entries.filter(({ path }) => !isHiddenPath(path));
    const room = Math.max(0, MAX_FILES - state.items.length);
    const accepted = visibleEntries.slice(0, room);

    const added = accepted.map(({ file, path }) => ({ id: state.nextId++, file, path, kind: detectKind(file) }));
    state.items.push(...added);
    renderList();

    if (added.length) selectItem(added[0].id);
    reportAddResult(added.length, entries.length - visibleEntries.length, visibleEntries.length - accepted.length);
  }

  /** Toast summarising what addFiles() did. */
  function reportAddResult(addedCount, hiddenCount, overLimitCount) {
    if (overLimitCount) {
      showToast(`Added ${addedCount} files. ${overLimitCount} more skipped — the limit is ${formatNumber(MAX_FILES)} files.`);
    } else if (!addedCount && hiddenCount) {
      showToast('Only hidden system files were found — nothing to show.');
    } else if (addedCount > 1) {
      showToast(`Added ${addedCount} files`);
    }
  }

  /** Remove one file; selects its neighbour if it was on screen. */
  function removeItem(id) {
    const index = state.items.findIndex((i) => i.id === id);
    if (index < 0) return;
    const [item] = state.items.splice(index, 1);
    forgetPreview(item);

    if (state.currentId === id) {
      pauseMedia();
      const neighbour = state.items[index] || state.items[index - 1];
      if (neighbour) selectItem(neighbour.id, { keepDrawer: true });
      else showEmptyState();
    }
    renderList();
  }

  /** Remove every file and reset the explorer. */
  function clearAll() {
    pauseMedia();
    state.items.forEach(releasePreview);
    state.items = [];
    state.cachedIds = [];
    state.filter = '';
    els.fileFilter.value = '';
    showEmptyState();
    renderList();
    closeDrawer();
  }

  /* ========================================================================
     22. Keyboard navigation & shortcuts
     ======================================================================== */

  /** Select buttons of rows not hidden by the filter. */
  const visibleFileButtons = () =>
    [...els.fileList.querySelectorAll('.file-item:not([hidden]) .file-btn')];

  /**
   * ↑ ↓ Home End inside the explorer. Only active while focus is in the
   * list (or ↓ from the filter box), so documents still scroll normally.
   * @param {KeyboardEvent} event
   */
  function handleListKeys(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const fromFilter = event.target === els.fileFilter;
    const fromList = event.target.closest('#fileList');
    if (!fromList && !(fromFilter && event.key === 'ArrowDown')) return;

    const buttons = visibleFileButtons();
    if (!buttons.length) return;
    event.preventDefault();

    const current = fromList ? event.target.closest('.file-item').querySelector('.file-btn') : null;
    const index = nextListIndex(event.key, buttons.indexOf(current), buttons.length, fromFilter);
    const button = buttons[index];
    button.focus();
    selectItem(Number(button.closest('.file-item').dataset.id), { keepDrawer: true });
  }

  /** Target row index for a navigation key, clamped to the list. */
  function nextListIndex(key, index, length, fromFilter) {
    if (fromFilter || key === 'Home') return 0;
    if (key === 'End') return length - 1;
    const step = key === 'ArrowDown' ? 1 : -1;
    return Math.min(Math.max(index + step, 0), length - 1);
  }

  /**
   * Select the next (+1) or previous (−1) visible file — used by J / K.
   * @param {number} step
   */
  function selectRelative(step) {
    const buttons = visibleFileButtons();
    if (!buttons.length) return;
    const ids = buttons.map((button) => Number(button.closest('.file-item').dataset.id));
    const index = ids.indexOf(state.currentId);
    const next = index < 0 ? 0 : Math.min(Math.max(index + step, 0), ids.length - 1);
    if (ids[next] !== state.currentId) selectItem(ids[next]);
  }

  /** Focus the filter box (opens the drawer first on phones). */
  function focusFilter() {
    if (els.filterRow.hidden) return;
    if (!desktopQuery.matches) openDrawer();
    els.fileFilter.focus();
    els.fileFilter.select();
  }

  /** Single-key shortcuts → actions (listed in the Settings menu too). */
  const SHORTCUTS = {
    o: () => openFiles(),
    '/': () => focusFilter(),
    j: () => selectRelative(1),
    k: () => selectRelative(-1),
    1: () => !els.docView.hidden && setTab('preview'),
    2: () => !els.docView.hidden && setTab('details'),
    '?': () => openHelp(),
  };

  /**
   * Global shortcuts. Ignored while typing, while the help guide is open,
   * or with modifier keys held, so browser shortcuts like ⌘O still work.
   * @param {KeyboardEvent} event
   */
  function handleShortcuts(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    if (els.helpDialog.open) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const action = SHORTCUTS[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault();
    action();
  }

  /* ========================================================================
     23. Mobile drawer (phones only; desktop shows a fixed sidebar)
     ======================================================================== */

  const isDrawerOpen = () => els.sidebar.classList.contains('is-open');
  const isSidebarVisible = () => desktopQuery.matches || isDrawerOpen();

  /** A closed drawer must not be reachable with Tab or a screen reader. */
  function syncDrawerAccess() {
    els.sidebar.inert = !isSidebarVisible();
  }

  /** Slide the explorer in and move focus into it. */
  function openDrawer() {
    els.sidebar.classList.add('is-open');
    els.scrim.hidden = false;
    els.drawerBtn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('drawer-open'); // stops the page behind from scrolling
    syncDrawerAccess();
    updateActiveItem();
    (els.fileList.querySelector('.is-active .file-btn') || els.sidebar.querySelector('button, input'))?.focus();
  }

  /** Slide the explorer out. */
  function closeDrawer() {
    els.sidebar.classList.remove('is-open');
    els.scrim.hidden = true;
    els.drawerBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('drawer-open');
    syncDrawerAccess();
  }

  /* ========================================================================
     24. Opening files: buttons, folder picker, drag & drop
     ======================================================================== */

  /** Open the native multi-file picker. */
  const openFiles = () => els.fileInput.click();

  /** Open the native folder picker. */
  const openFolder = () => els.folderInput.click();

  /** Wire up all "open" buttons and the hidden <input type="file"> elements. */
  function bindFileInputs() {
    $('#openFilesBtn').addEventListener('click', openFiles);
    $('#openFolderBtn').addEventListener('click', openFolder);
    $('#emptyOpenFiles').addEventListener('click', openFiles);
    $('#emptyOpenFolder').addEventListener('click', openFolder);

    for (const input of [els.fileInput, els.folderInput]) {
      input.addEventListener('change', () => {
        addFiles([...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
        input.value = ''; // allow picking the same file again
      });
    }
  }

  /** True when a drag carries files (not text or links). */
  const draggingFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');

  /** Window-wide drag & drop with an overlay while dragging. */
  function bindDragAndDrop() {
    let dragDepth = 0; // dragenter/leave fire for every child element

    window.addEventListener('dragenter', (event) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      dragDepth++;
      els.dropOverlay.hidden = false;
    });
    window.addEventListener('dragover', (event) => {
      if (draggingFiles(event)) event.preventDefault(); // required to allow dropping
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) els.dropOverlay.hidden = true;
    });
    window.addEventListener('drop', async (event) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      els.dropOverlay.hidden = true;
      addFiles(await filesFromDrop(event.dataTransfer));
    });
  }

  /** Promise wrapper for FileSystemFileEntry.file(). */
  function readFileEntry(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }

  /** Promise wrapper for FileSystemDirectoryReader.readEntries(). */
  function readDirectoryBatch(reader) {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }

  /**
   * Recursively collect files from a dropped file or folder.
   * @param {FileSystemEntry} entry
   * @param {string} prefix Folder path so far.
   * @param {Array<{file: File, path: string}>} out Collected results.
   */
  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      const file = await readFileEntry(entry);
      out.push({ file, path: prefix + file.name });
      return;
    }
    // Hidden folders (.git, .cache…) are skipped without reading them.
    if (!entry.isDirectory || entry.name.startsWith('.') || out.length >= MAX_FILES) return;

    const reader = entry.createReader();
    let batch;
    do {
      batch = await readDirectoryBatch(reader); // returns ≤100 entries per call
      for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
    } while (batch.length);
  }

  /**
   * Turn a drop event's DataTransfer into { file, path } entries,
   * including the contents of dropped folders.
   * @param {DataTransfer} dataTransfer
   * @returns {Promise<Array<{file: File, path: string}>>}
   */
  async function filesFromDrop(dataTransfer) {
    // Entries must be grabbed synchronously, before the first await.
    const entries = [...dataTransfer.items]
      .map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry())
      .filter(Boolean);
    if (!entries.length) return [...dataTransfer.files].map((file) => ({ file, path: file.name }));

    const out = [];
    let failed = 0;
    for (const entry of entries) {
      try {
        await walkEntry(entry, '', out);
      } catch (err) {
        failed++;
        console.warn(`Folio: could not read "${entry.name}"`, err);
      }
    }
    if (failed) showToast(`${failed} item${failed > 1 ? 's' : ''} could not be read.`);
    return out;
  }

  /* ========================================================================
     25. Help guide — a native <dialog>, so Esc closes it and keyboard
     focus stays inside while it is open. The text lives in main.html.
     ======================================================================== */

  /** Element focused before the guide opened, to return to afterwards. */
  let helpReturnFocus = null;

  /** Open the help guide at the top. */
  function openHelp() {
    if (els.helpDialog.open) return;
    toggleSettings(false);
    helpReturnFocus = document.activeElement;
    els.helpDialog.showModal();
    els.helpDialog.querySelector('.help-body').scrollTop = 0;
  }

  /** Put focus back where the user was before the guide opened. */
  function restoreHelpFocus() {
    if (helpReturnFocus && document.contains(helpReturnFocus)) helpReturnFocus.focus();
    helpReturnFocus = null;
  }

  /**
   * Contents links scroll inside the dialog instead of changing the URL.
   * @param {MouseEvent} event
   */
  function handleHelpTocClick(event) {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    event.preventDefault();
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    els.helpDialog.querySelector(link.getAttribute('href'))
      ?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }

  /** Open buttons, close buttons, backdrop click and contents links. */
  function bindHelp() {
    els.helpBtn.addEventListener('click', openHelp);
    $('#emptyHelpBtn').addEventListener('click', openHelp);

    els.helpDialog.querySelectorAll('[data-close]').forEach((button) => {
      button.addEventListener('click', () => els.helpDialog.close());
    });
    // A click on the <dialog> element itself (not its content) is the backdrop.
    els.helpDialog.addEventListener('click', (event) => {
      if (event.target === els.helpDialog) els.helpDialog.close();
    });
    els.helpDialog.addEventListener('close', restoreHelpFocus);
    els.helpDialog.querySelector('.help-toc').addEventListener('click', handleHelpTocClick);
  }

  /* ========================================================================
     26. Settings & theme
     ======================================================================== */

  /** localStorage key — must match the inline script in main.html. */
  const THEME_KEY = 'folio-theme';

  /** @returns {'light'|'dark'|'system'} */
  function getSavedTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || 'system';
    } catch (err) {
      console.warn('Folio: storage unavailable, using system theme', err);
      return 'system';
    }
  }

  /** Persist the theme; warns (but still applies it) if storage is blocked. */
  function saveTheme(choice) {
    try {
      localStorage.setItem(THEME_KEY, choice);
    } catch (err) {
      showToast('Theme applied, but it could not be saved for next time.');
      console.warn('Folio: could not save theme', err);
    }
  }

  /**
   * Apply a theme: "light"/"dark" set data-theme on <html>; "system"
   * removes it so the CSS prefers-color-scheme query takes over.
   * @param {'light'|'dark'|'system'} choice
   */
  function applyTheme(choice) {
    if (choice === 'light' || choice === 'dark') document.documentElement.setAttribute('data-theme', choice);
    else document.documentElement.removeAttribute('data-theme');

    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.setAttribute('aria-checked', String(button.dataset.themeChoice === choice));
    });
    els.statusTheme.textContent = choice === 'system' ? 'auto' : choice;
  }

  /** Show or hide the settings popover. */
  function toggleSettings(open) {
    els.settingsMenu.hidden = !open;
    els.settingsBtn.setAttribute('aria-expanded', String(open));
  }

  /** Theme buttons, popover toggle and click-outside-to-close. */
  function bindSettings() {
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        saveTheme(button.dataset.themeChoice);
        applyTheme(button.dataset.themeChoice);
      });
    });

    els.settingsBtn.addEventListener('click', () => toggleSettings(els.settingsMenu.hidden));
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.settings')) toggleSettings(false);
    });
  }

  /** Escape closes whichever overlay is open (menu first, then drawer). */
  function handleEscape(event) {
    if (event.key !== 'Escape') return;
    if (els.helpDialog.open) return; // the dialog closes itself natively
    if (!els.settingsMenu.hidden) {
      toggleSettings(false);
      els.settingsBtn.focus();
    } else if (isDrawerOpen()) {
      closeDrawer();
      els.drawerBtn.focus();
    }
  }

  /* ========================================================================
     27. Init
     ======================================================================== */

  /** Explorer controls: drawer, clear, filter, keyboard and breakpoint changes. */
  function bindSidebar() {
    els.drawerBtn.addEventListener('click', openDrawer);
    els.scrim.addEventListener('click', closeDrawer);
    els.clearBtn.addEventListener('click', clearAll);
    els.sidebar.addEventListener('keydown', handleListKeys);
    els.fileFilter.addEventListener('input', () => {
      state.filter = els.fileFilter.value;
      applyFilter();
    });
    // Moving between phone and desktop widths changes whether the list is on screen.
    desktopQuery.addEventListener('change', () => {
      if (desktopQuery.matches) closeDrawer();
      syncDrawerAccess();
    });
  }

  /** Entry point — runs once when the script loads. */
  function init() {
    applyTheme(getSavedTheme());
    bindTabs();
    bindFileInputs();
    bindDragAndDrop();
    bindSettings();
    bindHelp();
    bindSidebar();
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('keydown', handleShortcuts);

    syncDrawerAccess();
    renderList();
    setStatus('idle');
  }

  init();
})();
