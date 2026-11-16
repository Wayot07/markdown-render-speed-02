// parse.js — dependency-free Markdown parser (CommonMark 0.31.2 + GFM),
// written from the spec and the practice cases to match marked 18.1.3 byte for byte.
// No imports, no npm, no marked. ES module: export function parse(markdown).

// ---------------------------------------------------------------- utilities

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Full escape, used for code spans / code blocks / info strings: every & < > " '.
const ESC_FULL_RE = /[&<>"']/g;
function escFull(s) {
  return s.replace(ESC_FULL_RE, (ch) => ESC_MAP[ch]);
}

// Text escape: decode numeric character references, then escape < > " ' and
// & unless it starts a valid entity reference (&word; &#123; &#x1f;).
const TEXT_ESC_RE = /&#(\d{1,7});|&#[Xx]([0-9a-fA-F]{1,6});|[<>"']|&(?!(?:#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|\w+);)/g;
function codePointToChar(cp) {
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(cp);
}
function escText(s) {
  return s.replace(TEXT_ESC_RE, (m, dec, hex) => {
    if (dec !== undefined) {
      const ch = codePointToChar(parseInt(dec, 10));
      return ESC_MAP[ch] || ch;
    }
    if (hex !== undefined) {
      const ch = codePointToChar(parseInt(hex, 16));
      return ESC_MAP[ch] || ch;
    }
    return ESC_MAP[m] || '&amp;';
  });
}

const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
function isAsciiPunct(ch) {
  return ch.length === 1 && ASCII_PUNCT.indexOf(ch) !== -1;
}
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}
// Unicode whitespace (CommonMark): Zs + \t \n \f \r. JS \s is close enough.
const WS_RE = /\s/;
function isWhitespace(ch) {
  return ch === '' ? false : WS_RE.test(ch);
}
// Unicode punctuation: P or S general categories (covers ASCII punctuation too).
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(ch) {
  return ch !== '' && PUNCT_RE.test(ch);
}

// Remove backslash escapes (\X -> X for ASCII punctuation X).
function unescapePunct(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i++; continue; }
    out += s[i];
  }
  return out;
}

// ---------------------------------------------------------------- line cursor
// A cursor walks one source line tracking visual columns, with tab expansion
// (a tab advances to the next multiple of 4) and partially consumed tabs.

function makeCursor(s) {
  return { s, i: 0, col: 0, tab: 0 };
}
function cloneCursor(c) {
  return { s: c.s, i: c.i, col: c.col, tab: c.tab };
}
function curChar(c) {
  if (c.tab > 0) return ' ';
  return c.i < c.s.length ? c.s[c.i] : '';
}
// Advance n visual columns, honouring tabs / partially consumed tabs.
function adv(c, n) {
  while (n > 0) {
    if (c.tab > 0) {
      if (n >= c.tab) { c.col += c.tab; n -= c.tab; c.tab = 0; c.i++; }
      else { c.tab -= n; c.col += n; n = 0; }
    } else if (c.i < c.s.length && c.s[c.i] === '\t') {
      const w = 4 - (c.col & 3);
      if (w <= n) { c.col += w; c.i++; n -= w; }
      else { c.tab = w - n; c.col += n; n = 0; }
    } else if (c.i < c.s.length) {
      c.i++; c.col++; n--;
    } else {
      c.col += n; n = 0;
    }
  }
}
// Skip up to maxCols columns of spaces/tabs; returns columns skipped.
function skipSpaces(c, maxCols) {
  let n = 0;
  for (;;) {
    if (n >= maxCols) break;
    const ch = c.tab > 0 ? ' ' : c.s[c.i];
    if (ch === ' ') { adv(c, 1); n++; }
    else if (ch === '\t') {
      const w = 4 - (c.col & 3);
      if (n + w > maxCols) { adv(c, maxCols - n); n = maxCols; }
      else { adv(c, w); n += w; }
    } else break;
  }
  return n;
}
// Columns from the cursor to the first non-space character (or end of line).
function indentToNonspace(c) {
  const d = cloneCursor(c);
  return skipSpaces(d, 1e9);
}
function isBlankLine(c) {
  const d = cloneCursor(c);
  skipSpaces(d, 1e9);
  return d.i >= d.s.length;
}
// Remaining text from the cursor (partially consumed tab as spaces).
function rest(c) {
  if (c.tab > 0) return ' '.repeat(c.tab) + c.s.slice(c.i + 1);
  return c.s.slice(c.i);
}

// ---------------------------------------------------------------- block nodes

function node(t) {
  return { t, children: [], open: true, parent: null };
}

// ---------------------------------------------------------------- block starts

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// ATX heading: returns { level, text } or null. Does not mutate the cursor.
function matchATX(c) {
  const d = cloneCursor(c);
  skipSpaces(d, 3);
  if (curChar(d) === ' ') return null;
  let n = 0;
  while (curChar(d) === '#') { adv(d, 1); n++; }
  if (n === 0 || n > 6) return null;
  const after = curChar(d);
  if (after !== '' && after !== ' ' && after !== '\t') return null;
  // The closing sequence is '#'s preceded by a space; it is stripped from
  // the raw text after the opening sequence (which still holds the space
  // between the opening and a closing-only content, e.g. '### ###').
  let content = rest(d);
  content = content.replace(/[ \t]+#+[ \t]*$/, '').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level: n, text: content };
}

// Fenced code: returns { ch, len, info, indent } or null.
function matchFence(c) {
  const d = cloneCursor(c);
  const indent = skipSpaces(d, 3);
  if (curChar(d) === ' ') return null;
  const ch = curChar(d);
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (curChar(d) === ch) { adv(d, 1); len++; }
  if (len < 3) return null;
  const info = rest(d);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len, info, indent };
}

// Thematic break.
function matchHR(c) {
  const d = cloneCursor(c);
  skipSpaces(d, 3);
  if (curChar(d) === ' ') return false;
  const s = rest(d);
  return /^([*_-])([ \t]*\1){2,}[ \t]*$/.test(s);
}

// Setext underline: returns 1 (=), 2 (-) or 0.
function matchSetext(c) {
  const d = cloneCursor(c);
  skipSpaces(d, 3);
  if (curChar(d) === ' ') return 0;
  const s = rest(d);
  if (/^=+[ \t]*$/.test(s)) return 1;
  if (/^-+[ \t]*$/.test(s)) return 2;
  return 0;
}

// Block quote marker: returns columns to advance from the cursor, or 0.
function matchBlockquote(c) {
  const d = cloneCursor(c);
  skipSpaces(d, 3);
  if (curChar(d) === ' ') return 0;
  if (curChar(d) !== '>') return 0;
  adv(d, 1);
  if (curChar(d) === ' ' || curChar(d) === '\t') adv(d, 1);
  // Columns consumed (indent with tabs expanded, '>', one following space).
  return d.col - c.col;
}

// List item marker: returns info or null. contentIndent is measured in
// columns from the cursor position (after outer containers were consumed).
function matchListItem(c) {
  const d = cloneCursor(c);
  const markerOffset = skipSpaces(d, 3);
  if (curChar(d) === ' ') return null;
  let bulletChar = '', delim = '', startNum = 0, markerLen = 0;
  const ch = curChar(d);
  if (ch === '-' || ch === '+' || ch === '*') {
    bulletChar = ch; markerLen = 1;
    adv(d, 1);
  } else if (ch >= '0' && ch <= '9') {
    let numStr = '';
    while (d.i < d.s.length && d.s[d.i] >= '0' && d.s[d.i] <= '9') {
      if (numStr.length >= 9) return null; // 10+ digits: not a marker
      numStr += d.s[d.i];
      adv(d, 1);
    }
    const nx = curChar(d);
    if (nx !== '.' && nx !== ')') return null;
    delim = nx; startNum = parseInt(numStr, 10); markerLen = numStr.length + 1;
    adv(d, 1);
  } else return null;
  const after = curChar(d);
  if (after !== '' && after !== ' ' && after !== '\t') return null;
  // Columns of whitespace after the marker (up to the first non-space char).
  const d2 = cloneCursor(d);
  let wsCols = 0;
  let hitEol = false;
  for (;;) {
    const ch2 = curChar(d2);
    if (ch2 === ' ') { adv(d2, 1); wsCols++; }
    else if (ch2 === '\t') { const w = 4 - (d2.col & 3); adv(d2, w); wsCols += w; }
    else { hitEol = (ch2 === ''); break; }
  }
  const empty = hitEol;
  let contentIndent;
  if (empty) contentIndent = markerOffset + markerLen + 1;
  else if (wsCols >= 5) contentIndent = markerOffset + markerLen + 1;
  else contentIndent = markerOffset + markerLen + wsCols;
  return { bulletChar, delim, startNum, markerLen, markerOffset, contentIndent, empty };
}

// HTML block start: returns { type, end } or null. type 1-5 end at a line
// containing `end`; types 6-7 end at a blank line. Type 7 cannot interrupt.
function matchHTMLBlock(c, paraOpen) {
  const d = cloneCursor(c);
  skipSpaces(d, 3);
  if (curChar(d) === ' ') return null;
  if (curChar(d) !== '<') return null;
  const s = rest(d);
  if (s.startsWith('<!--')) return { type: 2, end: '-->' };
  if (s.startsWith('<?')) return { type: 3, end: '?>' };
  if (s.startsWith('<![CDATA[')) return { type: 5, end: ']]>' };
  if (s.length > 2 && s[0] === '<' && s[1] === '!' && /[A-Za-z]/.test(s[2])) return { type: 4, end: '>' };
  const m1 = /^<(pre|script|style|textarea)(?:[ \t>]|$)/i.exec(s);
  if (m1) return { type: 1, end: '</' + m1[1].toLowerCase() + '>' };
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (m6 && HTML_BLOCK_TAGS.has(m6[1].toLowerCase())) {
    const after = s[m6[0].length];
    if (after === undefined || after === ' ' || after === '\t' || after === '>') return { type: 6, end: null };
    if (after === '/' && s[m6[0].length + 1] === '>') return { type: 6, end: null };
  }
  if (paraOpen) return null;
  // Type 7: a complete open or closing tag, alone on the line.
  const tagEnd = parseTagEnd(s, 0);
  if (tagEnd > 0) {
    const afterTag = s.slice(tagEnd);
    if (/^[ \t]*$/.test(afterTag)) {
      const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s);
      if (name && !/^(pre|script|style|textarea)$/i.test(name[1])) return { type: 7, end: null };
    }
  }
  return null;
}

