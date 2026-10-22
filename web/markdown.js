// Minimal markdown -> DOM. Used for plans and briefs: trusted-ish text, but every
// character still lands via textContent and URLs are limited to http(s) — no innerHTML.
import { el, safeLink } from "./ui.js";

/**
 * Append inline markdown (code, links, bold, italic, strike) into `into`. `format` (optional) takes over
 * plain text runs (`text(into, run)`) and code spans (`code(into, code)`); each text run is whole, up to
 * the next inline element, so a formatter sees `src/a_b.ts` or `[x]` in one piece.
 */
export function renderInline(into, text, format = null) {
  let pending = "";
  const flush = () => {
    if (!pending) return;
    if (format) format.text(into, pending);
    else into.append(document.createTextNode(pending));
    pending = "";
  };
  let rest = text;
  while (rest.length) {
    const code = /^(`+)([^`]*)\1/.exec(rest);
    if (code) {
      flush();
      if (format) format.code(into, code[2]);
      else into.append(el("code", "", code[2]));
      rest = rest.slice(code[0].length);
      continue;
    }
    const link = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(rest);
    if (link) {
      flush();
      into.append(safeLink(link[2], link[1] || link[2]));
      rest = rest.slice(link[0].length);
      continue;
    }
    const bold = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (bold) {
      flush();
      const node = el("strong", "");
      renderInline(node, bold[2], format);
      into.append(node);
      rest = rest.slice(bold[0].length);
      continue;
    }
    const italicStar = /^\*([^*].*?)\*/.exec(rest);
    const italicUnder = /^_([^_].*?)_(?!\w)/.exec(rest);
    const italic = italicStar || italicUnder;
    if (italic) {
      const before = pending || (into.lastChild?.nodeType === 3 ? into.lastChild.nodeValue : "");
      if (italic === italicUnder && /[a-zA-Z0-9]$/.test(before)) {
        // Inside a word: treat as text.
      } else {
        flush();
        const node = el("em", "");
        renderInline(node, italic[1], format);
        into.append(node);
        rest = rest.slice(italic[0].length);
        continue;
      }
    }
    const strike = /^~~(.+?)~~/.exec(rest);
    if (strike) {
      flush();
      const node = el("s", "");
      renderInline(node, strike[1], format);
      into.append(node);
      rest = rest.slice(strike[0].length);
      continue;
    }
    // Plain run up to the next inline opener (or the line end).
    const next = rest.slice(1).search(/[`*_~[\]]/);
    const cut = next === -1 ? rest.length : next + 1;
    pending += rest.slice(0, cut);
    rest = rest.slice(cut);
  }
  flush();
}

/**
 * Render markdown text into a <div class="md">. Supported: #..###### headings,
 * fenced code blocks, bullet and numbered lists (no nesting), task items (`- [ ]`),
 * quotes, rules, paragraphs. Everything else is shown as plain paragraph text.
 * `onToggle(line, done)` makes task boxes clickable; `line` is the 0-based source line.
 * `format` is passed to renderInline for every inline run.
 */
export function renderMarkdown(text, { onToggle = null, format = null } = {}) {
  const root = el("div", "md");
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i += 1; // closing fence, or end of text
      const block = el("pre", "md-code");
      block.append(el("code", "", code.join("\n")));
      root.append(block);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + 1); // # -> h2: page titles stay biggest
      const h = el(`h${level}`, "");
      renderInline(h, heading[2], format);
      root.append(h);
      i += 1;
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      root.append(el("hr", ""));
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = el("blockquote", "");
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ""));
      renderInline(quote, inner.join("\n"), format);
      root.append(quote);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const list = el(ordered ? "ol" : "ul", "");
      while (i < lines.length) {
        const item = ordered ? /^\s*\d+\.\s+(.*)$/.exec(lines[i]) : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!item) break;
        const li = el("li", "");
        const task = ordered ? null : /^\[( |x|X)\]\s+(.*)$/.exec(item[1]);
        if (task) {
          const done = task[1] !== " ";
          const line = i;
          li.className = `md-task${done ? " done" : ""}`;
          const box = el("button", "md-check");
          box.type = "button";
          box.setAttribute("role", "checkbox");
          box.setAttribute("aria-checked", String(done));
          box.disabled = !onToggle;
          if (onToggle) box.addEventListener("click", () => onToggle(line, !done));
          const label = el("span", "");
          renderInline(label, task[2], format);
          li.append(box, label);
        } else renderInline(li, item[1], format);
        list.append(li);
        i += 1;
      }
      root.append(list);
      continue;
    }
    // Paragraph: consecutive lines until a block boundary.
    const para = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !/^\s*[-*_]{3,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    const p = el("p", "");
    renderInline(p, para.join(" "), format);
    root.append(p);
  }
  return root;
}
