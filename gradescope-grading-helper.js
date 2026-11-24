// ==UserScript==
// @name         Gradescope Grading Helper
// @namespace    http://tampermonkey.net/
// @version      2.7
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

  // Instructions pages are discovered from the course site's Sphinx search index,
  // matched by the submitted .py filename (e.g. time_calculator.py →
  // .../time_calculator/instructions.html). No per-assignment config needed.
  const SITE = 'https://purdue-ebec.github.io/entry-2026-autumn/';

  // Optional overrides, only if a question can't be resolved by filename:
  //   '<Gradescope question ID>': '<full instructions URL>'
  const OVERRIDES = {};

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
    // Current markup: the filename is the toggle button's text.
    const btn = section.querySelector('button.fileViewerHeader--toggleButton');
    if (!btn) return '';
    const text = btn.textContent.trim();
    if (text) return text;
    return (btn.id || btn.getAttribute('aria-controls') || '').replace(/^(accordion|body)-/, '');
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
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: r => (r.status >= 200 && r.status < 300)
          ? resolve(r.responseText)
          : reject(new Error(`HTTP ${r.status} for ${url}`)),
        onerror: () => reject(new Error(`Request failed for ${url}`)),
      });
    });
  }

  // stem → [{ url, title }], built from Sphinx's searchindex.js (fetched once).
  let pagesPromise = null;
  function loadInstructionPages() {
    if (!pagesPromise) {
      pagesPromise = gmGet(SITE + 'searchindex.js').then(js => {
        const data = JSON.parse(js.slice(js.indexOf('(') + 1, js.lastIndexOf(')')));
        const byStem = {};
        data.docnames.forEach((doc, i) => {
          const m = doc.match(/([^/]+)\/instructions$/);
          if (!m) return;
          const title = (data.titles[i] || '').replace(/<[^>]*>/g, '').trim();
          (byStem[m[1].toLowerCase()] ||= []).push({ url: SITE + doc + '.html', title });
        });
        return byStem;
      }).catch(e => { pagesPromise = null; throw e; }); // allow retry on next submission
    }
    return pagesPromise;
  }

  // Students often append their name ("function_plot_druszko.py"), so match the
  // longest known stem that equals the filename or is followed by '_' / '-'.
  function findCandidates(byStem, base) {
    let bestStem = null;
    for (const stem of Object.keys(byStem)) {
      const ok = base === stem || base.startsWith(stem + '_') || base.startsWith(stem + '-');
      if (ok && (!bestStem || stem.length > bestStem.length)) bestStem = stem;
    }
    return bestStem ? { stem: bestStem, pages: byStem[bestStem] } : { stem: null, pages: [] };
  }

  const descCache = {};

  async function fetchDescription(url) {
    if (url in descCache) return descCache[url];
    const doc = new DOMParser().parseFromString(await gmGet(url), 'text/html');
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
    console.log('[GradescopeHelper]', url, '| description:', best);
    descCache[url] = best;
    return best;
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
  const POS_KEY = 'gs-helper-panel-pos';

  function clampToViewport(el) {
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - r.width));
    const top = Math.min(Math.max(0, r.top), Math.max(0, window.innerHeight - r.height));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  // Drag by the title bar; position is remembered across submissions/reloads.
  function makeDraggable(el, handle) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      const move = ev => {
        el.style.left = (ev.clientX - dx) + 'px';
        el.style.top = (ev.clientY - dy) + 'px';
        clampToViewport(el);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ left: el.style.left, top: el.style.top }));
        } catch (_) { /* storage blocked: position just isn't remembered */ }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    window.addEventListener('resize', () => clampToViewport(el));
  }

  function panel() {
    let el = document.getElementById('gs-helper-panel');
    if (el && !el.querySelector('.gs-helper-body')) { el.remove(); el = null; } // old-style panel
    if (!el) {
      el = document.createElement('div');
      el.id = 'gs-helper-panel';
      el.style.cssText = [
        'position:fixed', 'top:12px', 'left:12px', 'z-index:99999',
        'background:#fff', 'border:1px solid #ccc', 'border-radius:8px',
        'padding:8px 12px', 'font:13px/1.5 system-ui,sans-serif',
        'box-shadow:0 2px 8px rgba(0,0,0,.2)', 'width:max-content', 'max-width:320px',
      ].join(';');

      const handle = document.createElement('div');
      handle.title = 'Drag to move';
      handle.style.cssText = 'cursor:move;user-select:none;touch-action:none;font-weight:bold;margin:-8px -12px 0;padding:8px 12px 2px';
      handle.textContent = '⠿ Grading checks';
      const body = document.createElement('div');
      body.className = 'gs-helper-body';
      el.append(handle, body);
      document.body.appendChild(el);

      try {
        const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        if (pos) { el.style.left = pos.left; el.style.top = pos.top; clampToViewport(el); }
      } catch (_) { /* ignore */ }
      makeDraggable(el, handle);
    }
    return el;
  }

  function renderChecks(checks) {
    const icon = { ok: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' };
    const el = panel();
    el.querySelector('.gs-helper-body').innerHTML =
      checks.map(c => `${icon[c.status]} ${c.text}`).join('<br>');
    clampToViewport(el); // content grew: keep it on screen
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
    const pySections = sections.filter(s => extOf(getFilename(s)) === '.py');
    if (!pySections.length) checks.push({ status: 'fail', text: 'No .py file' });

    renderChecks(checks);
    if (!pySections.length) return;

    // 3. Filename → instructions page, then copied description (async)
    try {
      const pyName = getFilename(pySections[0]);
      const base = pyName.replace(/\.py$/i, '').toLowerCase().trim();
      let candidates;
      if (OVERRIDES[qid]) {
        candidates = [{ url: OVERRIDES[qid], title: `question ${qid} (override)` }];
      } else {
        candidates = findCandidates(await loadInstructionPages(), base).pages;
        if (!candidates.length) {
          checks.push({ status: 'fail', text: `Filename "${pyName}" matches no assignment` });
          renderChecks(checks);
          return;
        }
        checks.push({ status: 'ok', text: `Filename matches ${candidates.map(c => c.title).join(' / ')}` });
        renderChecks(checks);
      }

      const src = await getSource(pySections[0]);
      const comments = extractComments(src);
      if (!words(comments).length) {
        checks.push({ status: 'fail', text: 'No comments/docstrings found' });
      } else {
        // Several exercises can share a stem (e.g. 'spiral'): score against each
        // and report the worst case.
        let best = null;
        for (const c of candidates) {
          const desc = await fetchDescription(c.url);
          if (!words(desc).length) continue;
          const score = copyScore(desc, comments);
          if (!best || score > best.score) best = { ...c, score };
        }
        if (!best) {
          checks.push({ status: 'info', text: 'Description scrape returned nothing — check selector' });
        } else {
          const pct = Math.round(best.score * 100);
          const status = best.score >= COPY_FAIL ? 'fail' : best.score >= COPY_WARN ? 'warn' : 'ok';
          const which = candidates.length > 1 ? ` (vs ${best.title})` : '';
          checks.push({ status, text: `Description overlap: ${pct}%${which}` });
        }
      }
    } catch (e) {
      checks.push({ status: 'info', text: `Copy check failed: ${e.message || e}` });
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