// Content of a code line: strip up to stripCols columns of leading
// whitespace (never non-whitespace), return the rest. A leading tab in
// the content expands to spaces to the next multiple of 4 when the code
// line sits inside a container (cursor column > 0); at the top level
// (column 0) the tab is kept raw, matching marked.
function codeContent(c, stripCols) {
  const d = cloneCursor(c);
  skipSpaces(d, stripCols);
  let s = rest(d);
  // A leading tab expands to spaces (to the next multiple of 4) when it
  // was exposed by container matching (stripCols 0, e.g. a fenced code
  // block inside a list item), or when the line is inside a blockquote
  // (the tab follows the '>' marker and its spaces: doc-22's rust fence
  // content expands even though the fence indent 2 was stripped). When
  // codeContent itself stripped the indent outside a blockquote (indented
  // code, or a fenced block with a nonzero fence indent) the tab is kept
  // raw. The expansion column is counted from the innermost '>' marker
  // when the line is inside a blockquote (marked does not count the outer
  // container width): e.g. '> > \tfoo' expands the tab to 2 spaces, not 4.
  let inQuote = false;
  for (let k = d.i - 1; k >= 0; k--) {
    if (d.s[k] === '>') { inQuote = true; break; }
    if (d.s[k] !== ' ' && d.s[k] !== '\t') break;
  }
  // A tab partially consumed by a '>' marker (d.tab > 0) was expanded
  // from the absolute column, but marked counts from the innermost '>'
  // (doc-30: '>	foo' -> 2 spaces, not 3). Recompute the remainder
  // from the tab's column relative to the innermost '>'.
  if (d.tab > 0 && d.i > 0 && d.s[d.i - 1] === '>') {
    let qcol = 0;
    const qi = d.i - 1;
    for (let k = 0; k < qi; k++) {
      if (d.s[k] === '	') qcol += 4 - (qcol & 3);
      else qcol++;
    }
    let tabAbsCol = 0;
    for (let k = 0; k < d.i; k++) {
      if (d.s[k] === '	') tabAbsCol += 4 - (tabAbsCol & 3);
      else tabAbsCol++;
    }
    const wAbs = 4 - (tabAbsCol & 3);
    const consumed = wAbs - d.tab;
    const relCol = tabAbsCol - qcol;
    const wRel = 4 - (relCol & 3);
    const newTab = wRel - consumed;
    if (newTab >= 0 && newTab !== d.tab) {
      s = ' '.repeat(newTab) + s.slice(d.tab);
      d.tab = newTab;
    }
  }
  if ((stripCols === 0 || inQuote) && d.col > 0 && d.tab === 0) {
    let col = d.col;
    let qi = -1;
    for (let k = d.i - 1; k >= 0; k--) {
      if (d.s[k] === '>') { qi = k; break; }
      if (d.s[k] !== ' ' && d.s[k] !== '\t') break;
    }
    if (qi >= 0) {
      let qcol = 0;
      for (let k = 0; k < qi; k++) {
        if (d.s[k] === '\t') qcol += 4 - (qcol & 3);
        else qcol++;
      }
      col = d.col - qcol;
    }
    let k = 0;
    let out = '';
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
      if (s[k] === '\t') {
        const w = 4 - (col & 3);
        out += ' '.repeat(w);
        col += w;
      } else {
        out += ' ';
        col++;
      }
      k++;
    }
    if (k > 0 && out !== s.slice(0, k)) s = out + s.slice(k);
  }
  return s;
}
// Content of a paragraph line: the line as-is after the container indent
// (leading spaces are part of the paragraph's raw content).
function paraContent(c) {
  // A leading tab in paragraph content expands to spaces (to the next
  // multiple of 4) based on the cursor column (doc-40: a tab after the
  // blockquote/list containers renders as 2 spaces, not a raw tab).
  if (c.tab === 0 && c.s[c.i] === '\t') {
    const w = 4 - (c.col & 3);
    return ' '.repeat(w) + c.s.slice(c.i + 1);
  }
  return rest(c);
}

// ---------------------------------------------------------------- block parser

