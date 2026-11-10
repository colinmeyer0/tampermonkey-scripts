// ==UserScript==
// @name         Gradescope Grading Helper
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  Reorders/expands submission files and shows a checklist: format, filename, and copied-description detection.
// @author       You
// @match        https://www.gradescope.com/courses/*/questions/*/submissions/*
// @match        https://gradescope.com/courses/*/questions/*/submissions/*
// @grant        GM_xmlhttpRequest
// @connect      purdue-ebec.github.io
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------------
  const EXPAND_EXTS = ['.py', '.pdf', '.png'];
  const ORDER = ['.py', '.pdf', '.png'];

  const BAD_EXTS = ['.pdf', '.docx', '.doc']; // screenshots must be images, not these
  const IMAGE_EXTS = ['.png', '.jpg', '.jpeg'];

  // Gradescope question ID (from the URL: /questions/<ID>/submissions/...)
  //   → { instructions page }
  const ASSIGNMENTS = {
    '73756630': {
      url: 'https://purdue-ebec.github.io/entry-2026-autumn/Python/02/exercises/4/time_calculator/instructions.html',
      stem: 'time_calculator',
    },
    '73756612': {
      url: 'https://purdue-ebec.github.io/entry-2026-autumn/Python/04/exercises/4/prime_numbers/instructions.html',
      stem: 'prime_numbers'
    },
    '73756656': {
      url: 'https://purdue-ebec.github.io/entry-2026-autumn/Python/06/exercises/4/spiral/instructions.html',
      stem: 'spiral'
    },
    '73756626': {
      url: 'https://purdue-ebec.github.io/entry-2026-autumn/Python/08/exercises/5/number_reader/instructions.html',
      stem: 'number_reader'
    }
  };

  const NGRAM = 4; // phrase length for copy detection
  const COPY_WARN = 0.15; // ≥15% of description phrases found → yellow
  const COPY_FAIL = 0.35; // ≥35% → red
  // ---------------------------------------------------------------------------

  const extOf = f => (f.match(/(\.[^.]+)$/) || ['', ''])[1].toLowerCase();

  function sortKey(filename) {
    const idx = ORDER.indexOf(extOf(filename));
    return idx === -1 ? ORDER.length : idx;
  }

  function getFilename(section) {
    const h2 = section.querySelector('h2.fileViewerHeader');
    if (!h2) return '';
    const nodes = Array.from(h2.childNodes);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        return node.textContent.trim();
      }
    }
    const btn = section.querySelector('button.fileViewerHeader--toggleButton');
    return btn ? (btn.getAttribute('aria-controls') || '').replace(/^accordion-/, '') : '';
  }

  function setExpanded(section, shouldExpand) {
    const btn = section.querySelector('button.fileViewerHeader--toggleButton');
    if (!btn) return;
    const isExpanded = btn.getAttribute('aria-expanded') === 'true';
    if (shouldExpand !== isExpanded) btn.click();
  }

  // ---------------------------------------------------------------------------
  // Copy detection
  // ---------------------------------------------------------------------------
  const descCache = {};

  function fetchDescription(url) {
    if (descCache[url]) return Promise.resolve(descCache[url]);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: r => {
          const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
          // The description is the intro: every <p>/<li> after the <h1> (in document
          // order, at any nesting depth) up to the next heading ("Sample Output", etc.).
          // The page may have several <h1>s (site logo, search dialog, ...), so try
          // each one and keep the longest intro.
          const nodes = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li'));
          const h1s = nodes.filter(el => el.tagName === 'H1');
          let best = '';
          for (const h1 of h1s) {
            const intro = [];
            for (const el of nodes.slice(nodes.indexOf(h1) + 1)) {
              if (/^H[1-6]$/.test(el.tagName)) break;
              intro.push(el.textContent);
            }
            const text = intro.join(' ').replace(/\s+/g, ' ').trim();
            if (text.length > best.length) best = text;
          }
          console.log('[GradescopeHelper] h1s:', h1s.map(h => h.textContent.trim()),
                      '| description:', best);
          descCache[url] = best;
          resolve(descCache[url]);
        },
        onerror: reject,
      });
    });
  }

  // Prefer the raw file via its download link; fall back to rendered text.
  async function getSource(section) {
    const link = section.querySelector('h2.fileViewerHeader a[href]');
    if (link) {
      try {
        const res = await fetch(link.href, { credentials: 'include' });
        if (res.ok) {
          const text = await res.text();
          const type = res.headers.get('content-type') || '';
          // Ignore HTML pages (e.g. a viewer/redirect page instead of the raw file)
          if (!type.includes('html') && !/^\s*</.test(text)) return text;
        }
      } catch (_) { /* fall through */ }
    }
    return section.innerText; // may include line numbers; fine for # comments
  }

  function extractComments(src) {
    const out = [];
    for (const m of src.matchAll(/("""|''')([\s\S]*?)\1/g)) out.push(m[2]);
    for (const line of src.split('\n')) {
      const i = line.indexOf('#');
      if (i !== -1) out.push(line.slice(i + 1));
    }
    return out.join(' ');
  }

  const words = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

  function ngrams(ws, n) {
    const set = new Set();
    for (let i = 0; i + n <= ws.length; i++) set.add(ws.slice(i, i + n).join(' '));
    return set;
  }

  function copyScore(desc, comments) {
    const d = ngrams(words(desc), NGRAM);
    const c = ngrams(words(comments), NGRAM);
    if (!d.size) return 0;
    let hit = 0;
    d.forEach(g => { if (c.has(g)) hit++; });
    return hit / d.size;
  }

  // ---------------------------------------------------------------------------
  // Checklist panel
  // ---------------------------------------------------------------------------
  function panel() {
    let el = document.getElementById('gs-helper-panel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gs-helper-panel';
      el.style.cssText = [
        'position:fixed', 'top:12px', 'left:12px', 'z-index:99999',
        'background:#fff', 'border:1px solid #ccc', 'border-radius:8px',
        'padding:8px 12px', 'font:13px/1.5 system-ui,sans-serif',
        'box-shadow:0 2px 8px rgba(0,0,0,.2)', 'max-width:320px',
      ].join(';');
      document.body.appendChild(el);
    }
    return el;
  }

  function renderChecks(checks) {
    const icon = { ok: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' };
    panel().innerHTML =
      '<b>Grading checks</b><br>' +
      checks.map(c => `${icon[c.status]} ${c.text}`).join('<br>');
  }

  async function runChecks(sections) {
    const names = sections.map(getFilename);
    const checks = [];

    // 1. Image submission
    const bad = names.filter(n => BAD_EXTS.includes(extOf(n)));
    const imgs = names.filter(n => IMAGE_EXTS.includes(extOf(n)));
    if (bad.length) checks.push({ status: 'fail', text: `Non-image screenshot file(s): ${bad.join(', ')}` });
    else if (!imgs.length) checks.push({ status: 'fail', text: 'No image files submitted' });
    else checks.push({ status: 'ok', text: `${imgs.length} image file(s)` });

    // 2. .py present
    const qid = (location.pathname.match(/questions\/(\d+)/) || [])[1];
    const cfg = ASSIGNMENTS[qid];
    const pySections = sections.filter(s => extOf(getFilename(s)) === '.py');
    if (!pySections.length) checks.push({ status: 'fail', text: 'No .py file' });

    renderChecks(checks);

    // 3. Copied description (async)
    if (pySections.length && cfg?.url) {
      try {
        const [desc, src] = await Promise.all([fetchDescription(cfg.url), getSource(pySections[0])]);
        const comments = extractComments(src);
        if (!words(desc).length) {
          checks.push({ status: 'info', text: 'Description scrape returned nothing — check selector' });
        } else if (!words(comments).length) {
          checks.push({ status: 'fail', text: 'No comments/docstrings found' });
        } else {
          const score = copyScore(desc, comments);
          const pct = Math.round(score * 100);
          const status = score >= COPY_FAIL ? 'fail' : score >= COPY_WARN ? 'warn' : 'ok';
          checks.push({ status, text: `Description overlap: ${pct}%` });
        }
      } catch (e) {
        checks.push({ status: 'info', text: `Copy check failed: ${e}` });
      }
    } else if (!cfg) {
      checks.push({ status: 'info', text: `Add question ${qid} to ASSIGNMENTS for the copy check` });
    }

    renderChecks(checks);
  }

  // ---------------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------------
  // Gradescope swaps submissions without a page load, so whichever container
  // scrolls keeps its position. Reset the window and every scrolled ancestor
  // of the file viewers.
  function scrollToTop() {
    window.scrollTo(0, 0);
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    let el = document.querySelector('section.fileViewer');
    while (el) {
      if (el.scrollTop) el.scrollTop = 0;
      el = el.parentElement;
    }
  }

  function processFiles() {
    const sections = Array.from(document.querySelectorAll('section.fileViewer'));
    if (!sections.length) return false;

    const parent = sections[0].parentElement;
    sections.sort((a, b) => sortKey(getFilename(a)) - sortKey(getFilename(b)));
    sections.forEach(s => parent.appendChild(s));

    sections.forEach(s => {
      const filename = getFilename(s).toLowerCase();
      setExpanded(s, EXPAND_EXTS.some(e => filename.endsWith(e)));
    });

    scrollToTop(); // after reordering/expanding, which can shift the scroll position
    console.log('[GradescopeHelper] Processed', sections.length, 'files:', sections.map(getFilename));
    runChecks(sections);
    return true;
  }

  let ran = false;
  let lastUrl = location.href;

  function tryRun() {
    if (ran) return;
    if (document.querySelector('section.fileViewer')) {
      ran = true;
      setTimeout(processFiles, 400);
    }
  }

  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      ran = false;
      scrollToTop();
    }
    tryRun();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  tryRun();
})();
