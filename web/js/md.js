// SPDX-License-Identifier: AGPL-3.0-or-later
// Tiny markdown renderer for research notes. Security: the input is HTML-escaped FIRST and only
// then formatted, so model output or a hostile document can never inject markup (see
// docs/rag-digital-book-architecture.md §11.6). Keep that order if you change this file.

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// "Bill, p.11 ¶3" — also tolerates what models write instead: "p. 11", "¶ 3", "para 3", "paragraph 3".
const CITE = /^([A-Za-z][A-Za-z .]{0,30}?),\s*p\.\s?(\d{1,4})(?:,?\s*(?:¶|para(?:graph)?\.?)\s?(\d{1,3}))?$/;

export function parseCite(text) {
  const m = String(text).trim().match(CITE);
  return m ? { short: m[1].trim(), page: Number(m[2]), para: m[3] ? Number(m[3]) : null } : null;
}

export const citeLabel = (c) => `${c.short}, p.${c.page}${c.para ? ` ¶${c.para}` : ""}`;

function citeLink(c) {
  const spoken = `${c.short}, page ${c.page}${c.para ? `, paragraph ${c.para}` : ""}`;
  return `<a href="#" class="ref" data-short="${c.short}" data-page="${c.page}"${c.para ? ` data-para="${c.para}"` : ""} aria-label="Source: ${spoken}">${citeLabel(c)}</a>`;
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
    // Citations — [Bill, p.11 ¶3], [Bill, p.11], or several in one bracket — become links into the book.
    .replace(/\[([^[\]]{3,240})\]/g, (whole, inner) => {
      const cites = inner.split(/\s*;\s*/).map(parseCite);
      return cites.every(Boolean) ? cites.map(citeLink).join(" ") : whole;
    });
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