function parseBlocks(src) {
  const doc = node('doc');
  const stack = [doc];
  let lastLineBlank = false;
  let prevBlank = false;
  // A "marker blank" line (e.g. a lone '>' in a blockquote) is blank inside
  // its containers but is not a blank line at the outer levels: it only
  // makes a list loose when the next block lands inside its containers.
  let lastMarkerBlank = false;
  let lastMarkerBlankContainer = null;
  let prevMarkerBlank = false;
  let markerBlankContainer = null;
  const srcEndsNL = src.endsWith('\n');

  const lines = src.split('\n');
  if (src.length > 0 && src.endsWith('\n')) lines.pop();

  const tip = () => stack[stack.length - 1];

  // Is node n the ancestor-or-self of the node a blank line belonged to?
  function isDescOrSelf(n, anc) {
    let x = n;
    while (x) { if (x === anc) return true; x = x.parent; }
    return false;
  }
  // Trailing newline of an HTML block: types 1-5 get one when the next line
  // is non-blank, or at EOF when the source ends with a newline; types 6-7
  // only at EOF when the source ends with a newline.
  function setHtmlTrail(b, li) {
    const hasNext = li + 1 < lines.length;
    if (b.htmlType <= 5) {
      // A following whitespace-only line (spaces or a tab) does NOT
      // suppress the trailing newline; only a truly empty line does.
      b.trailNL = (hasNext && lines[li + 1] !== '') || (!hasNext && srcEndsNL);
    } else {
      b.trailNL = !hasNext && srcEndsNL;
    }
  }

  function closeTo(container) {
    while (stack.length > 1 && stack[stack.length - 1] !== container) {
      const b = stack.pop();
      b.open = false;
      if (b.t === 'code' && !b.fenced) {
        while (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
      }
    }
  }
  function addBlock(parent, b, push) {
    const blankLoose = prevBlank || (prevMarkerBlank && markerBlankContainer && isDescOrSelf(parent, markerBlankContainer));
    if (parent.t === 'item' && blankLoose && parent.children.length > 0) parent.parent.loose = true;
    if (parent.t === 'list' && blankLoose && parent.children.length > 0) parent.loose = true;
    parent.children.push(b);
    b.parent = parent;
    if (push !== false) stack.push(b);
    return b;
  }
  // Is there an open paragraph inside container's subtree (i.e. the tip is a
  // paragraph and it is a descendant of container, or container itself)?
  function paraOpenIn(container) {
    const t = tip();
    if (t.t !== 'para') return false;
    let n = t;
    while (n) {
      if (n === container) return true;
      n = n.parent;
    }
    return false;
  }
  // Is the open paragraph inside a list item? A list item marker always
  // interrupts a paragraph that is already inside a list; at the top level
  // it needs to be a non-empty bullet or an ordered item starting with 1.
  function paraInList() {
    let n = tip();
    if (n.t !== 'para') return false;
    while (n) {
      if (n.t === 'list' || n.t === 'item') return true;
      n = n.parent;
    }
    return false;
  }
  function listsMatch(list, li) {
    if (li.bulletChar) return !list.ordered && list.bulletChar === li.bulletChar;
    return list.ordered && list.delim === li.delim;
  }
  function findOpenList(cur, li) {
    if (cur.t === 'list' && cur.open && listsMatch(cur, li)) return cur;
    const last = cur.children[cur.children.length - 1];
    if (last && last.t === 'list' && last.open && listsMatch(last, li)) return last;
    return null;
  }
  function isClosingFence(c, code) {
    const d = cloneCursor(c);
    if (indentToNonspace(d) > 3) return false;
    skipSpaces(d, 3);
    let n = 0;
    while (curChar(d) === code.ch) { adv(d, 1); n++; }
    if (n < code.len) return false;
    skipSpaces(d, 1e9);
    return d.i >= d.s.length;
  }

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const c = makeCursor(raw);
    const rawBlank = isBlankLine(c);
    prevBlank = lastLineBlank;
    prevMarkerBlank = lastMarkerBlank;
    markerBlankContainer = lastMarkerBlankContainer;

    // ---- phase 1: match open containers ----
    let container = doc;
    let allMatched = true;
    // True when the container match failed on a blockquote (a line without
    // '>'): a fenced code block must not swallow such a line. A failure on
    // a list item (indent too small) does NOT stop a fenced code block from
    // swallowing the line, matching marked.
    let failQuote = false;
    // True when at least one blockquote container matched this line.
    let matchedQuote = false;
    if (rawBlank) {
      // A truly blank line matches list/item containers but NOT a
      // blockquote (it has no '>' marker): the quote closes.
      for (let d = 1; d < stack.length; d++) {
        const b = stack[d];
        if (b.t === 'quote') break;
        if (b.t === 'list' || b.t === 'item') container = b;
        else break;
      }
    } else {
      for (let d = 1; d < stack.length; d++) {
        const b = stack[d];
        if (b.t === 'quote') {
          const save = cloneCursor(c);
          skipSpaces(c, 3);
          if (curChar(c) === ' ') { c.i = save.i; c.col = save.col; c.tab = save.tab; allMatched = false; failQuote = true; break; }
          if (curChar(c) === '>') {
            adv(c, 1);
            if (curChar(c) === ' ' || curChar(c) === '\t') adv(c, 1);
            container = b;
            matchedQuote = true;
          } else {
            c.i = save.i; c.col = save.col; c.tab = save.tab;
            allMatched = false; failQuote = true; break;
          }
        } else if (b.t === 'list') {
          container = b;
        } else if (b.t === 'item') {
          const ind = indentToNonspace(c);
          if (ind < b.contentIndent) { allMatched = false; break; }
          adv(c, b.contentIndent);
          container = b;
        } else break;
      }
    }
    // A line whose remainder (after the matched containers) is empty is a
    // blank line inside those containers (e.g. a lone '>' in a blockquote).
    const markerBlank = !rawBlank && rest(c) === '';

    // ---- phase 2 ----
    if (rawBlank || markerBlank) {
      if (rawBlank) {
        // Truly blank: close everything above the innermost matched
        // container. A code block (or type 1-5 HTML block) whose parent is
        // that container keeps the blank line instead.
        const t = tip();
        if (t.t === 'code' && t.parent === container) {
          t.lines.push(codeContent(c, t.fenced ? t.fenceIndent : 4));
        } else if (t.t === 'html' && t.htmlType <= 5 && t.parent === container) {
          t.lines.push(rest(c));
          setHtmlTrail(t, li);
        } else if (t.t === 'para' && raw.indexOf('\t') !== -1 && parseTable(t.lines)) {
          // A whitespace-only line containing a TAB inside a table
          // paragraph is a body row with empty cells, not a blank line
          // ending the table; the following text line joins as a row too.
          // (A spaces-only line does end the table.)
          t.lines.push(raw);
        } else {
          closeTo(container);
          // An empty list item followed by a blank line is closed.
          if (tip().t === 'item' && tip().children.length === 0) closeTo(tip().parent);
        }
        lastLineBlank = true;
        lastMarkerBlank = false;
        lastMarkerBlankContainer = null;
      } else {
        // Marker blank: the containers matched, so only the tip's own
        // block is affected (a paragraph closes, a code block takes an
        // empty line, a type 6-7 HTML block closes). The quote stays
        // open — unless the tip sits inside a NESTED quote the line did
        // not match (a lone '>' after a '> >' block): then that nested
        // quote closes too (doc-14: the inner blockquote ends at the
        // '>' line and a new one opens at the next '> >' line).
        const t = tip();
        let inUnmatchedQuote = false;
        for (let p = t.parent; p && p !== container; p = p.parent) {
          if (p.t === 'quote') { inUnmatchedQuote = true; break; }
        }
        if (inUnmatchedQuote) {
          closeTo(container);
        } else if (t.t === 'code') {
          t.lines.push(codeContent(c, t.fenced ? t.fenceIndent : 4));
        } else if (t.t === 'html' && t.htmlType <= 5) {
          t.lines.push(rest(c));
          setHtmlTrail(t, li);
        } else if (t.t === 'html') {
          closeTo(t.parent);
        } else if (t.t === 'para') {
          closeTo(t.parent);
        }
        // A marker blank line is not a truly blank line: it only makes a
        // list loose via the marker-blank container check in addBlock.
        lastLineBlank = false;
        lastMarkerBlank = true;
        lastMarkerBlankContainer = container;
      }
      continue;
    }
    lastLineBlank = false;
    lastMarkerBlank = false;
    lastMarkerBlankContainer = null;

    // Fenced / indented code and HTML blocks swallow their content lines.
    // A fenced code block swallows a line when the line matched all the
    // containers down to the code block's parent, OR when the block
    // already has content and no blockquote failed to match (a line that
    // fails only a list item is still swallowed once the block has taken
    // hold). But if the very first content line fails the parent, the
    // block closes immediately and stays empty (doc-13 ````sh). A line
    // that is itself a list-item marker is a sibling item, not content.
    const t0 = tip();
    if (t0.t === 'code' && t0.fenced && (container === t0.parent || (t0.lines.length > 0 && !failQuote))) {
      if (isClosingFence(c, t0)) { closeTo(t0.parent); continue; }
      if (!allMatched && matchListItem(c)) { /* fall through: new list item */ }
      else {
        t0.lines.push(codeContent(c, t0.fenceIndent));
        continue;
      }
    }
    if (allMatched && t0.t === 'code' && !t0.fenced) {
      if (indentToNonspace(c) >= 4) {
        t0.lines.push(codeContent(c, 4));
        continue;
      }
      closeTo(t0.parent);
    }
    if (allMatched && t0.t === 'html') {
      const line = rest(c);
      t0.lines.push(line);
      setHtmlTrail(t0, li);
      if (t0.htmlType <= 5 && t0.end && line.toLowerCase().indexOf(t0.end) !== -1) closeTo(t0.parent);
      continue;
    }

    // Setext heading underline (only when the paragraph is in the matched chain).
    // A table paragraph never becomes a setext heading: an underline-looking
    // line (e.g. '=========') is a table body row instead.
    if (allMatched && tip().t === 'para') {
      const lvl = matchSetext(c);
      if (lvl && !parseTable(tip().lines)) {
        const p = tip();
        // Reference definitions are stripped from the paragraph first: the
        // heading is only the lines that remain. If nothing remains, this
        // is not a heading at all and the underline is paragraph text.
        const r = extractRefDefs(p.lines);
        p.refDefs = (p.refDefs || []).concat(r.defs);
        if (r.lines.length > 0) {
          const par = p.parent;
          closeTo(par);
          const h = node('heading');
          h.level = lvl; h.lines = r.lines;
          h.refDefs = p.refDefs;
          par.children[par.children.length - 1] = h;
          h.parent = par;
          continue;
        }
        p.lines = [];
      }
    }

    // New block starts. Containers loop; a leaf block ends the line.
    // If nothing matches, the line is paragraph text (possibly a lazy
    // continuation of a paragraph in an unmatched container).
    let cur = container;
    let done = false;
    // A leaf block (or blockquote) cannot be a child of a list: close any
    // open list first so the block lands in the list's parent.
    const closeListCur = () => { while (cur.t === 'list') { closeTo(cur.parent); cur = cur.parent; } };
    while (!done) {
      const bq = matchBlockquote(c);
      if (bq) {
        closeListCur();
        closeTo(cur);
        const q = addBlock(cur, node('quote'));
        adv(c, bq);
        cur = q;
        continue;
      }
      const atx = matchATX(c);
      if (atx) {
        closeListCur();
        closeTo(cur);
        const h = node('heading');
        h.level = atx.level; h.text = atx.text;
        addBlock(cur, h, false);
        done = true; continue;
      }
      const fen = matchFence(c);
      if (fen) {
        // A fence sitting exactly at a list item's content column has
        // indent 0 relative to that item (doc-22/doc-29: the content
        // keeps its 3/2 spaces); otherwise the indent is the spaces
        // skipped after the containers. Match against open items in the
        // stack, or an item recorded on the enclosing blockquote whose
        // list is a SIBLING of the fence's own container list (doc-22:
        // item 18's ordered list is a sibling of the bullet list the
        // fence lands in). An item in the same list is a sibling of the
        // fence, not its parent (doc-15's `-` item), and an item in a
        // parent list is an ancestor, not the fence's own column — both
        // must not claim it. A closed item at the same column must not
        // claim a top-level fence (doc-13: the ```` at line 202 opens a
        // top-level block with fenceIndent 2, not 0), so only blockquote
        // scopes count here.
        let fenceIndent = fen.indent;
        const fenceCol = c.col + fen.indent;
        // Only an open item that is an ANCESTOR of the fence's container
        // counts: an item that is merely a sibling (a child of the same
        // list the fence lands in) must not claim it (doc-22 line 1249:
        // the ```rust fence sits in the list next to item 2, not inside
        // it, so its 2-space indent is real).
        {
          let ancSet = new Set();
          let a = cur;
          while (a) { ancSet.add(a); a = a.parent; }
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].t === 'item' && stack[s].contentCol === fenceCol && ancSet.has(stack[s])) { fenceIndent = 0; break; }
          }
        }
        if (fenceIndent !== 0 && cur.t === 'list') {
          let scope = cur;
          while (scope && scope.t !== 'quote' && scope.t !== 'doc') scope = scope.parent;
          if (scope && scope.t === 'quote' && scope.itemCols) {
            for (const e of scope.itemCols) {
              // An item in the same list counts only when it is that
              // list's last item, the list is a bullet list, AND the
              // fence is a tilde fence (doc-29: the `>*` item closes
              // right before the `~~~objective-c` fence, which sits at
              // its content column; doc-26's backtick fence after an
              // identical bullet item keeps indent 2). An earlier item
              // in the same list is a stale column (doc-15's `-` item).
              // A sibling list's item counts when the lists share a
              // parent (doc-22).
              const sameListLast = e.list === cur && !e.list.ordered && fen.ch === '~' && e.list.children[e.list.children.length - 1] === e.item;
              if (e.col === fenceCol && fen.indent >= 2 && ((e.list !== cur && e.list.parent === cur.parent) || sameListLast)) { fenceIndent = 0; break; }
            }
          }
        }
        closeListCur();
        closeTo(cur);
        const code = node('code');
        code.fenced = true; code.ch = fen.ch; code.len = fen.len;
        code.info = fen.info;
        code.fenceIndent = fenceIndent; code.lines = [];
        addBlock(cur, code);
        done = true; continue;
      }
      const hb = matchHTMLBlock(c, paraOpenIn(cur));
      if (hb) {
        closeListCur();
        closeTo(cur);
        const h = node('html');
        h.htmlType = hb.type; h.end = hb.end; h.lines = [rest(c)]; setHtmlTrail(h, li);
        addBlock(cur, h);
        if (hb.type <= 5 && hb.end && rest(c).toLowerCase().indexOf(hb.end) !== -1) closeTo(cur);
        done = true; continue;
      }
      if (matchHR(c)) {
        closeListCur();
        closeTo(cur);
        addBlock(cur, node('hr'), false);
        done = true; continue;
      }
      const mk = matchListItem(c);
      if (mk) {
        const paraOpen = paraOpenIn(cur);
        const canInterrupt = paraInList() || (mk.bulletChar ? !mk.empty : (!mk.empty && mk.startNum === 1));
        if (paraOpen && !canInterrupt) break; // paragraph continuation, below
        closeTo(cur);
        // A new list that does not continue the open list is a sibling of
        // it, not a child: close the open list first.
        if (cur.t === 'list' && !listsMatch(cur, mk)) { closeTo(cur.parent); cur = cur.parent; }
        let list = findOpenList(cur, mk);
        if (!list) {
          list = node('list');
          list.ordered = !mk.bulletChar;
          list.bulletChar = mk.bulletChar;
          list.delim = mk.delim;
          list.start = mk.startNum;
          list.loose = false;
          addBlock(cur, list);
        }
        const item = node('item');
        item.contentIndent = mk.contentIndent;
        item.markerOffset = mk.markerOffset;
        // Absolute column where this item's content starts. Recorded on
        // the enclosing blockquote (or doc) with its list, so a later
        // fenced code block sitting at this column can use indent 0 even
        // after the item closes (doc-22: item 18 closes when the sibling
        // bullet list opens, but the fence still sits at its column).
        item.contentCol = c.col + mk.contentIndent;
        {
          let sc = list;
          while (sc && sc.t !== 'quote' && sc.t !== 'doc') sc = sc.parent;
          if (sc) { (sc.itemCols = sc.itemCols || []).push({ col: item.contentCol, list, item }); }
        }
        addBlock(list, item);
        adv(c, mk.contentIndent);
        cur = item;
        if (mk.empty) { done = true; continue; }
        continue;
      }
      if (!paraOpenIn(cur) && indentToNonspace(c) >= 4) {
        closeListCur();
        closeTo(cur);
        const code = node('code');
        code.fenced = false; code.lines = [codeContent(c, 4)];
        addBlock(cur, code);
        done = true; continue;
      }
      break; // no new block: paragraph text
    }
    if (!done) {
      // Paragraph: continuation (possibly lazy) or a new paragraph.
      const p = tip();
      if (p.t === 'para') {
        let content = paraContent(c);
        if (!allMatched) {
          // Lazy continuation: a setext underline is indented by four
          // spaces. Otherwise, when the blockquote itself failed to match,
          // skip up to 3 columns of leading whitespace (a tab leaves its
          // remainder as spaces). When the quote matched but an inner
          // container (e.g. a list item) failed, the content after the
          // matched containers — including its leading whitespace — is
          // kept as-is.
          if (matchSetext(c)) content = '    ' + content;
          else if (!matchedQuote) {
            // Lazy continuation with no blockquote matched on this line
            // (the quote failed, or there is no quote): strip leading
            // whitespace. But spaces rendered from a partially-consumed
            // tab (c.tab > 0) are the tab's remainder and are kept:
            // rest() already turned that remainder into spaces at the
            // head of the content. When a quote DID match but an inner
            // container failed, the content after the matched containers
            // is kept as-is.
            if (c.tab > 0) {
              const keep = c.tab;
              content = content.slice(0, keep) + content.slice(keep).replace(/^[ \t]+/, '');
            } else {
              content = content.replace(/^[ \t]+/, '');
            }
          } else if (c.tab === 0) {
            // Quote matched but an inner container (list item) failed:
            // the content after the matched containers is kept as-is,
            // EXCEPT when it is indented by 4 or more columns — then
            // the leading whitespace is stripped (doc-22: the `Same`
            // line in item 19 has 4 spaces after the quote and strips
            // them all, while the `Naïve are` line in item 17 has 3
            // spaces and keeps them).
            let w = 0, k = 0;
            let col = c.col;
            while (k < content.length && (content[k] === ' ' || content[k] === '\t')) {
              if (content[k] === '\t') { const n = 4 - (col & 3); w += n; col += n; }
              else { w++; col++; }
              k++;
            }
            if (w >= 4) content = content.slice(k);
          }
        }
        p.lines.push(content);
      } else {
        // Do not create a paragraph from whitespace-only content.
        const content = paraContent(c);
        if (!/^[ \t]*$/.test(content)) {
          closeListCur();
          closeTo(cur);
          const np = node('para');
          np.lines = [content];
          addBlock(cur, np);
        }
      }
    }
  }

  // End of input: close everything left open.
  closeTo(doc);
  return doc;
}

