// SPDX-License-Identifier: AGPL-3.0-or-later
// Tiny markdown renderer for research notes. Security: the input is HTML-escaped FIRST and only
// then formatted, so model output or a hostile document can never inject markup (see
// docs/rag-digital-book-architecture.md §11.6). Keep that order if you change this file.

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inline(s) {
  // [text](https://…) external links are lifted out first so later rules (e.g. _italic_) can't
  // touch the URL — Wikipedia URLs are full of underscores. Runs on escaped text, so the URL
  // can't break out of the attribute either.
  const links = [];
  s = s.replace(/\[([^\]]{1,300})\]\((https?:\/\/[^\s)"<>]{1,2000})\)/g, (_, text, url) => {
    links.push([text, url]);
    return `\u0000${links.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    // Citations like [Bill, p.4] become links back into the book.
    .replace(/\[([A-Za-z][A-Za-z .]{0,30}), p\.\s?(\d{1,4})\]/g, (_, doc, page) =>
      `<a href="#" class="ref" data-short="${doc.trim()}" data-page="${page}">[${doc.trim()}, p.${page}]</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) =>
    `<a href="${links[i][1]}" target="_blank" rel="noopener noreferrer" class="ext">${links[i][0]}</a>`);
}

export function renderMD(md) {
  const lines = escapeHtml(md).split("\n");
  let html = "";
  let list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { close(); html += `<h3>${inline(m[1])}</h3>`; continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== "ul") { close(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") { close(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    close();
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  close();
  return html;
}
