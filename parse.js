// parse.js — a fast, dependency-free drop-in for marked 18.1.3 (default
// options: GFM on, breaks off, pedantic off, async off).
//
// Written from scratch for the make.fun markdown-render-speed-02
// competition. The design is a two-pass renderer over one normalized
// string: pass one walks the document with the block grammar and builds a
// small tree of block nodes (link reference definitions are collected on
// the way, so a reference may be defined after its use, as in marked);
// pass two renders the tree to HTML, running the inline scanner over each
// text span. Inline rendering writes HTML straight into a string — there
// are no inline token objects — and the inline loop dispatches on the
// first character so plain text costs a single regex exec.
//
// The block and inline grammar patterns themselves are marked's published
// GFM grammar (they are the specification of its output); everything
// around them — the scanners, the tree, the rendering, the emphasis
// matcher — is original code in this file.
//
// No network, no cache across calls: parse() returns for a string exactly
// what that string alone renders to, and keeps nothing between calls.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// HTML-escape a string. With encodeAll, every one of & < > " ' is escaped
// (code spans, code blocks, autolink text and hrefs). Otherwise an & is
// only escaped when it does not start a character reference, so already
// valid entities survive.
function escHtml(s, encodeAll) {
  if (encodeAll) {
    return RX_ESC_TEST.test(s) ? s.replace(RX_ESC_REPLACE, (c) => ESC_MAP[c]) : s;
  }
  return RX_ESC_TEST_NOENC.test(s) ? s.replace(RX_ESC_REPLACE_NOENC, (c) => ESC_MAP[c]) : s;
}

// Decode numeric character references in a text chunk (and turn a bare &
// into &amp; when one is present). Only runs when the chunk holds a
// numeric reference at all.
function decodeEntities(s) {
  if (!RX_NUM_REF.test(s)) return s;
  return s.replace(RX_NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\uFFFD';
    return n === 38 ? '&amp;' : String.fromCodePoint(n);
  });
}

// Clean a link destination the way marked does: encodeURI, then unescape
// %25 back to %. Returns null when encodeURI throws (lone surrogates).
function cleanHref(s) {
  try {
    return encodeURI(s).replace(RX_PERCENT, '%');
  } catch {
    return null;
  }
}