// ---------------------------------------------------------------- link parsing
// Helpers shared by inline links and link reference definitions. All work on
// a plain string `s` and a character index.

// Skip spaces/tabs/newlines, but fail (-1) on a blank line (two newlines).
function skipInlineWhitespace(s, i) {
  let nl = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '\n') { nl++; if (nl > 1) return -1; i++; continue; }
    break;
  }
  return i;
}
function isControl(ch) {
  const c = ch.charCodeAt(0);
  return c < 32 || c === 127;
}

// Parse a link destination at s[pos]. Returns { dest, next } or null.
// dest has backslash escapes processed.
function parseLinkDestination(s, pos) {
  if (s[pos] === '<') {
    let i = pos + 1;
    let dest = '';
    while (i < s.length) {
      const ch = s[i];
      // A backslash escape (\X) is part of the destination; an escaped '>'
      // does not close it.
      if (ch === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { dest += s[i + 1]; i += 2; continue; }
      if (ch === '>') return { dest, next: i + 1 };
      if (ch === '<' || ch === '\n' || isControl(ch)) return null;
      dest += ch; i++;
    }
    return null;
  }
  let i = pos;
  let depth = 0;
  let dest = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || isControl(ch)) break;
    if (ch === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { dest += s[i + 1]; i += 2; continue; }
    if (ch === '(') { depth++; dest += ch; i++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--; dest += ch; i++; continue;
    }
    dest += ch; i++;
  }
  if (dest === '' || depth !== 0) return null;
  return { dest, next: i };
}

// Parse a link title at s[pos] ("...", '...' or (...)). Returns { title, next } or null.
function parseLinkTitle(s, pos) {
  const ch = s[pos];
  if (ch !== '"' && ch !== "'" && ch !== '(') return null;
  const closer = ch === '(' ? ')' : ch;
  let i = pos + 1;
  let title = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { title += s[i + 1]; i += 2; continue; }
    if (c === closer) return { title, next: i + 1 };
    if (c === '\n') {
      if (i + 1 < s.length && s[i + 1] === '\n') return null;
      title += c; i++; continue;
    }
    if (ch === '(' && c === '(') return null;
    title += c; i++;
  }
  return null;
}

// Parse a link label starting at s[pos] ('['). Returns { label, next } or null.
// The label keeps backslash escapes as written. A label may not contain an
// unescaped '[' (so 'ref[bar]' is not a label); it ends at the first ']'.
function parseLinkLabel(s, pos) {
  let i = pos + 1;
  let label = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { label += s[i] + s[i + 1]; i += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') {
      if (label.length === 0 || label.length > 999) return null;
      if (normalizeLabel(label) === '') return null;
      return { label, next: i + 1 };
    }
    label += ch; i++;
  }
  return null;
}

// Unicode case folding for label matching: lowercase, then fold the
// characters whose fold is not a single lowercase letter (sharp s, the
// Latin ligatures, final sigma).
function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss').replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st')
    .replace(/ς/g, 'σ');
}

// Parse an inline link "(dest title)" at s[pos] ('('). Returns { dest, title, next } or null.
// An empty destination "()" is valid. A title must be separated from the
// destination by whitespace; a title-start character directly after the
// destination is not a title.
function parseInlineLink(s, pos) {
  let i = skipInlineWhitespace(s, pos + 1);
  if (i < 0) return null;
  let dest = parseLinkDestination(s, i);
  if (!dest) {
    // Empty destination: "()", or "( "title" )".
    if (s[i] === ')' || s[i] === '"' || s[i] === "'") dest = { dest: '', next: i };
    else return null;
  }
  let p = dest.next;
  // Optional title: on this line, or on the next line. It must be separated
  // from the destination by at least one space/tab (or a newline).
  let title = null;
  let hadWs = false;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) { p++; hadWs = true; }
  if (p < s.length && (s[p] === '"' || s[p] === "'" || s[p] === '(')) {
    if (!hadWs) return null;
    const t = parseLinkTitle(s, p);
    if (!t) return null;
    title = t.title;
    p = t.next;
    while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p++;
  } else if (p < s.length && s[p] === '\n') {
    let q = p + 1;
    while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
    if (q < s.length && (s[q] === '"' || s[q] === "'" || s[q] === '(')) {
      const t = parseLinkTitle(s, q);
      if (!t) return null;
      title = t.title;
      q = t.next;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
    }
    p = q;
  }
  // The closing ')' may follow on the next line.
  if (s[p] === '\n') {
    let q = p + 1;
    while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
    if (s[q] === ')') return { dest: dest.dest, title, next: q + 1 };
    return null;
  }
  if (s[p] !== ')') return null;
  return { dest: dest.dest, title, next: p + 1 };
}

// Parse one link reference definition starting at lines[i].
// Returns { label, dest, title, nextLine } or null.
function parseRefDef(lines, i) {
  const text = lines.slice(i).join('\n');
  let pos = 0;
  let sp = 0;
  while (pos < text.length && text[pos] === ' ' && sp < 3) { pos++; sp++; }
  if (text[pos] !== '[') return null;
  const label = parseLinkLabel(text, pos);
  if (!label) return null;
  pos = label.next;
  if (text[pos] !== ':') return null;
  pos++;
  // Destination: same line, or the next line.
  let p = pos;
  while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
  if (p < text.length && text[p] === '\n') {
    let q = p + 1;
    while (q < text.length && (text[q] === ' ' || text[q] === '\t')) q++;
    if (q < text.length && text[q] !== '\n') p = q;
    else return null;
  }
  const dest = parseLinkDestination(text, p);
  if (!dest) return null;
  pos = dest.next;
  // Optional title: same line, or the next line. A same-line title must be
  // separated from the destination by whitespace. If a next-line title is
  // present but malformed (or followed by junk), the definition is still
  // valid with the destination only; the title's line is left over.
  let title = null;
  p = pos;
  let hadWs = false;
  while (p < text.length && (text[p] === ' ' || text[p] === '\t')) { p++; hadWs = true; }
  if (p < text.length && (text[p] === '"' || text[p] === "'" || text[p] === '(')) {
    if (!hadWs) return null;
    const t = parseLinkTitle(text, p);
    if (!t) return null;
    const q = t.next;
    let r = q;
    while (r < text.length && (text[r] === ' ' || text[r] === '\t')) r++;
    if (r < text.length && text[r] !== '\n') return null;
    title = t.title;
    pos = r;
  } else if (p < text.length && text[p] === '\n') {
    let q = p + 1;
    while (q < text.length && (text[q] === ' ' || text[q] === '\t')) q++;
    if (q < text.length && (text[q] === '"' || text[q] === "'" || text[q] === '(')) {
      const t = parseLinkTitle(text, q);
      if (t) {
        let r = t.next;
        while (r < text.length && (text[r] === ' ' || text[r] === '\t')) r++;
        if (r >= text.length || text[r] === '\n') { title = t.title; pos = r; }
        else pos = p; // title malformed: dest-only, title line left over
      } else pos = p;
    } else {
      pos = p;
    }
  } else if (p >= text.length) {
    pos = p;
  } else {
    return null;
  }
  if (pos < text.length && text[pos] !== '\n') return null;
  // Lines consumed: newlines in text[0..pos] + 1.
  let nl = 0;
  for (let k = 0; k < pos; k++) if (text[k] === '\n') nl++;
  return { label: normalizeLabel(label.label), dest: dest.dest, title, nextLine: i + nl + 1 };
}

// Strip leading link reference definitions from a paragraph's lines.
// Returns { lines, defs } where defs are the extracted definitions in order.
function extractRefDefs(paraLines) {
  let i = 0;
  const n = paraLines.length;
  const defs = [];
  while (i < n) {
    const def = parseRefDef(paraLines, i);
    if (!def) break;
    defs.push(def);
    i = def.nextLine;
  }
  return { lines: paraLines.slice(i), defs };
}

