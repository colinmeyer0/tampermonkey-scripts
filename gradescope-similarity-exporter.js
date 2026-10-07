// ==UserScript==
// @name         Gradescope Similarity Exporter
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Export similarity review data (title, left code, right code) as JSON.
// @match        https://www.gradescope.com/courses/*/assignments/*/review_similarity/*
// @match        https://www.gradescope.com/courses/*/assignments/*/pine_reports/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // CODE PANELS
  // ---------------------------------------------------------------------------

  function getCodePanels() {
    const result = {};

    for (const side of ["left", "right"]) {
      const paneEl = document.querySelector(`.pane-${side}`);
      if (!paneEl) { result[side] = null; continue; }

      const cmEl = paneEl.querySelector(".CodeMirror");

      if (cmEl?.CodeMirror) {
        result[side] = cmEl.CodeMirror.getValue();
      } else {
        // Fallback: DOM scrape (may be incomplete if not fully rendered)
        result[side] = Array.from(paneEl.querySelectorAll(".CodeMirror-line"))
          .map(l => l.innerText)
          .join("\n");
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // MAIN EXPORT
  // ---------------------------------------------------------------------------

  function downloadJSON() {
    const h1 = document.querySelector("h1");
    const title = h1?.innerText?.trim() || document.title;
    const panels = getCodePanels();

    const data = {
      title,
      code_left:  panels.left,
      code_right: panels.right,
    };

    const safeName = title
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 80) + ".json";

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = safeName;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------------------------------------------------------------------------
  // BUTTON
  // ---------------------------------------------------------------------------

  function addButton() {
    if (document.querySelector("#gs-sim-export-btn")) return;

    const btn = document.createElement("button");
    btn.id = "gs-sim-export-btn";
    btn.textContent = "⬇ Export Similarity JSON";

    Object.assign(btn.style, {
      position:     "fixed",
      top:          "10px",
      right:        "10px",
      zIndex:       "999999",
      padding:      "8px 14px",
      background:   "#0b74de",
      color:        "white",
      border:       "none",
      borderRadius: "6px",
      fontSize:     "13px",
      cursor:       "pointer",
      boxShadow:    "0 2px 6px rgba(0,0,0,0.3)",
    });

    btn.addEventListener("mouseenter", () => btn.style.background = "#0a5fbf");
    btn.addEventListener("mouseleave", () => btn.style.background = "#0b74de");
    btn.addEventListener("click", downloadJSON);
    document.body.appendChild(btn);
  }

  // Wait for page to be ready
  const interval = setInterval(() => {
    if (document.querySelector(".CodeMirror")) {
      addButton();
      clearInterval(interval);
    }
  }, 800);

})();