// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs before first paint: apply saved reading preferences so the page never flashes the default
// palette. Kept tiny and dependency-free; app.js owns the full settings UI.
(function () {
  var root = document.documentElement;
  function get(key, fallback) {
    try { var v = localStorage.getItem("bm_" + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  root.setAttribute("data-palette", get("palette", "golden"));
  var theme = get("theme", "auto");
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  root.setAttribute("data-font", get("font", "literata"));
  root.setAttribute("data-spacing", get("spacing", "normal"));
  root.setAttribute("data-focus", get("focus", "off"));
  root.style.setProperty("--reader-size", get("size", 19) + "px");
  root.style.setProperty("--reader-leading", String(get("leading", 1.65)));
  root.style.setProperty("--reader-measure", get("measure", 66) + "ch");
})();