// ---------------------------------------------------------------- inline HTML
// Parse a raw HTML tag starting at s[i] ('<'). Returns the index just past
// the tag, or -1 when the text is not a tag.
function parseTagEnd(s, i) {
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    const j = s.indexOf('-->', i + 4);
    return j === -1 ? -1 : j + 3;
  }
  if (s.startsWith('<?', i)) {
    const j = s.indexOf('?>', i + 2);
    return j === -1 ? -1 : j + 2;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const j = s.indexOf(']]>', i + 9);
    return j === -1 ? -1 : j + 3;
  }
  if (s.startsWith('<!', i) && i + 2 < s.length && s[i + 2] >= 'A' && s[i + 2] <= 'Z') {
    const j = s.indexOf('>', i + 2);
    return j === -1 ? -1 : j + 1;
  }
  if (s.startsWith('</', i)) {
    const m = /^<\/([A-Za-z][A-Za-z0-9-]*)/.exec(s.slice(i));
    if (!m) return -1;
    let j = i + m[0].length;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (s[j] !== '>') return -1;
    return j + 1;
  }
  const m = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(s.slice(i));
  if (!m) return -1;
  let j = i + m[0].length;
  for (;;) {
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '>') return k + 1;
    if (s[k] === '/' && s[k + 1] === '>') return k + 2;
    if (k === j) return -1;
    j = k;
    const am = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(s.slice(j));
    if (!am) return -1;
    j += am[0].length;
    let k2 = j;
    while (k2 < s.length && (s[k2] === ' ' || s[k2] === '\t' || s[k2] === '\n')) k2++;
    if (s[k2] === '=') {
      k2++;
      while (k2 < s.length && (s[k2] === ' ' || s[k2] === '\t' || s[k2] === '\n')) k2++;
      const q = s[k2];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, k2 + 1);
        if (end === -1) return -1;
        j = end + 1;
      } else {
        let v = k2;
        while (v < s.length && s[v] !== ' ' && s[v] !== '\t' && s[v] !== '\n' && s[v] !== '"' && s[v] !== "'" && s[v] !== '=' && s[v] !== '<' && s[v] !== '>' && s[v] !== '`') v++;
        if (v === k2) return -1;
        j = v;
      }
    // No '=': a valueless attribute. Leave j just past the attribute name;
    // the loop's whitespace skip handles what follows.
    }
  }
}

// ---------------------------------------------------------------- autolinks
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*/;
const DOMAIN_PART_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*/;
const EMAIL_NEXT_BAD = /[A-Za-z0-9#$%&'+\/=^_`{|}-]/;
// Is the character after a matched email a bad continuation? A single '_'
// rejects the email (gfm-632: a.b_ is not a link), but '__' does not: it
// is an emphasis closer, and the email inside __...__ still links. A
// single '_' also does not reject when it closes an active '_' opener
// (doc-31/34/37: '_warning when@atlas.example.com_' links); then it is
// an emphasis closer, not part of the email. `allowUnderscore` is true
// when such an opener exists and the '_' can close (followed by space,
// end, or punctuation).
function emailNextBad(s, end, allowUnderscore) {
  const nx = s[end];
  if (nx === undefined) return false;
  if (nx === '_') {
    if (s[end + 1] === '_') return false;
    if (allowUnderscore) {
      const after = s[end + 1];
      if (after === undefined || isWhitespace(after) || isPunct(after)) return false;
    }
    return true;
  }
  return EMAIL_NEXT_BAD.test(nx);
}
// Match an email domain at s[pos]; returns the index past it, or -1.
function matchEmailDomain(s, pos, allowUnderscore) {
  const m = DOMAIN_PART_RE.exec(s.slice(pos));
  if (!m) return -1;
  const end = pos + m[0].length;
  if (emailNextBad(s, end, allowUnderscore)) return -1;
  return end;
}
// Match an email address at s[pos]; returns the index past it, or -1.
function matchEmailAt(s, pos) {
  const m = EMAIL_RE.exec(s.slice(pos));
  if (!m) return -1;
  const end = pos + m[0].length;
  if (emailNextBad(s, end)) return -1;
  return end;
}
// Same, but the email may be followed by '/' (scheme:email/segment form).
function matchEmailAtSlash(s, pos) {
  const m = EMAIL_RE.exec(s.slice(pos));
  if (!m) return -1;
  const end = pos + m[0].length;
  const nx = s[end];
  if (nx !== undefined && nx !== '/' && emailNextBad(s, end)) return -1;
  return end;
}
// <scheme:...> or <email> autolink at s[i] ('<').
function parseAutolink(s, i) {
  const rest = s.slice(i);
  let m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}):([^<>\x00-\x20]*)>/.exec(rest);
  if (m) return { dest: m[1] + ':' + m[2], text: m[1] + ':' + m[2], next: i + m[0].length };
  m = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(rest);
  if (m) return { dest: 'mailto:' + m[1], text: m[1], next: i + m[0].length };
  return null;
}