// Normalize a link reference label: trim, collapse inner whitespace to
// single spaces, and fold case twice (the lower-upper-lower dance handles
// characters whose case folding is not idempotent).
function normLabel(s) {
  return s.trim().replace(RX_MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing bracket/paren that balances the opens in
// s. Backslash-escaped characters are skipped. Returns the index, -2 when
// an opener is left unclosed, or -1 when neither bracket occurs at all.
function findClose(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs in s to spaces, tracking the visual column from `col`.
// A tab jumps to the next multiple of four.
function expandTabs(s, col = 0) {
  let out = '';
  let c = col;
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += ' '.repeat(n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Strip trailing characters from s: while the last character equals `ch`
// (or, with invert, while it differs from `ch`).
function stripTail(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Drop trailing blank lines from a block of text, but only when there are
// at least two of them; a single trailing blank line is kept.
function stripBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && RX_BLANK_LINE.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Split one table row on unescaped pipes. Escaped pipes stay literal.
// Drops a leading and a trailing empty cell (the outer pipes), then pads
// or truncates to `ncols` when given, and trims each cell.
function splitRow(s, ncols) {
  const t = s.replace(RX_FIND_PIPE, (m, off, str) => {
    let esc = false;
    let p = off;
    for (; --p >= 0 && str[p] === '\\';) esc = !esc;
    return esc ? '|' : ' |';
  });
  const cells = t.split(RX_SPLIT_PIPE);
  if (cells[0].trim()) { /* keep */ } else cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (ncols) {
    if (cells.length > ncols) cells.splice(ncols);
    else for (; cells.length < ncols;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(RX_SLASH_PIPE, '|');
  return cells;
}

// Fenced code indent compensation: when the opening fence line was
// indented, strip that much leading whitespace from every content line.
function fenceAdjust(code, src) {
  const m = src.match(RX_FENCE_INDENT);
  if (m === null) return code;
  const pad = m[1];
  return code.split('\n').map((line) => {
    const lead = line.match(RX_BEGIN_SPACE);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, pad.length));
  }).join('\n');
}

// Does a link label contain an inline tag or autolink that runs past the
// label's end? `src` is the text from the label's `[` onward, `label` the
// label itself, `off` the offset of the label inside `src` (1 for a link,
// 2 for an image). Used to reject link matches whose label swallows markup.
function labelHasTag(src, label, off) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = GI_code.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(off + i);
    const m = GI_tag.exec(rest) || GI_autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// ---- small shared patterns (the "other" set) ----
const RX_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RX_OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const RX_FENCE_INDENT = /^(\s+)(?:```)/;
const RX_BEGIN_SPACE = /^\s+/;
const RX_END_HASH = /#$/;
const RX_START_SPACE = /^ /;
const RX_END_SPACE = / $/;
const RX_END_SPACE_TAB = /[ \t]$/;
const RX_NON_SPACE = /[^ ]/;
const RX_NEWLINE_G = /\n/g;
const RX_TAB_G = /\t/g;
const RX_LEAD_SPACE_TAB = /^[ \t]+/;
const RX_MULTI_SPACE = /\s+/g;
const RX_BLANK_LINE = /^[ \t]*$/;
const RX_BQ_START = /^ {0,3}>/;
const RX_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RX_BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const RX_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RX_LIST_NEST = /^ {1,4}(?=( {4})*[^ ])/g;
const RX_LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const RX_LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const RX_LIST_TASK_CB = /\[[ xX]\]/;
const RX_ANY_LINE = /\n.*\n/;
const RX_HREF_BRACKETS = /^<(.*)>$/;
const RX_TABLE_DELIM = /[:|]/;
const RX_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const RX_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RX_TABLE_ALIGN_R = /^ *-+: *$/;
const RX_TABLE_ALIGN_C = /^ *:-+: *$/;
const RX_TABLE_ALIGN_L = /^ *:-+ *$/;
const RX_START_A = /^<a /i;
const RX_END_A = /^<\/a>/i;
const RX_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RX_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RX_START_LT = /^</;
const RX_END_GT = />$/;
const RX_UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const RX_NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RX_NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RX_ESC_TEST = /[&<>"']/;
const RX_ESC_REPLACE = /[&<>"']/g;
const RX_ESC_TEST_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RX_ESC_REPLACE_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RX_PERCENT = /%25/g;
const RX_FIND_PIPE = /\|/g;
const RX_SPLIT_PIPE = / \|/;
const RX_SLASH_PIPE = /\\\|/g;
const RX_CR = /\r\n|\r/g;
const RX_SPACE_LINE = /^ +$/gm;
const RX_NOT_SPACE_START = /^\S*/;
const RX_END_NEWLINE = /\n$/;
const RX_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;

// The block-level HTML tag names (used by the html-block and list guards).
const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Indent-dependent line guards, memoized by indent (0..9 is all a list
// item ever asks for). Each tests one line, so they keep their ^ anchor.
const _guardCache = new Map();
function _guard(kind, n) {
  const key = kind + ':' + n;
  let re = _guardCache.get(key);
  if (re) return re;
  if (kind === 'item') re = new RegExp(`( {0,3}${n})((?:[ \t][^\\n]*)?(?:\\n|$))`, 'y');
  else {
    // The guards are memoized by a clamped index: the regex is built
    // with max(0, min(3, n - 1)), not with n itself. A nested construct
    // therefore needs one space less than the item's content indent to
    // count as starting a new block at this level.
    const a = Math.max(0, Math.min(3, n - 1));
    if (kind === 'bullet') re = new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
    else if (kind === 'hr') re = new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`);
    else if (kind === 'fence') re = new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`);
    else if (kind === 'head') re = new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`);
    else if (kind === 'html') re = new RegExp(`^ {0,${a}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
    else re = new RegExp(`^ {0,${a}}>`);
  }
  _guardCache.set(key, re);
  return re;
}
// --- grammar: marked 18.1.3 GFM block + inline patterns (exact) ---
const GB_blockquote = /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/;
const GB_code = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const GB_def = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const GB_fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const GB_heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const GB_hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const GB_html = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/i;
const GB_lheading = /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const GB_list = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const GB_newline = /^(?:[ \t]*(?:\n|$))+/;
const GB_paragraph = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/;
const GB_table = /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/;
const GB_text = /^[^\n]+/;
const GI__backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const GI_anyPunctuation = /\\([\p{P}\p{S}])/gu;
const GI_anyPunctuationOutsideCode = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const GI_autolink = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const GI_blockSkip = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const GI_br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const GI_code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const GI_del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const GI_delLDelim = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const GI_delRDelim = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const GI_emStrongLDelim = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const GI_emStrongRDelimAst = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const GI_emStrongRDelimUnd = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const GI_escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const GI_link = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const GI_nolink = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const GI_punctuation = /^((?![*_])[\s\p{P}\p{S}])/u;
const GI_reflink = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const GI_reflinkSearch = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const GI_tag = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const GI_text = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;
const GI_url = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;

// ---- inline engine ----
// The inline scanner renders a text span straight to HTML (or, in text
// mode, to the plain text an image alt attribute needs). It keeps one
// piece of shared state across a whole document — inLink, inRawBlock,
// linkEmitted, linkParenPossible — because marked's lexer does: a link
// opened in one paragraph can suppress links in the next, while a raw
// block (<pre> etc.) is reset before every top-level span.

// Mask a span for emphasis matching: link texts, code spans and inline
// HTML become runs of 'a' inside brackets, and backslash-escaped
// punctuation becomes '+', so a * or ~ inside them can never act as a
// delimiter. The mask is the same length as the source, so indices line
// up between the two.
function maskForEm(src, links) {
  // Fast path: the three masks below only touch brackets (links), code
  // spans and escapes, and '<...>' tags. A span holding none of '[',
  // '`', '<', '\' masks to itself.
  if (!src.includes('[') && !src.includes('`') && !src.includes('<') && !src.includes('\\')) return src;
  let t = src;
  if (links && src.includes('[')) {
    const re = GI_reflinkSearch;
    const fix = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(re, fix) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(re, fix);
  }
  t = t.replace(GI_anyPunctuationOutsideCode, (n, s, r) =>
    r ? '+'.repeat(n.length)
      : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s
      : n);
  t = t.replace(GI_blockSkip, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}

// Does a span contain a link (inline or reference) anywhere inside it?
// Used while masking, to decide whether a reference-style bracket pair
// hides a real link.
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(GI_blockSkip)) {
    if (GI_link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(GI_reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// Scan a masked span for the last position where each emphasis character
// could close: the start of a run of *, _ or ~ that is not preceded by a
// space, tab, newline, carriage return or form feed.
function scanClosers(masked) {
  const last = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === r;) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') last[r] = s;
    s = i - 1;
  }
  return last;
}

// Try to match an emphasis or strong emphasis run at the start of `rest`
// (the unmasked remainder, starting at absolute position `pos` in the
// masked span). Returns {len, inner, strong} or null.
function tryEmStrong(rest, masked, pos, closers, prevCh) {
  const s = GI_emStrongLDelim.exec(rest);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const wasPrevDelim = prevCh === r;
  const i = pos;
  let l = i;
  for (; l > 0 && masked[l - 1] === r;) l--;
  const before = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = before === '*' || before === '_' || !!RX_PUNCT.exec(before);
  let n = prevCh;
  if (l < i) n = before;
  const u = l < i ? h : !!RX_PUNCT.exec(n);
  if (s[4] && n.match(RX_UNICODE_ALNUM)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let m = k;
    let f = 0;
    const y = i - l + k;
    const canOpenStrong = !!before.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const delimRe = r === '*' ? GI_emStrongRDelimAst : GI_emStrongRDelimUnd;
    const v = closers[r];
    const q = i + k;
    if (v < q) return null;
    const tail = masked.slice(i + k);
    const ee = v - q;
    delimRe.lastIndex = 0;
    let m2;
    while ((m2 = delimRe.exec(tail)) !== null && !(m2.index > ee)) {
      const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!g) continue;
      const b = [...g].length;
      if (m2[3] || m2[4]) { m += b; continue; }
      if (m2[5] || m2[6] || canOpenStrong) {
        if (wasPrevDelim && (m2[5] || m2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      const blen = Math.min(b, b + m + f);
      const te = [...m2[0]][0].length;
      const raw = rest.slice(0, k + m2.index + te + blen);
      if (Math.min(k, blen) % 2) {
        return { len: raw.length, inner: raw.slice(1, -1), strong: false };
      }
      return { len: raw.length, inner: raw.slice(2, -2), strong: true };
    }
  }
  return null;
}

// Try to match a strikethrough run at the start of `rest`. Returns
// {len, inner} or null.
function tryDel(rest, masked, pos, closers, prevCh) {
  const s = GI_delLDelim.exec(rest);
  if (!s) return null;
  if (!(s[1] || '') || !prevCh || RX_PUNCT.exec(prevCh)) {
    const o = [...s[0]].length - 1;
    let p = o;
    const d = pos + o;
    const u = closers['~'];
    if (u < d) return null;
    const tail = masked.slice(pos + o);
    const k = u - d;
    GI_delRDelim.lastIndex = 0;
    let m;
    while ((m = GI_delRDelim.exec(tail)) !== null && !(m.index > k)) {
      const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!g) continue;
      const l = [...g].length;
      if (l !== o) continue;
      if (m[3] || m[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      const llen = Math.min(l, l + p);
      const g0 = [...m[0]][0].length;
      const raw = rest.slice(0, o + m.index + g0 + llen);
      return { len: raw.length, inner: raw.slice(o, -o) };
    }
  }
  return null;
}

// Finish a link or image once its destination and title are known: render
// the label (an image's label is rendered twice — once as HTML for the
// link-text state effects, once as plain text for the alt attribute),
// reject the link when a nested link was emitted inside its label, and
// build the HTML. Returns {html, len} or null when the link is rejected.
function finishLink(labelRaw, href, title, isImage, rawLen, links, st, mode) {
  const label = labelRaw.replace(RX_OUTPUT_LINK_REPLACE, '$1');
  const entryInLink = st.inLink;
  const entryRaw = st.inRawBlock;
  const entryEmitted = st.linkEmitted;
  const entryParen = st.linkParenPossible;
  st.inLink = true;
  st.linkEmitted = false;
  const innerHtml = renderInline(label, links, st, 0);
  const nested = st.linkEmitted;
  st.linkEmitted = entryEmitted;
  st.inLink = entryInLink;
  if (!isImage && nested) {
    st.inRawBlock = entryRaw;
    return null;
  }
  if (!isImage) st.linkEmitted = true;
  if (isImage) {
    const altState = { inLink: true, inRawBlock: entryRaw, linkEmitted: false, linkParenPossible: entryParen };
    const alt = renderInline(label, links, altState, 1);
    if (mode === 1) return { html: alt, len: rawLen };
    const cleaned = cleanHref(href);
    if (cleaned === null) return { html: escHtml(alt), len: rawLen };
    let img = '<img src="' + escHtml(cleaned) + '" alt="' + escHtml(alt) + '"';
    if (title) img += ' title="' + escHtml(title) + '"';
    return { html: img + '>', len: rawLen };
  }
  if (mode === 1) {
    const altState = { inLink: true, inRawBlock: entryRaw, linkEmitted: false, linkParenPossible: entryParen };
    return { html: renderInline(label, links, altState, 1), len: rawLen };
  }
  const cleaned = cleanHref(href);
  if (cleaned === null) return { html: innerHtml, len: rawLen };
  let a = '<a href="' + escHtml(cleaned) + '"';
  if (title) a += ' title="' + escHtml(title) + '"';
  return { html: a + '>' + innerHtml + '</a>', len: rawLen };
}

// Try an inline link [text](href "title") or image at the start of
// `rest`. Returns {html, len} or null.
function tryLink(rest, links, st, mode) {
  if (!st.linkParenPossible) return null;
  const m = GI_link.exec(rest);
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  const off = isImage ? 2 : 1;
  if (labelHasTag(rest, m[1], off)) return null;
  let hrefPart = m[2];
  let titlePart = m[3];
  let rawText = m[0];
  const s = hrefPart.trim();
  if (RX_START_LT.test(s)) {
    if (!RX_END_GT.test(s)) return null;
    const l = stripTail(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = findClose(hrefPart, '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (isImage ? 5 : 4) + m[1].length + l;
      hrefPart = hrefPart.substring(0, l);
      rawText = rawText.substring(0, h).trim();
      titlePart = '';
    }
  }
  const r = stripTail(rawText.slice(0, -1), '\\');
  if ((rawText.length - r.length) % 2 === 0) return null;
  let href = hrefPart.trim();
  let title = titlePart ? titlePart.slice(1, -1) : '';
  if (RX_START_LT.test(href)) href = href.slice(1, -1);
  href = href.replace(GI_anyPunctuation, '$1');
  title = title.replace(GI_anyPunctuation, '$1');
  return finishLink(m[1], href, title, isImage, rawText.length, links, st, mode);
}

// Try a reference link [text][ref] or shortcut [ref] at the start of
// `rest`. An undefined reference consumes only its first character as
// plain text. Returns {html, len} or {text, len} or null.
function tryReflink(rest, links, st, mode) {
  const m = GI_reflink.exec(rest) || GI_nolink.exec(rest);
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  const off = isImage ? 2 : 1;
  if (labelHasTag(rest, m[1], off)) return null;
  const def = links[normLabel(m[2] || m[1])];
  if (!def) return { text: m[0].charAt(0), len: 1 };
  return finishLink(m[1], def.href, def.title || '', isImage, m[0].length, links, st, mode);
}

// Render one inline span. mode 0 is HTML, mode 1 is plain text (image alt
// text). `st` is the shared document state; linkParenPossible is saved
// and restored around the call, the other flags are not.
function renderInline(src, links, st, mode) {
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  let masked = null;
  let closers = null;
  const getMasked = () => {
    if (masked === null) masked = maskForEm(src, links);
    return masked;
  };
  const getClosers = () => {
    if (closers === null) closers = scanClosers(getMasked());
    return closers;
  };
  let out = '';
  let pos = 0;
  let prevCh = '';
  let prevWasText = false;
  const len = src.length;
  try {
    while (pos < len) {
      if (!prevWasText) prevCh = '';
      prevWasText = false;
      const rest = src.slice(pos);
      const c = rest.charCodeAt(0);
      if (c === 92) { // backslash: escape, then hard break
        let m = GI_escape.exec(rest);
        if (m) {
          out += mode === 1 ? m[1] : escHtml(m[1]);
          pos += m[0].length;
          continue;
        }
        m = GI_br.exec(rest);
        if (m) {
          if (mode === 0) out += '<br>';
          pos += m[0].length;
          continue;
        }
      } else if (c === 60) { // <: tag, then autolink
        let m = GI_tag.exec(rest);
        if (m) {
          const tag = m[0];
          if (!st.inLink && RX_START_A.test(tag)) st.inLink = true;
          else if (st.inLink && RX_END_A.test(tag)) st.inLink = false;
          if (!st.inRawBlock && RX_START_PRE.test(tag)) st.inRawBlock = true;
          else if (st.inRawBlock && RX_END_PRE.test(tag)) st.inRawBlock = false;
          out += tag;
          pos += tag.length;
          continue;
        }
        m = GI_autolink.exec(rest);
        if (m) {
          const text = m[1];
          const href = m[2] === '@' ? 'mailto:' + text : text;
          if (mode === 1) {
            out += text;
          } else {
            const cleaned = cleanHref(href);
            out += cleaned === null
              ? escHtml(text, true)
              : '<a href="' + escHtml(cleaned, true) + '">' + escHtml(text, true) + '</a>';
          }
          pos += m[0].length;
          continue;
        }
      } else if (c === 91 || c === 33) { // [ or !: link, then reference link
        const hit = tryLink(rest, links, st, mode);
        if (hit) {
          out += hit.html;
          pos += hit.len;
          continue;
        }
        const ref = tryReflink(rest, links, st, mode);
        if (ref) {
          if (ref.text !== undefined) {
            out += mode === 1 ? ref.text : escHtml(decodeEntities(ref.text));
            if (ref.text.slice(-1) !== '_') prevCh = ref.text.slice(-1);
            prevWasText = true;
          } else {
            out += ref.html;
          }
          pos += ref.len;
          continue;
        }
      } else if (c === 42 || c === 95) { // * or _: emphasis (this char proves a delimiter is present)
        {
          const hit = tryEmStrong(rest, getMasked(), pos, getClosers(), prevCh);
          if (hit) {
            const inner = renderInline(hit.inner, links, st, mode);
            out += mode === 1 ? inner : (hit.strong ? '<strong>' + inner + '</strong>' : '<em>' + inner + '</em>');
            pos += hit.len;
            continue;
          }
        }
      } else if (c === 96) { // backtick: code span
        const m = GI_code.exec(rest);
        if (m) {
          let text = m[2].replace(RX_NEWLINE_G, ' ');
          if (RX_NON_SPACE.test(text) && RX_START_SPACE.test(text) && RX_END_SPACE.test(text)) {
            text = text.substring(1, text.length - 1);
          }
          out += mode === 1 ? text : '<code>' + escHtml(text, true) + '</code>';
          pos += m[0].length;
          continue;
        }
      } else if (c === 126) { // ~: strikethrough (this char proves a ~ is present)
        {
          const hit = tryDel(rest, getMasked(), pos, getClosers(), prevCh);
          if (hit) {
            const inner = renderInline(hit.inner, links, st, mode);
            out += mode === 1 ? inner : '<del>' + inner + '</del>';
            pos += hit.len;
            continue;
          }
        }
      } else if (c === 32) { // space: hard break
        const m = GI_br.exec(rest);
        if (m) {
          if (mode === 0) out += '<br>';
          pos += m[0].length;
          continue;
        }
      } else if (
        (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
        c === 46 || c === 95 || c === 43 || c === 45
      ) { // possible extended autolink (www., http://, email)
        if (!st.inLink) {
          const m = GI_url.exec(rest);
          if (m) {
            let raw = m[0];
            let href;
            let text;
            if (m[2] === '@') {
              text = raw;
              href = 'mailto:' + raw;
            } else {
              let prev;
              do {
                prev = raw;
                raw = GI__backpedal.exec(raw)?.[0] ?? '';
              } while (prev !== raw);
              text = raw;
              href = m[1] === 'www.' ? 'http://' + raw : raw;
            }
            if (mode === 1) {
              out += text;
            } else {
              const cleaned = cleanHref(href);
              out += cleaned === null
                ? escHtml(text, true)
                : '<a href="' + escHtml(cleaned, true) + '">' + escHtml(text, true) + '</a>';
            }
            pos += raw.length;
            continue;
          }
        }
      }
      // Plain text: one maximal chunk up to the next construct.
      const m = GI_text.exec(rest);
      if (!m) throw new Error('Infinite loop on byte: ' + c);
      const chunk = m[0];
      out += st.inRawBlock ? chunk : (mode === 1 ? decodeEntities(chunk) : escHtml(decodeEntities(chunk)));
      if (chunk.slice(-1) !== '_') prevCh = chunk.slice(-1);
      prevWasText = true;
      pos += chunk.length;
    }
  } finally {
    st.linkParenPossible = savedParen;
  }
  return out;
}

// Render one span the way a top-level block does: a raw block opened by
// an earlier span does not carry over.
function renderInlineTop(src, links, st, mode) {
  st.inRawBlock = false;
  return renderInline(src, links, st, mode);
}

// ---- block engine ----
// Block nodes are small objects {k, raw, ...}. `links` collects reference
// definitions as they are found, so a reference may be defined after its
// use. lexBlocks walks one string; `inQuote` lets a paragraph merge with
// the previous paragraph token (blockquotes are lexed chunk by chunk), and
// `top` allows paragraph tokens at all (list items are lexed with top
// false, so their first text is a bare text node instead).

function tryBlockquote(src, links) {
  const m = GB_blockquote.exec(src);
  if (!m) return null;
  let lines = stripTail(m[0], '\n').split('\n');
  let s = '';
  let r = '';
  const nodes = [];
  while (lines.length > 0) {
    let seen = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (RX_BQ_START.test(lines[p])) { chunk.push(lines[p]); seen = true; }
      else if (!seen) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h
      .replace(RX_BQ_MARKER_WS, (g, b, m2) => b + expandTabs(m2, b.length))
      .replace(RX_BQ_SETEXT, '\n    $1')
      .replace(RX_BQ_SETEXT2, '');
    s = s ? s + '\n' + h : h;
    r = r ? r + '\n' + u : u;
    lexBlocks(u, links, nodes, true, true);
    if (lines.length === 0) break;
    const k = nodes[nodes.length - 1];
    if (k && (k.k === 'code' || k.k === 'heading' || k.k === 'hr' || k.k === 'html' || k.k === 'table')) break;
    if (k && k.k === 'blockquote') {
      const g = k;
      const b = lines.join('\n');
      const str = g.raw + '\n' + b.replace(RX_BQ_SETEXT2, '');
      const f = tryBlockquote(str, links);
      if (!f) break;
      nodes[nodes.length - 1] = f.node;
      const y = str.substring(f.node.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) s = s + '\n' + A.join('\n');
      r = r.substring(0, r.length - g.text.length) + f.node.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && RX_BQ_START.test(lines[0])) continue;
      break;
    } else if (k && k.k === 'list') {
      const g = k;
      const b = g.raw + '\n' + lines.join('\n');
      const mm = tryList(b, links);
      if (!mm) break;
      nodes[nodes.length - 1] = mm.node;
      const f = mm.node.raw.length > g.raw.length
        ? b.slice(g.raw.length + 1, mm.node.raw.length).split('\n').length
        : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        s = s + '\n' + y;
        r = r + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { node: { k: 'blockquote', raw: s, text: r, nodes }, consumed: s.length };
}

// True when some line of `rest` before the first blank line is a setext
// underline (0-3 spaces, then a run of '=' or '-', then spaces/tabs).
// A necessary condition for a setext heading; the real grammar regex
// decides. Scans line by line with indexOf, so it costs O(paragraph),
// not O(remainder) like a regex scan of the whole rest.
function hasSetextUnderline(rest) {
  let pos = 0;
  for (;;) {
    const nl = rest.indexOf('\n', pos);
    const end = nl === -1 ? rest.length : nl;
    let j = pos;
    let spaces = 0;
    while (j < end && rest[j] === ' ' && spaces < 3) { j++; spaces++; }
    if (j >= end) return false; // blank line (all spaces, or empty)
    const c = rest[j];
    if (c === '=' || c === '-') {
      let k = j + 1;
      while (k < end && (rest[k] === c || rest[k] === ' ' || rest[k] === '\t')) k++;
      if (k === end) return true;
    } else {
      let k = j;
      while (k < end && (rest[k] === ' ' || rest[k] === '\t')) k++;
      if (k === end) return false; // blank line
    }
    if (nl === -1) return false;
    pos = nl + 1;
  }
}

// The first line of `s` at or after `pos`, without allocating a slice of
// the whole remainder (indexOf scans natively; the line itself is the
// only new string).
function lineAt(s, pos) {
  const nl = s.indexOf('\n', pos);
  return nl === -1 ? s.slice(pos) : s.slice(pos, nl);
}

// True when `s` ends with a blank line: two '\n's with only spaces or
// tabs between them, then only spaces or tabs to the end. Same test as
// /\n[ \t]*\n[ \t]*$/ without the regex.
function endsWithBlankLine(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  let j = i - 1;
  while (j > 0 && (s[j - 1] === ' ' || s[j - 1] === '\t')) j--;
  return j > 0 && s[j - 1] === '\n';
}

function tryList(src, links) {
  const t = GB_list.exec(src);
  if (!t) return null;
  const full = src;
  let pos = 0;
  const marker = t[1].trim();
  const ordered = marker.length > 1;
  const list = {
    k: 'list', raw: '', ordered,
    start: ordered ? +marker.slice(0, -1) : '',
    loose: false, items: [],
  };
  const markerRe = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
  const itemRe = _guard('item', markerRe);
  let prevHadBlank = false;
  while (pos < full.length) {
    let blankItem = false;
    let d = '';
    const line0 = lineAt(full, pos);
    itemRe.lastIndex = pos;
    const m2 = itemRe.exec(full);
    if (!m2 || GB_hr.test(line0)) break;
    const itemStart = pos;
    pos += m2[0].length;
    const firstLine = m2[2].endsWith('\n') ? m2[2].slice(0, -1) : m2[2];
    const markerLen = m2[1].length;
    const content = firstLine.replace(RX_LEAD_SPACE_TAB, (v) => expandTabs(v, markerLen));
    const nextLine = lineAt(full, pos);
    let isBlank = !content.trim();
    let indent = 0;
    if (isBlank) {
      indent = markerLen + 1;
    } else {
      indent = content.search(RX_NON_SPACE);
      indent = indent > 4 ? 1 : indent;
      d = content.slice(indent);
      indent += markerLen;
    }
    if (isBlank && RX_BLANK_LINE.test(nextLine)) {
      pos += nextLine.length + 1;
      blankItem = true;
    }
    if (!blankItem) {
      const bulletRe = _guard('bullet', indent);
      const hrRe = _guard('hr', indent);
      const fenceRe = _guard('fence', indent);
      const headRe = _guard('head', indent);
      const htmlRe = _guard('html', indent);
      const bqRe = _guard('bq', indent);
      // The guards allow at most this many leading spaces (the same
      // clamp _guard uses: max(0, min(3, indent - 1))).
      const guardA = Math.max(0, Math.min(3, indent - 1));
      let cur = content;
      while (pos < full.length) {
        const line = lineAt(full, pos);
        const f = line;
        // Leading spaces and the first non-space char: a guard regex can
        // only match when the marker starts within guardA spaces, so most
        // lines skip the regex tests entirely.
        let lead = 0;
        while (lead < f.length && f.charCodeAt(lead) === 32) lead++;
        const fc = lead < f.length ? f.charCodeAt(lead) : -1;
        const z = (f.charCodeAt(0) === 32 || f.charCodeAt(0) === 9)
          ? f.replace(RX_LEAD_SPACE_TAB, (v) => expandTabs(v)) : f;
        let guardHit = false;
        if (lead <= guardA) {
          if (fc === 96 || fc === 126) guardHit = fenceRe.test(f);
          else if (fc === 35) guardHit = headRe.test(f);
          else if (fc === 60) guardHit = htmlRe.test(f);
          else if (fc === 62) guardHit = bqRe.test(f);
          else if (fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) guardHit = bulletRe.test(f) || hrRe.test(f);
          else if (fc === 95) guardHit = hrRe.test(f);
        }
        if (guardHit) break;
        if (z.search(RX_NON_SPACE) >= indent || !f.trim()) {
          d += '\n' + z.slice(indent);
        } else {
          if (isBlank || cur.replace(RX_TAB_G, '    ').search(RX_NON_SPACE) >= 4 ||
              fenceRe.test(cur) || headRe.test(cur) || htmlRe.test(cur) || hrRe.test(cur)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && GB_lheading.test(cur + '\n' + f)
            ? '    ' + z.replace(/^ {0,3}/, '') : f;
          d += '\n' + qe;
        }
        isBlank = !f.trim();
        pos += line.length + 1;
        cur = z.slice(indent);
      }
    }
    const itemRaw = full.slice(itemStart, pos);
    if (!list.loose) {
      if (prevHadBlank) list.loose = true;
      else if (endsWithBlankLine(itemRaw)) prevHadBlank = true;
    }
    list.items.push({
      k: 'list_item', raw: itemRaw,
      task: RX_LIST_IS_TASK.test(d),
      loose: false, text: d, nodes: [],
    });
  }
  const last = list.items[list.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = full.slice(0, pos).trimEnd();
  for (const item of list.items) {
    lexBlocks(item.text, links, item.nodes, false, false);
    if (!list.loose) {
      const spaces = item.nodes.filter((x) => x.k === 'space');
      if (spaces.length > 0 && spaces.some((x) => RX_ANY_LINE.test(x.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.nodes[0];
    if (item.task && first && (first.k === 'text' || first.k === 'paragraph')) {
      item.text = item.text.replace(RX_LIST_REPLACE_TASK, '');
      first.raw = first.raw.replace(RX_LIST_REPLACE_TASK, '');
      first.text = first.text.replace(RX_LIST_REPLACE_TASK, '');
      const cb = RX_LIST_TASK_CB.exec(item.raw);
      if (cb) item.checked = cb[0] !== '[ ]';
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const node of item.nodes) if (node.k === 'text') node.k = 'paragraph';
    }
  }
  return { node: list, consumed: list.raw.length };
}

function tryTable(rest) {
  const m = GB_table.exec(rest);
  if (!m || !RX_TABLE_DELIM.test(m[2])) return null;
  const headerCells = splitRow(m[1]);
  const delimCells = m[2].replace(RX_TABLE_ALIGN_CHARS, '').split('|');
  const bodyRows = m[3]?.trim() ? m[3].replace(RX_TABLE_ROW_BLANK, '').split('\n') : [];
  const table = { k: 'table', raw: stripTail(m[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length !== delimCells.length) return null;
  for (const d of delimCells) {
    if (RX_TABLE_ALIGN_R.test(d)) table.align.push('right');
    else if (RX_TABLE_ALIGN_C.test(d)) table.align.push('center');
    else if (RX_TABLE_ALIGN_L.test(d)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], align: table.align[i] });
  }
  for (const row of bodyRows) {
    table.rows.push(splitRow(row, headerCells.length).map((text, i) => ({ text, align: table.align[i] })));
  }
  return { node: table, consumed: table.raw.length };
}

// The block loop: tries each block kind in marked's order, advancing by
// the token's raw length (a raw is often shorter than its regex match —
// trailing newlines and blank lines stay in the input for the next
// token). Paragraph and text tokens merge with a preceding one of the
// same kind; indented code and link definitions are absorbed into a
// preceding paragraph instead of starting a new block.
//
// Before each grammar regex runs, a cheap first-character guard (and, for
// tables and setext headings, a look at the following line) skips the
// patterns that cannot match here. Every guard is a necessary condition
// of its pattern, so skipping is exact.
function lexBlocks(src, links, out, inQuote, top) {
  let pos = 0;
  let n = inQuote;
  let guard = Infinity;
  while (pos < src.length) {
    if (src.length - pos >= guard) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    guard = src.length - pos;
    const rest = src.slice(pos);
    const c0 = rest.charCodeAt(0);
    const indented = c0 === 32 || c0 === 9; // space or tab
    let m;
    let node;
    if ((c0 === 32 || c0 === 9 || c0 === 10) && (m = GB_newline.exec(rest)) && m[0].length > 0) {
      pos += m[0].length;
      const prev = out[out.length - 1];
      if (m[0].length === 1 && prev !== undefined) prev.raw += '\n';
      else out.push({ k: 'space', raw: m[0] });
      continue;
    }
    if (indented && (m = GB_code.exec(rest))) {
      const raw = stripBlankTail(m[0]);
      const text = raw.replace(RX_CODE_REMOVE_INDENT, '');
      pos += raw.length;
      const prev = out[out.length - 1];
      if (prev && (prev.k === 'paragraph' || prev.k === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + text;
      } else {
        out.push({ k: 'code', raw, lang: undefined, text });
      }
      continue;
    }
    if ((indented || c0 === 96 || c0 === 126) && (m = GB_fences.exec(rest))) {
      pos += m[0].length;
      const lang = m[2] ? m[2].trim().replace(GI_anyPunctuation, '$1') : m[2];
      out.push({ k: 'code', raw: m[0], lang, text: fenceAdjust(m[3] || '', m[0]) });
      continue;
    }
    if ((indented || c0 === 35) && (m = GB_heading.exec(rest))) {
      let text = m[2].trim();
      if (RX_END_HASH.test(text)) {
        const stripped = stripTail(text, '#');
        if (!stripped || RX_END_SPACE_TAB.test(stripped)) text = stripped.trim();
      }
      const raw = stripTail(m[0], '\n');
      pos += raw.length;
      out.push({ k: 'heading', raw, depth: m[1].length, text });
      continue;
    }
    if ((indented || c0 === 45 || c0 === 95 || c0 === 42) && (m = GB_hr.exec(rest))) {
      const raw = stripTail(m[0], '\n');
      pos += raw.length;
      out.push({ k: 'hr', raw });
      continue;
    }
    if ((indented || c0 === 62) && (node = tryBlockquote(rest, links))) {
      pos += node.consumed;
      out.push(node.node);
      continue;
    }
    if ((indented || c0 === 45 || c0 === 43 || c0 === 42 || (c0 >= 48 && c0 <= 57)) && (node = tryList(rest, links))) {
      pos += node.consumed;
      out.push(node.node);
      continue;
    }
    if ((indented || c0 === 60) && (m = GB_html.exec(rest))) {
      const text = stripBlankTail(m[0]);
      pos += text.length;
      out.push({ k: 'html', raw: text, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text });
      continue;
    }
    if ((indented || c0 === 91) && (m = GB_def.exec(rest)) && (RX_START_LT.test(m[2]) || findClose(m[2], '()') === -1)) {
      const raw = stripTail(m[0], '\n');
      pos += raw.length;
      const tag = normLabel(m[1]);
      const href = m[2] ? m[2].replace(RX_HREF_BRACKETS, '$1').replace(GI_anyPunctuation, '$1') : '';
      const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(GI_anyPunctuation, '$1') : m[3];
      const prev = out[out.length - 1];
      if (prev && (prev.k === 'paragraph' || prev.k === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + raw;
      } else {
        if (!links[tag]) links[tag] = { href, title };
        out.push({ k: 'def', raw, tag, href, title });
      }
      continue;
    }
    // Table: the delimiter row must be the second line and must contain a
    // '-' run plus a '|' or ':' (the tokenizer rejects a bare '---' row).
    // Setext heading: an underline line must exist before the first blank
    // line (hasSetextUnderline); the real regex decides.
    {
      const nl1 = rest.indexOf('\n');
      if (nl1 !== -1) {
        const nl2 = rest.indexOf('\n', nl1 + 1);
        const second = rest.slice(nl1 + 1, nl2 === -1 ? rest.length : nl2);
        if (second.includes('-') && (second.includes('|') || second.includes(':'))) {
          node = tryTable(rest);
          if (node) {
            pos += node.consumed;
            out.push(node.node);
            continue;
          }
        }
      }
    }
    if (hasSetextUnderline(rest) && (m = GB_lheading.exec(rest))) {
      const raw = stripTail(m[0], '\n');
      pos += raw.length;
      out.push({ k: 'heading', raw, depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() });
      continue;
    }
    if (top && (m = GB_paragraph.exec(rest))) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      pos += m[0].length;
      const prev = out[out.length - 1];
      if (n && prev && prev.k === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + m[0];
        prev.text += '\n' + text;
      } else {
        out.push({ k: 'paragraph', raw: m[0], text });
      }
      n = false;
      continue;
    }
    if ((m = GB_text.exec(rest))) {
      pos += m[0].length;
      const prev = out[out.length - 1];
      if (prev && prev.k === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + m[0];
        prev.text += '\n' + m[0];
      } else {
        out.push({ k: 'text', raw: m[0], text: m[0] });
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  return out;
}

// ---- renderer ----

function renderTableCell(cell, isHeader, links, st) {
  const tag = isHeader ? 'th' : 'td';
  const inner = renderInlineTop(cell.text, links, st, 0);
  return (cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>') +
    inner + '</' + tag + '>\n';
}

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderListItem(item, list, links, st) {
  let inner = '';
  if (item.task && item.checked !== undefined) {
    const box = checkboxHtml(item.checked);
    if (list.loose) {
      const first = item.nodes[0];
      if (first && (first.k === 'paragraph' || first.k === 'text')) {
        inner += first.k === 'paragraph'
          ? '<p>' + box + renderInlineTop(first.text, links, st, 0) + '</p>\n'
          : box + renderInlineTop(first.text, links, st, 0);
        for (let i = 1; i < item.nodes.length; i++) inner += renderBlocks([item.nodes[i]], links, st);
      } else {
        inner += '<p>' + box + '</p>\n';
        inner += renderBlocks(item.nodes, links, st);
      }
    } else {
      inner += box;
      inner += renderBlocks(item.nodes, links, st);
    }
  } else {
    inner += renderBlocks(item.nodes, links, st);
  }
  return '<li>' + inner + '</li>\n';
}

function renderBlocks(nodes, links, st) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 'space':
        break;
      case 'code': {
        const lang = (node.lang || '').match(RX_NOT_SPACE_START)?.[0] ?? '';
        const text = node.text ? node.text.replace(RX_END_NEWLINE, '') + '\n' : '';
        out += lang
          ? '<pre><code class="language-' + escHtml(lang) + '">' + escHtml(text, true) + '</code></pre>\n'
          : '<pre><code>' + escHtml(text, true) + '</code></pre>\n';
        break;
      }
      case 'heading':
        out += '<h' + node.depth + '>' + renderInlineTop(node.text, links, st, 0) + '</h' + node.depth + '>\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(node.nodes, links, st) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul';
        const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
        let items = '';
        for (const item of node.items) items += renderListItem(item, node, links, st);
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'html':
        out += node.text;
        break;
      case 'def':
        break;
      case 'table': {
        let head = '';
        for (const cell of node.header) head += renderTableCell(cell, true, links, st);
        let body = '';
        for (const row of node.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell, false, links, st);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' +
          (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
        break;
      }
      case 'paragraph':
        out += '<p>' + renderInlineTop(node.text, links, st, 0) + '</p>\n';
        break;
      case 'text':
        out += renderInlineTop(node.text, links, st, 0);
        break;
      case 'checkbox':
        out += checkboxHtml(node.checked);
        break;
      default:
        throw new Error('Token with "' + node.k + '" type was not found.');
    }
  }
  return out;
}

// The entry point: exactly marked 18.1.3's parse with its defaults, for
// one string at a time. Nothing is kept between calls.
export function parse(markdown) {
  const src = markdown.replace(RX_CR, '\n');
  const links = Object.create(null);
  const nodes = [];
  lexBlocks(src, links, nodes, false, true);
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  return renderBlocks(nodes, links, st);
}
