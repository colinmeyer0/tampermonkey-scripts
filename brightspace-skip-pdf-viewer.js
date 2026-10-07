// ==UserScript==
// @name         Brightspace: skip PDF viewer
// @namespace    colin.brightspace
// @version      1.5
// @description  When a Brightspace content topic is a PDF, jump straight to the direct file (opens in Firefox's own PDF viewer)
// @match        https://purdue.brightspace.com/d2l/le/content/*/viewContent/*
// @run-at       document-start
// @grant        window.close
// @grant        GM_openInTab
// ==/UserScript==

(async () => {
  'use strict';

  // Topic page:  /d2l/le/content/{orgUnitId}/viewContent/{topicId}/View
  // Direct file: /d2l/le/content/{orgUnitId}/topics/files/download/{topicId}/DirectFileTopicDownload
  const m = location.pathname.match(/\/d2l\/le\/content\/(\d+)\/viewContent\/(\d+)/);
  if (!m) return;
  const [, orgUnitId, topicId] = m;

  // Only act on middle-clicks / Ctrl+clicks, i.e. tabs opened in the background.
  // A normal click (tab in front) gets the regular Brightspace viewer.
  if (document.visibilityState !== 'hidden') return;

  const directUrl =
    `${location.origin}/d2l/le/content/${orgUnitId}/topics/files/download/${topicId}/DirectFileTopicDownload`;

  // Ask the server what the topic actually is, so non-PDF topics
  // (HTML pages, links, videos, Word files...) are left alone.
  async function isPdf(method) {
    const res = await fetch(directUrl, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? { Range: 'bytes=0-0' } : {},
    });
    if (!res.ok && res.status !== 206) return false;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const disp = (res.headers.get('content-disposition') || '').toLowerCase();
    try { res.body?.cancel(); } catch (_) {}
    return type.includes('application/pdf') || /\.pdf["';\s]*$/.test(disp) || disp.includes('.pdf');
  }

  try {
    let pdf = false;
    try {
      pdf = await isPdf('HEAD');
    } catch (_) {
      pdf = false;
    }
    if (!pdf) pdf = await isPdf('GET'); // some servers don't answer HEAD properly

    if (pdf) {
      // Let Tampermonkey open the PDF in its own tab. That tab belongs to the
      // browser, not to this page, so closing this tab can't cancel its load
      // and there's nothing to wait for.
      GM_openInTab(directUrl, { active: false, insert: true });
      window.close(); // allowed because of "@grant window.close"
    }
  } catch (e) {
    console.warn('[skip PDF viewer] check failed, leaving page as-is:', e);
  }
})();