const TRAILING_PUNCT = new Set(['?', '!', '.', ',', ':', ';', '*', '_', '~', "'", '"']);
// Trim trailing punctuation, unbalanced ')' and entity-like ';' off a bare URL.
function backpedal(url, openBefore) {
  openBefore = openBefore || 0;
  for (;;) {
    if (url === '') return '';
    const last = url[url.length - 1];
    if (last === ')') {
      let open = openBefore, close = 0;
      for (let k = 0; k < url.length; k++) {
        if (url[k] === '(') open++;
        else if (url[k] === ')') close++;
      }
      if (close > open) { url = url.slice(0, -1); continue; }
      return url;
    }
    if (last === ';') {
      const m = /&(?:#\d+|#[Xx][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*)$/.exec(url.slice(0, -1));
      if (m) { url = url.slice(0, url.length - 1 - m[0].length); continue; }
      // Not entity-like: fall through and trim the ';' as punctuation.
    }
    if (TRAILING_PUNCT.has(last)) { url = url.slice(0, -1); continue; }
    return url;
  }
}
const DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const DOMAIN_RE = new RegExp('^(?:' + DOMAIN_LABEL + '\\.)+[A-Za-z]{2,}');
// Does a link-dest '(' immediately before the URL count for paren
// balance? Only when the URL continues past the ')' that closes it
// (doc-12: '...page=4)](./docs/create.md)' — depth returns to 0 in the
// middle, so the final ')' stays). When depth only reaches 0 at the
// URL's last character (plain '(https://...)' / '(other))' cases) the
// '(' must not count, or the trailing ')' would wrongly be kept.
function openParensBefore(s, p, url) {
  if (p < 2 || s[p - 1] !== '(' || s[p - 2] !== ']') return 0;
  let depth = 1; // the '(' before the URL
  for (let k = 0; k < url.length; k++) {
    if (url[k] === '(') depth++;
    else if (url[k] === ')') {
      depth--;
      // The '(' counts only if real URL content follows this ')' —
      // trailing punctuation ('?.' etc., trimmed by backpedal later)
      // does not count as content.
      if (depth === 0 && k < url.length - 1) {
        let rest = false;
        for (let m = k + 1; m < url.length; m++) {
          if (!TRAILING_PUNCT.has(url[m])) { rest = true; break; }
        }
        if (rest) return 1;
      }
    }
  }
  return 0;
}
// Match a www. autolink at s[i] ('w'). Returns { url, next, start } or null.
// stopAtBracket(pos) returns true when a ']' at pos should end the URL
// (it would close a '[' whose link would form).
function matchWww(s, i, stopAtBracket) {
  if (i > 0 && /[A-Za-z0-9]/.test(s[i - 1])) return null;
  const m = DOMAIN_RE.exec(s.slice(i + 4));
  if (!m) return null;
  let end = i + 4 + m[0].length;
  while (end < s.length) {
    const ch = s[end];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<' || ch === '>') break;
    if (ch === ']' && (!stopAtBracket || stopAtBracket(end))) break;
    // After swallowing a ']', a '(' group is part of this URL only when
    // it closes before any whitespace (doc-36/doc-12: '(https://.../page=2)'
    // and '(./docs/create.md)' are swallowed; doc-08's
    // '(https://npmjs.com/heading (Most))' has a space, so the '(' starts
    // a separate autolink and is not swallowed).
    if (ch === '(' && end > i && s[end - 1] === ']') {
      let j = end + 1, depth = 1;
      while (j < s.length && depth > 0) {
        const c2 = s[j];
        if (c2 === ' ' || c2 === '\t' || c2 === '\n') break;
        if (c2 === '(') depth++;
        else if (c2 === ')') depth--;
        j++;
      }
      if (depth !== 0) break;
    }
    end++;
  }
  const url = backpedal(s.slice(i, end), openParensBefore(s, i, s.slice(i, end)));
  if (!url) return null;
  return { url, next: i + url.length, start: i };
}
// Match a scheme autolink whose ':' is at s[i]; `scheme` is the scheme
// text taken from the end of the current text node. Returns { url, next }
// (next is the source index just past the URL) or null.
function matchScheme(s, i, scheme, stopAtBracket) {
  if (scheme.length < 2 || scheme.length > 32 || !/[A-Za-z]/.test(scheme[0])) return null;
  let end;
  if (s[i + 1] === '/' && s[i + 2] === '/') {
    // scheme://domain/path
    const dm = DOMAIN_RE.exec(s.slice(i + 3));
    if (!dm) return null;
    end = i + 3 + dm[0].length;
    while (end < s.length) {
      const ch = s[end];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<' || ch === '>') break;
      if (ch === ']' && (!stopAtBracket || stopAtBracket(end))) break;
      // After swallowing a ']', a '(' group is part of this URL only when
      // it closes before any whitespace (doc-36/doc-12: '(https://.../page=2)'
      // and '(./docs/create.md)' are swallowed; doc-08's
      // '(https://npmjs.com/heading (Most))' has a space, so the '(' starts
      // a separate autolink and is not swallowed).
      if (ch === '(' && end > i && s[end - 1] === ']') {
        let j = end + 1, depth = 1;
        while (j < s.length && depth > 0) {
          const c2 = s[j];
          if (c2 === ' ' || c2 === '\t' || c2 === '\n') break;
          if (c2 === '(') depth++;
          else if (c2 === ')') depth--;
          j++;
        }
        if (depth !== 0) break;
      }
      end++;
    }
  } else {
    // scheme:email[/segment] — the email may be followed by one /segment.
    const emEnd = matchEmailAtSlash(s, i + 1);
    if (emEnd < 0) return null;
    end = emEnd;
    if (s[end] === '/') {
      let j = end + 1;
      while (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '<' && s[j] !== '>' && s[j] !== '/') j++;
      if (j > end + 1) end = j;
    }
  }
  const raw = scheme + s.slice(i, end);
  const url = backpedal(raw, openParensBefore(s, i - scheme.length, raw));
  if (!url) return null;
  return { url, next: end - (raw.length - url.length) };
}
// Match a bare email whose '@' is at s[at]; `local` is the local part taken
// from the end of the current text node. Returns { url, next } or null.
function matchBareEmail(s, at, local, allowUnderscore) {
  if (local.length === 0) return null;
  const end = matchEmailDomain(s, at + 1, allowUnderscore);
  if (end < 0) return null;
  return { url: local + s.slice(at, end), next: end };
}

// ---------------------------------------------------------------- inline parser

function inNode(t) {
  return { t, lit: '', next: null, prev: null, parent: null, first: null, last: null, dest: null, title: null, alt: null };
}
function inAppend(parent, child) {
  child.parent = parent;
  if (parent.last) { parent.last.next = child; child.prev = parent.last; parent.last = child; }
  else { parent.first = parent.last = child; }
}
function inUnlink(n) {
  if (n.prev) n.prev.next = n.next; else if (n.parent) n.parent.first = n.next;
  if (n.next) n.next.prev = n.prev; else if (n.parent) n.parent.last = n.prev;
  n.prev = n.next = n.parent = null;
}
function inInsertAfter(n, child) {
  child.parent = n.parent;
  child.prev = n;
  child.next = n.next;
  if (n.next) n.next.prev = child; else if (n.parent) n.parent.last = child;
  n.next = child;
}
function normalizeCodeSpan(content) {
  const s = content.replace(/\n/g, ' ');
  if (s.length >= 2 && s[0] === ' ' && s[s.length - 1] === ' ' && /[^ ]/.test(s)) return s.slice(1, -1);
  return s;
}
function flanking(s, start, end) {
  const before = start > 0 ? s[start - 1] : '';
  const after = end < s.length ? s[end] : '';
  const beforeWs = before === '' || isWhitespace(before);
  const afterWs = after === '' || isWhitespace(after);
  const beforePunct = before !== '' && isPunct(before);
  const afterPunct = after !== '' && isPunct(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { left, right, beforePunct, afterPunct };
}

// Find the next "special" character at or after i (for text runs).
const SPECIAL_RE = /[\n\\`*_~\[\]<>!@:]|w(?=ww\.)/g;

function parseInline(s, refs) {
  const root = inNode('root');
  const n = s.length;
  let curText = null;
  let dHead = null, dTail = null;
  // Set when a backtick run finds no closer (it stays literal). A later
  // backtick run in the same link text must not swallow a `]` that would
  // close the link (doc-16: the unmatched `` `` `` before the single
  // backtick means the single-backtick span does not swallow `]`).
  let hasUnmatchedBacktick = false;

  function textNode() {
    if (!curText) { curText = inNode('text'); inAppend(root, curText); }
    return curText;
  }
  function addText(str) {
    if (str) textNode().lit += str;
  }
  function addDelim(d) {
    d.prev = dTail; d.next = null;
    if (dTail) dTail.next = d; else dHead = d;
    dTail = d;
  }
  function removeDelim(d) {
    if (d.prev) d.prev.next = d.next; else dHead = d.next;
    if (d.next) d.next.prev = d.prev; else dTail = d.prev;
    d.prev = d.next = null;
  }
  // Replace every bare autolink (email, www., scheme) in a node's subtree
  // with plain text of its URL. Used when a bracket link forms: bare
  // autolinks inside its text stay literal, while angle autolinks <...>
  // keep their link. A bare autolink is only stripped when the enclosing
  // link actually forms, so one inside a '[' that never forms a link
  // stays a link.
  function stripBareAutolinks(parent) {
    let c = parent.first;
    while (c) {
      const nxt = c.next;
      if (c.t === 'link' && c.bare) {
        const tn = inNode('text');
        tn.lit = plainText(c);
        tn.prev = c.prev; tn.next = c.next; tn.parent = parent;
        if (c.prev) c.prev.next = tn; else parent.first = tn;
        if (c.next) c.next.prev = tn; else parent.last = tn;
      } else if (c.t === 'em' || c.t === 'strong' || c.t === 'del' || c.t === 'link') {
        stripBareAutolinks(c);
      }
      c = nxt;
    }
  }
  function truncText(count) {
    if (curText) {
      curText.lit = curText.lit.slice(0, curText.lit.length - count);
      if (curText.lit === '') { inUnlink(curText); curText = null; }
    }
  }
  // Length of the trailing run of text nodes at the end of the root.
  function trailingTextLen() {
    let total = 0;
    let nd = root.last;
    while (nd && nd.t === 'text') { total += nd.lit.length; nd = nd.prev; }
    return total;
  }
  // Remove `count` trailing characters from the root's last text nodes.
  // An autolink's local part / scheme can span delimiter nodes (which are
  // separate text nodes), so the rewind walks back across them. Delimiter
  // entries whose node is removed are dropped. Returns the count removed.
  function rewindText(count) {
    let removed = 0;
    while (removed < count && root.last) {
      const nd = root.last;
      if (nd.t !== 'text') break;
      const take = Math.min(count - removed, nd.lit.length);
      nd.lit = nd.lit.slice(0, nd.lit.length - take);
      removed += take;
      if (nd.lit === '') {
        inUnlink(nd);
        for (let d = dHead; d; d = d.next) {
          if (d.node === nd) { removeDelim(d); break; }
        }
      }
    }
    curText = null;
    return removed;
  }

  // Try to form a link/image at s[pos] (']'). Returns the new scan index, or -1.
  function tryFormLink(closePos) {
    let opener = null;
    for (let d = dTail; d; d = d.prev) {
      if (d.char === '[' && d.active) { opener = d; break; }
    }
    if (!opener) return -1;
    const rawLabel = s.slice(opener.srcPos + 1, closePos);
    let pos = closePos + 1;
    let dest = null, title = null;
    if (s[pos] === '(') {
      const link = parseInlineLink(s, pos);
      if (link) { dest = link.dest; title = link.title; pos = link.next; }
    }
    if (dest === null && s[pos] === '[') {
      const lab = parseLinkLabel(s, pos);
      if (lab) {
        const ref = refs.get(normalizeLabel(lab.label));
        if (ref) { dest = ref.dest; title = ref.title; pos = lab.next; }
        else { opener.active = false; return -1; } // full ref label parsed but unknown: no shortcut fallback
      }
      // No valid label after '[': fall through to collapsed / shortcut.
    }
    if (dest === null && s[pos] === '[' && s[pos + 1] === ']') {
      const ref = refs.get(normalizeLabel(rawLabel));
      if (ref) { dest = ref.dest; title = ref.title; pos = pos + 2; }
    }
    if (dest === null) {
      const ref = refs.get(normalizeLabel(rawLabel));
      if (ref) { dest = ref.dest; title = ref.title; }
    }
    if (dest === null) {
      opener.active = false;
      return -1;
    }
    // A link cannot contain a link (an image's text may: it becomes alt text).
    if (!opener.image) {
      let m = opener.node.next;
      let hasLink = false;
      while (m) {
        if (subtreeHasLink(m)) { hasLink = true; break; }
        m = m.next;
      }
      if (hasLink) { opener.active = false; return -1; }
    }
    // A link whose text contains a code span holding a backtick does not
    // form when text follows that code span inside the link text (the
    // bracket scanner loses the `]`); when the backticked code span is
    // the last thing in the text the link forms (doc-03/doc-23). Only
    // a code span with a backtick inside counts — a plain code span
    // followed by text is fine (cm-516).
    {
      const nodeText = (n) => {
        if (n.t === 'text' || n.t === 'code' || n.t === 'html') return n.lit || '';
        if (n.t === 'softbreak' || n.t === 'hardbreak') return '\n';
        return plainText(n);
      };
      let m = opener.node.next;
      let blocked = false;
      while (m) {
        if (m.t === 'code' && m.lit && m.lit.includes('`')) {
          let n = m.next;
          while (n) {
            if (nodeText(n).trim() !== '') { blocked = true; break; }
            n = n.next;
          }
          if (blocked) break;
        }
        m = m.next;
      }
      if (blocked) { opener.active = false; opener.closePos = closePos; return -1; }
    }
    // Deactivate '[' openers inside this link (a link cannot contain a link).
    for (let d = dHead; d; d = d.next) {
      if (d.char === '[' && d.active && d.srcPos > opener.srcPos) d.active = false;
    }
    removeDelim(opener);
    // Build the link/image node from the nodes after the opener node.
    const linkNode = inNode(opener.image ? 'image' : 'link');
    linkNode.dest = dest; linkNode.title = title;
    const oldTail = root.last;
    if (opener.node.next) {
      linkNode.first = opener.node.next;
      linkNode.last = oldTail;
      let m = opener.node.next;
      while (m) { m.parent = linkNode; if (m === oldTail) break; m = m.next; }
      linkNode.last.next = null;
      linkNode.first.prev = null;
    }
    const prevNode = opener.node.prev;
    if (prevNode) prevNode.next = linkNode; else root.first = linkNode;
    linkNode.prev = prevNode;
    linkNode.next = null;
    linkNode.parent = root;
    root.last = linkNode;
    // Bare autolinks inside the link's text become plain text; angle
    // autolinks keep their link.
    stripBareAutolinks(linkNode);
    if (opener.image && opener.bangNode) {
      const bn = opener.bangNode;
      bn.lit = bn.lit.slice(0, opener.bangOff) + bn.lit.slice(opener.bangOff + 1);
    }
    curText = null;
    return pos;
  }

  // Does this inline node's subtree contain a bracket link? (An image
  // inside a link is fine; only a bracket link inside a link is forbidden.
  // An autolink inside a link's text is allowed and does not block it.)
  function subtreeHasLink(n) {
    if (n.t === 'link' && !n.auto) return true;
    for (let c = n.first; c; c = c.next) if (subtreeHasLink(c)) return true;
    return false;
  }

  // Would a ']' at source position pos close a '[' whose link would form?
  // Used while scanning a bare URL: stop at the ']' only when the link
  // would form; if the text between the opener and here already contains
  // a bracket link, the link can't form, the ']' is literal, and the URL
  // may swallow it (and what follows) as part of the autolink.
  function bracketStopsAt(pos) {
    let opener = null;
    for (let d = dTail; d; d = d.prev) {
      if (d.char === '[' && d.active) { opener = d; break; }
    }
    if (!opener) return false;
    let m = opener.node.next;
    while (m) {
      if (subtreeHasLink(m)) return false;
      m = m.next;
    }
    return true;
  }

  // Is there an active '_' opener that a trailing '_' could close?
  function hasUnderscoreOpener() {
    for (let d = dTail; d; d = d.prev) {
      if (d.char === '_' && d.active && d.canOpen) return true;
    }
    return false;
  }

  // ---- scan ----
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === '\n') {
      const tn = curText;
      if (tn && tn.lit.length >= 2 && tn.lit.endsWith('  ')) {
        tn.lit = tn.lit.replace(/ +$/, '');
        if (tn.lit === '') { inUnlink(tn); }
        const br = inNode('hardbreak');
        inAppend(root, br);
        curText = null;
        i++;
        // A hard break strips the leading whitespace of the next line.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      } else {
        const sb = inNode('softbreak');
        inAppend(root, sb);
        curText = null;
      }
      i++;
      continue;
    }
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        const br = inNode('hardbreak');
        inAppend(root, br);
        curText = null;
        i += 2;
        // A hard break strips the leading whitespace of the next line.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        addText(nx);
        // An escaped '&' ends its text node: the '&' is a literal character
        // and must not be read as the start of an entity reference.
        if (nx === '&') curText = null;
        i += 2;
        continue;
      }
      addText('\\');
      i++;
      continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const len = j - i;
      let k = j, found = -1, blocked = false;
      while (k < n) {
        if (s[k] === '`') {
          let m = k;
          while (m < n && s[m] === '`') m++;
          if (m - k === len) { found = k; break; }
          k = m;
        } else if (s[k] === ']' && (s[k + 1] === '(' || s[k + 1] === '[') && bracketStopsAt(k)) {
          // A ']' that would close a forming link. The code span must
          // not swallow it when the closer is on a later line
          // (doc-09/doc-28: the link forms, the backticks stay literal).
          // When the closer is on the same line the span wins
          // (cm-342/525/537: '[not a `link](/foo`)' -> code span).
          blocked = true;
          k++;
        } else k++;
      }
      if (found >= 0 && blocked && (s.slice(i, found).indexOf('\n') !== -1 || hasUnmatchedBacktick)) found = -1;
      if (found >= 0) {
        const cn = inNode('code');
        cn.lit = normalizeCodeSpan(s.slice(j, found));
        inAppend(root, cn);
        curText = null;
        i = found + len;
        continue;
      }
      hasUnmatchedBacktick = true;
      addText(s.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '*' || ch === '_') {
      let j = i;
      while (j < n && s[j] === ch) j++;
      const len = j - i;
      const dnode = inNode('text');
      dnode.lit = s.slice(i, j);
      inAppend(root, dnode);
      curText = null;
      const fl = flanking(s, i, j);
      let canOpen, canClose;
      if (ch === '*') { canOpen = fl.left; canClose = fl.right; }
      else { canOpen = fl.left && (!fl.right || fl.beforePunct); canClose = fl.right && (!fl.left || fl.afterPunct); }
      addDelim({ char: ch, len, origLen: len, canOpen, canClose, node: dnode, active: true, srcPos: i, prev: null, next: null });
      i = j;
      continue;
    }
    if (ch === '~') {
      let j = i;
      while (j < n && s[j] === '~') j++;
      const len = j - i;
      if (len > 2) { addText(s.slice(i, j)); i = j; continue; }
      const dnode = inNode('text');
      dnode.lit = s.slice(i, j);
      inAppend(root, dnode);
      curText = null;
      const after = j < n ? s[j] : '';
      const before = i > 0 ? s[i - 1] : '';
      addDelim({
        char: '~', len,
        canOpen: after !== '' && !isWhitespace(after),
        canClose: before !== '' && !isWhitespace(before),
        node: dnode, active: true, srcPos: i, prev: null, next: null,
      });
      i = j;
      continue;
    }
    if (ch === '[') {
      const dnode = inNode('text');
      dnode.lit = '[';
      inAppend(root, dnode);
      curText = null;
      hasUnmatchedBacktick = false;
      addDelim({ char: '[', len: 1, canOpen: true, canClose: false, node: dnode, active: true, image: false, srcPos: i, prev: null, next: null });
      i++;
      continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      const tn = textNode();
      const off = tn.lit.length;
      tn.lit += '!';
      const dnode = inNode('text');
      dnode.lit = '[';
      inAppend(root, dnode);
      curText = null;
      addDelim({ char: '[', len: 1, canOpen: true, canClose: false, node: dnode, active: true, image: true, bangNode: tn, bangOff: off, srcPos: i + 1, prev: null, next: null });
      i += 2;
      continue;
    }
    if (ch === ']') {
      const next = tryFormLink(i);
      if (next >= 0) { i = next; continue; }
      addText(']');
      i++;
      continue;
    }
    if (ch === '<') {
      const auto = parseAutolink(s, i);
      if (auto) {
        const ln = inNode('link');
        ln.auto = true;
        ln.dest = auto.dest; ln.title = null;
        const tn = inNode('text');
        tn.lit = auto.text;
        inAppend(ln, tn);
        inAppend(root, ln);
        curText = null;
        i = auto.next;
        continue;
      }
      const tagEnd = parseTagEnd(s, i);
      if (tagEnd > 0) {
        const hn = inNode('html');
        hn.lit = s.slice(i, tagEnd);
        inAppend(root, hn);
        curText = null;
        i = tagEnd;
        continue;
      }
      addText('<');
      i++;
      continue;
    }
    if (ch === '@') {
      // Scan the source backwards for the local part: it can span
      // delimiter nodes (e.g. the '_' in 'a.b-c_d@a.b' is its own node).
      let k = i;
      while (k > 0 && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[k - 1])) k--;
      const local = s.slice(k, i);
      // A backslash immediately before the local part means its first
      // character is escaped, so this is not an email address.
      if (k > 0 && s[k - 1] === '\\') { addText('@'); i++; continue; }
      const em = matchBareEmail(s, i, local, hasUnderscoreOpener());
      if (em && local.length > 0 && trailingTextLen() >= local.length) {
        rewindText(local.length);
        const ln = inNode('link');
        ln.auto = true;
        ln.bare = true;
        ln.dest = 'mailto:' + em.url; ln.title = null;
        const tn = inNode('text');
        tn.lit = em.url;
        inAppend(ln, tn);
        inAppend(root, ln);
        curText = null;
        i = em.next;
        continue;
      }
      addText('@');
      i++;
      continue;
    }
    if (ch === 'w' && s[i + 1] === 'w' && s[i + 2] === 'w' && s[i + 3] === '.') {
      const w = matchWww(s, i, bracketStopsAt);
      if (w) {
        const ln = inNode('link');
        ln.auto = true;
        ln.bare = true;
        ln.dest = 'http://' + w.url; ln.title = null;
        const tn = inNode('text');
        tn.lit = w.url;
        inAppend(ln, tn);
        inAppend(root, ln);
        curText = null;
        i = w.next;
        continue;
      }
      addText('w');
      i++;
      continue;
    }
    if (ch === ':') {
      // Scan the source backwards for the scheme (it can span text nodes).
      let k = i;
      while (k > 0 && /[A-Za-z0-9+.-]/.test(s[k - 1])) k--;
      const scheme = s.slice(k, i);
      const sc = matchScheme(s, i, scheme, bracketStopsAt);
      if (sc && scheme.length > 0 && trailingTextLen() >= scheme.length) {
        rewindText(scheme.length);
        const ln = inNode('link');
        ln.auto = true;
        ln.bare = true;
        ln.dest = sc.url; ln.title = null;
        const tn = inNode('text');
        tn.lit = sc.url;
        inAppend(ln, tn);
        inAppend(root, ln);
        curText = null;
        i = sc.next;
        continue;
      }
      addText(':');
      i++;
      continue;
    }
    // Plain text run up to the next special character. If the current
    // character itself is special but has no branch above (e.g. '>'),
    // emit it as a single text character.
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    const end = m ? m.index : n;
    if (end === i) { addText(s[i]); i++; }
    else { addText(s.slice(i, end)); i = end; }
  }

  // ---- emphasis / strikethrough ----
  processEmphasis();

  function processEmphasis() {
    let current = dHead;
    while (current) {
      if (current.char === '[' || !current.canClose) { current = current.next; continue; }
      let opener = current.prev;
      let matched = false;
      while (opener) {
        if (opener.char !== current.char || !opener.canOpen) { opener = opener.prev; continue; }
        // An opener and a closer can only pair inside the same container
        // (same parent node): emphasis cannot span a link boundary, and a
        // delimiter already inside a formed emphasis cannot pair outside it.
        if (opener.node.parent !== current.node.parent) { opener = opener.prev; continue; }
        if ((current.char === '*' || current.char === '_')) {
          const oddMatch = (opener.canOpen && opener.canClose) || (current.canOpen && current.canClose);
          if (oddMatch && (opener.len + current.len) % 3 === 0 && !(opener.len % 3 === 0 && current.len % 3 === 0)) {
            opener = opener.prev; continue;
          }
        }
        if (current.char === '~' && opener.len !== current.len) { opener = opener.prev; continue; }
        // A single closer must not consume a double opener when a later
        // double closer can form a strong with it (marked matches the
        // greedy **...** strong; the stray single delimiter stays literal).
        // Only when the opener has exactly 2: with 3+, one delimiter can
        // go to the em and two remain for the strong (cm-430 ***foo* bar**).
        if ((current.char === '*' || current.char === '_') && current.len === 1 && opener.len === 2) {
          let later = current.next;
          let hasLaterStrong = false;
          while (later) {
            if (later.char === current.char && later.len >= 2 && later.canClose && later.node.parent === opener.node.parent) { hasLaterStrong = true; break; }
            later = later.next;
          }
          if (hasLaterStrong) { opener = opener.prev; continue; }
        }
        // A single '*' emphasis must not span a strong that is detached
        // from the text before it (space) but attached to the text after
        // it (no space): '*browser in so **change**in*' stays literal,
        // and '*input **parse**parse*' inside a strong stays literal
        // (doc-07/doc-11). It does NOT apply when the strong itself
        // contains an inner <em> (doc-15/21/30/31: '*our <strong>library
        // output <em>markdown</em></strong>*' DOES form), nor with a
        // space after the strong (cm-410) or no space before it (cm-411).
        // This is '*'-only: '_' emphasis DOES form in this shape
        // (doc-05/31/37: '_large <strong>data</strong>not_' -> em). The
        // text after the strong must be real content, not a delimiter
        // node (cm-414: '*foo **bar***' — the '*' right after the strong
        // is the closer itself, not content, so the emphasis forms). A
        // skipped opener is deactivated: it must not be grabbed by a
        // later closer (doc-11: the '*' before 'input' must not pair
        // with the '**' that closes the outer strong).
        if (current.char === '*' && current.len === 1 && opener.len === 1) {
          let nd = opener.node.next;
          let skip = false;
          while (nd !== null && nd !== current.node) {
            if (nd.t === 'strong') {
              const before = nd.prev;
              const after = nd.next;
              let afterIsDelim = false;
              if (after) for (let d = dHead; d; d = d.next) if (d.node === after) { afterIsDelim = true; break; }
              let innerEm = false;
              for (let c = nd.first; c; c = c.next) if (c.t === 'em') { innerEm = true; break; }
              if (!innerEm && before && before.t === 'text' && before.lit.endsWith(' ') &&
                  after && after.t === 'text' && !afterIsDelim && after.lit.length > 0 && !isWhitespace(after.lit[0])) {
                skip = true;
              }
              break;
            }
            nd = nd.next;
          }
          if (skip) {
            // Deactivate the opener (keep its text node: the '*' stays
            // literal) so a later closer cannot grab it.
            const op = opener; opener = opener.prev;
            removeDelim(op);
            continue;
          }
        }
        // Emphasis must not span a code span that itself contains a
        // backtick when the emphasis sits inside brackets `[`...`]` of a
        // link that did not form (doc-16/doc-20/doc-23: '_node `` a ` b
        // ``_' stays literal inside the failed link text). In plain
        // text the same emphasis DOES form. Only a `[` whose `]` actually
        // encloses the emphasis counts (a `[` from an earlier, separate
        // link does not — doc-11); the failed link opener records its
        // `]` position in `closePos`.
        {
          let nd = opener.node.next;
          let spansTick = false;
          while (nd !== null && nd !== current.node) {
            if (nd.t === 'code' && nd.lit && nd.lit.includes('`')) { spansTick = true; break; }
            nd = nd.next;
          }
          if (spansTick) {
            let inBrackets = false;
            for (let d = dHead; d && d !== opener; d = d.next) {
              if (d.char === '[' && d.closePos !== undefined && d.srcPos < opener.srcPos && current.srcPos < d.closePos) { inBrackets = true; break; }
            }
            if (inBrackets) { opener = opener.prev; continue; }
          }
        }
        // Match found.
        const use = current.char === '~' ? opener.len : (opener.len >= 2 && current.len >= 2 ? 2 : 1);
        const tag = current.char === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const emNode = inNode(tag);
        // Move the nodes between the opener and closer nodes into emNode.
        let nd = opener.node.next;
        while (nd !== null && nd !== current.node) {
          const nxt = nd.next;
          inUnlink(nd);
          inAppend(emNode, nd);
          nd = nxt;
        }
        inInsertAfter(opener.node, emNode);
        // Consume the delimiters.
        opener.node.lit = opener.node.lit.slice(0, opener.node.lit.length - use);
        current.node.lit = current.node.lit.slice(use);
        opener.len -= use;
        current.len -= use;
        // When the closer has exactly one leftover delimiter, the opener
        // was a plain '**' strong, and the emphasis just formed contains
        // an inner <em>, the leftover text belongs INSIDE the emphasis
        // (doc-30/doc-11: '**by command *tool*one***' ->
        // '<strong>...one*</strong>'). But only when no earlier opener
        // remains for the leftover to pair with (doc-15: '*our **library
        // output *markdown****' — the leftover '*' must pair with the
        // '*' before 'our' to form the outer em, not move inside).
        // Without an inner <em> the leftover stays after it (cm-446:
        // '**foo***' -> '<strong>foo</strong>*'). Narrow on purpose:
        // nested multi-strong runs (cm-417) must not have their
        // leftovers moved.
        if (current.len === 1 && opener.len + use === 2 && current.node.lit !== '') {
          let hasInnerEm = false;
          for (let c = emNode.first; c; c = c.next) {
            if (c.t === 'em') { hasInnerEm = true; break; }
          }
          if (hasInnerEm) {
            let earlierOpener = false;
            for (let d = current.prev; d; d = d.prev) {
              if (d.len > 0 && d.char === current.char && d.canOpen && d.active && d.node.parent === current.node.parent) { earlierOpener = true; break; }
            }
            if (!earlierOpener) {
              const leftover = current.node;
              inUnlink(leftover);
              inAppend(emNode, leftover);
            }
          }
        }
        if (opener.len === 0) { const op = opener; opener = opener.prev; inUnlink(op.node); removeDelim(op); }
        if (current.len === 0) {
          const nxt = current.next;
          inUnlink(current.node);
          removeDelim(current);
          current = nxt;
          matched = true;
          break;
        }
        matched = true;
        // The closer still has delimiters: look for another opener.
      }
      if (!matched) {
        // No opener: the delimiter stays as literal text.
        current = current.next;
      }
    }
  }

  return root;
}

// Plain text of an inline tree (for image alt text).
function plainText(node) {
  let out = '';
  for (let n = node.first; n; n = n.next) {
    if (n.t === 'text' || n.t === 'code') out += n.lit;
    else if (n.t === 'softbreak' || n.t === 'hardbreak') out += '\n';
    else if (n.t === 'image') out += plainText(n);
    else if (n.t === 'html') out += n.lit;
    else if (n.t === 'link' || n.t === 'em' || n.t === 'strong' || n.t === 'del') out += plainText(n);
  }
  return out;
}

// marked's cleanUrl: percent-encode the href, but keep existing %XX escapes.
function cleanUrl(href) {
  try {
    return escText(encodeURI(href).replace(/%25/g, '%'));
  } catch (e) {
    return escText(href);
  }
}

function renderInline(node) {
  let out = '';
  for (let n = node.first; n; n = n.next) {
    if (n.t === 'text') out += escText(n.lit);
    else if (n.t === 'code') out += '<code>' + escFull(n.lit) + '</code>';
    else if (n.t === 'html') out += n.lit;
    else if (n.t === 'softbreak') out += '\n';
    else if (n.t === 'hardbreak') out += '<br>';
    else if (n.t === 'em') out += '<em>' + renderInline(n) + '</em>';
    else if (n.t === 'strong') out += '<strong>' + renderInline(n) + '</strong>';
    else if (n.t === 'del') out += '<del>' + renderInline(n) + '</del>';
    else if (n.t === 'link') {
      out += '<a href="' + cleanUrl(n.dest) + '"';
      if (n.title !== null && n.title !== undefined) out += ' title="' + escText(n.title) + '"';
      out += '>' + renderInline(n) + '</a>';
    } else if (n.t === 'image') {
      // Alt text is the plain text of the image's content, computed at
      // render time (after emphasis processing has run inside it).
      out += '<img src="' + cleanUrl(n.dest) + '" alt="' + escText(plainText(n)) + '"';
      if (n.title !== null && n.title !== undefined) out += ' title="' + escText(n.title) + '"';
      out += '>';
    }
  }
  return out;
}

// ---------------------------------------------------------------- tables (GFM)

// Split a table row on unescaped '|', unescaping '\|' and trimming cells.
// Leading / trailing pipes do not create empty cells.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (cells.length > 1 && cells[0] === '' && /^[ \t]*\|/.test(line)) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1] === '' && /\|[ \t]*$/.test(line)) cells.pop();
  return cells;
}
function hasUnescapedPipe(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '|') return true;
  }
  return false;
}
// If the paragraph lines form a table, return { header, aligns, rows }.
function parseTable(lines) {
  if (lines.length < 2) return null;
  if (!hasUnescapedPipe(lines[0])) return null;
  const header = splitTableRow(lines[0]);
  const delimCells = splitTableRow(lines[1]);
  if (delimCells.length !== header.length) return null;
  const aligns = [];
  for (const cell of delimCells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    if (m[1] === ':' && m[2] === ':') aligns.push('center');
    else if (m[1] === ':') aligns.push('left');
    else if (m[2] === ':') aligns.push('right');
    else aligns.push(null);
  }
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitTableRow(lines[i]);
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
  }
  return { header, aligns, rows };
}
function renderTable(t, refs) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let k = 0; k < t.header.length; k++) {
    out += t.aligns[k] ? '<th align="' + t.aligns[k] + '">' : '<th>';
    out += renderInline(parseInline(t.header[k], refs)) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (t.rows.length > 0) {
    out += '<tbody>';
    for (const row of t.rows) {
      out += '<tr>\n';
      for (let k = 0; k < t.header.length; k++) {
        out += t.aligns[k] ? '<td align="' + t.aligns[k] + '">' : '<td>';
        out += renderInline(parseInline(row[k], refs)) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return out;
}

// ---------------------------------------------------------------- rendering

function renderParaLines(lines, refs) {
  if (lines.length === 0) return { html: '', isTable: false };
  const table = parseTable(lines);
  if (table) return { html: renderTable(table, refs), isTable: true };
  return { html: renderInline(parseInline(lines.join('\n'), refs)), isTable: false };
}

function collectRefs(doc, refs) {
  (function walk(children) {
    for (const b of children) {
      // Definitions extracted earlier (e.g. at a setext conversion) are
      // merged first: they precede the paragraph's remaining lines.
      if (b.refDefs) {
        for (const d of b.refDefs) {
          if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
        }
      }
      if (b.t === 'para') {
        const r = extractRefDefs(b.lines);
        for (const d of r.defs) {
          if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
        }
        b.lines = r.lines;
      } else if (b.children) walk(b.children);
    }
  })(doc.children);
}

function renderBlocks(children, refs, out) {
  for (const b of children) {
    if (b.t === 'para') {
      const r = renderParaLines(b.lines, refs);
      if (r.html === '') continue;
      if (r.isTable) out.push(r.html);
      else out.push('<p>' + r.html + '</p>\n');
    } else if (b.t === 'heading') {
      const text = b.text !== undefined ? b.text : b.lines.join('\n').trim();
      out.push('<h' + b.level + '>' + renderInline(parseInline(text, refs)) + '</h' + b.level + '>\n');
    } else if (b.t === 'code') {
      let content = b.lines.join('\n');
      if (content.length > 0 && !content.endsWith('\n')) content += '\n';
      let info = '';
      if (b.fenced && b.info) {
        const lang = unescapePunct(b.info.trim().split(/[ \t]/)[0]);
        if (lang) info = ' class="language-' + escText(lang) + '"';
      }
      out.push('<pre><code' + info + '>' + escFull(content) + '</code></pre>\n');
    } else if (b.t === 'html') {
      out.push(b.lines.join('\n') + (b.trailNL ? '\n' : ''));
    } else if (b.t === 'quote') {
      out.push('<blockquote>\n');
      renderBlocks(b.children, refs, out);
      out.push('</blockquote>\n');
    } else if (b.t === 'list') {
      const tag = b.ordered ? 'ol' : 'ul';
      out.push('<' + tag + (b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n');
      renderBlocks(b.children, refs, out);
      out.push('</' + tag + '>\n');
    } else if (b.t === 'item') {
      out.push('<li>');
      const tight = !b.parent.loose;
      let taskHtml = '';
      const first = b.children[0];
      if (first && first.t === 'para' && first.lines.length > 0) {
        const m = /^\[( |x|X)\] /.exec(first.lines[0]);
        if (m) {
          first.lines[0] = first.lines[0].slice(4);
          taskHtml = '<input ' + (m[1] === ' ' ? '' : 'checked="" ') + 'disabled="" type="checkbox"> ';
        }
      }
      for (let ci = 0; ci < b.children.length; ci++) {
        const child = b.children[ci];
        if (child.t === 'para') {
          const r = renderParaLines(child.lines, refs);
          if (r.html === '') continue;
          if (r.isTable) { out.push(r.html); continue; }
          if (tight) out.push((ci === 0 ? taskHtml : '') + r.html);
          else out.push('<p>' + (ci === 0 ? taskHtml : '') + r.html + '</p>\n');
        } else {
          renderBlocks([child], refs, out);
        }
      }
      out.push('</li>\n');
    } else if (b.t === 'hr') {
      out.push('<hr>\n');
    }
  }
}

// ---------------------------------------------------------------- entry point

export function parse(src) {
  const doc = parseBlocks(src.replace(/\r\n?/g, '\n'));
  const refs = new Map();
  collectRefs(doc, refs);
  const out = [];
  renderBlocks(doc.children, refs, out);
  return out.join('');
}
