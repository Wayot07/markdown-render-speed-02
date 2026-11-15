// parse.js — a fast drop-in replacement for marked 18.1.3 (default options:
// GFM on, breaks off, pedantic off, async off).
//
// Written from scratch for the make.fun markdown-render-speed-02 competition.
// It renders exactly the HTML marked 18.1.3 renders (CommonMark 0.31.2 + GFM
// 0.29, including marked's own quirks), but with a different, faster engine:
// index-based scanning with sticky regexes (no per-token substring churn),
// a hand-written inline text scanner, and direct HTML rendering with no
// intermediate inline token objects. The block grammar regexes below are the
// same grammar marked defines (they are the specification of its output);
// the parsing, scanning and rendering machinery around them is original.
//
// No network, no cache across cases: parse() is a pure function of its input.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// ---------------------------------------------------------------------------
// Helpers (same observable behaviour as marked's helpers)
// ---------------------------------------------------------------------------

function escEncode(s) {
  // escapeHtmlEntities(s, true): escape & < > " '
  if (!/[&<>"']/.test(s)) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const r = ESCAPES[s[i]];
    if (r !== undefined) { out += s.slice(start, i) + r; start = i + 1; }
  }
  return out + s.slice(start);
}

function escNoEncode(s) {
  // escapeHtmlEntities(s): escape < > " ' and & only when it cannot start a
  // valid character/entity reference.
  if (!/[<>"']/.test(s) && s.indexOf('&') === -1) return s;
  return s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (ch) => ESCAPES[ch]);
}

const NUM_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericRefs(text) {
  if (!NUM_REF_TEST.test(text)) return text;
  return text.replace(NUM_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Remove trailing 'c's (or, with invert, trailing non-'c's). Equivalent to
// str.replace(/c*$/, '') but without the REDOS exposure.
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const ch = str.charAt(l - suffLen - 1);
    if (ch === c && !invert) suffLen++;
    else if (ch !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

const BLANK_LINE = /^[ \t]*$/;
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && BLANK_LINE.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Grammar: the same regexes marked builds in rules.ts (the grammar is the
// specification of its output). Built here with the same `edit` composer so
// the resulting patterns are identical, then converted to sticky form where
// the hot loops need them.
// ---------------------------------------------------------------------------

function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const caret = /(^|[^\[])\^/g;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(caret, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

const supportsLookbehind = (() => {
  try { return !!new RegExp('(?<=1)(?<!1)'); } catch { return false; }
})();

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  pedanticHeadingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#`)),
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// ---- Block grammar (GFM) ----
const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const blockCodeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fencesRe = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hrRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const headingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bulletRe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheadingRe = edit(lheadingCore)
  .replace(/bull/g, bulletRe)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const paragraphCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const gfmTableRe = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG)
  .getRegex();
const paragraphRe = edit(paragraphCore)
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', gfmTableRe)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG)
  .getRegex();
const blockquoteParagraphRe = edit(paragraphCore)
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG)
  .getRegex();
const blockquoteRe = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraphRe)
  .getRegex();
const blockLabelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const defRe = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', blockLabelRe)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
const listRe = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bulletRe)
  .getRegex();
const htmlBlockRe = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', COMMENT)
  .replace('tag', TAG)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();
const blockTextRe = /^[^\n]+/;

// ---- Inline grammar (GFM) ----
const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCodeRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;
const punctuationRe = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, PUNCT_SPACE).getRegex();
const blockSkipRe = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();
const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelimRe = edit(emStrongLDelimCore, 'u')
  .replace(/punct/g, PUNCT_GFM)
  .getRegex();
const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const emStrongRDelimAstRe = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_GFM)
  .replace(/punctSpace/g, PUNCT_SPACE_GFM)
  .replace(/punct/g, PUNCT_GFM)
  .getRegex();
const emStrongRDelimUndRe = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
const delLDelimRe = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .getRegex();
const delRDelimRe = edit(
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
const anyPunctuationRe = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .getRegex();
const anyPunctuationOutsideCodeRe = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .getRegex();
const autolinkRe = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();
const inlineCommentRe = edit(COMMENT).replace('(?:-->|$)', '-->').getRegex();
const tagRe = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', inlineCommentRe)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();
const inlineLabelBracketsRe = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const inlineLabelRe = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', inlineLabelBracketsRe)
  .getRegex();
const linkRe = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', inlineLabelRe)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const reflinkRe = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', inlineLabelRe)
  .replace('ref', blockLabelRe)
  .getRegex();
const nolinkRe = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', blockLabelRe)
  .getRegex();
const boundedBlockLabelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const boundedInlineLabelRe = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', inlineLabelBracketsRe)
  .getRegex();
const reflinkSearchRe = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', boundedInlineLabelRe)
    .replace('ref', boundedBlockLabelRe)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', boundedBlockLabelRe)
    .getRegex())
  .getRegex();
const caseInsensitiveProtocolRe = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const extendedEmailRe = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const extendedEmailProtocolRe = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, extendedEmailRe)
  .getRegex();
const urlRe = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', extendedEmailProtocolRe)
  .replace('protocol', caseInsensitiveProtocolRe)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const delRe = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Sticky versions of the anchored regexes used in the hot loops: they match
// exactly at a position instead of on a fresh substring, so the loops never
// copy the remaining input.
function sticky(re) {
  const src = re.source.replace(/(^|[(|])\^/g, '$1');
  const flags = re.flags.replace('g', '') + 'y';
  return new RegExp(src, flags);
}
function execAt(re, str, pos) {
  re.lastIndex = pos;
  const m = re.exec(str);
  return m;
}

const S = {
  newline: sticky(newlineRe),
  blockCode: sticky(blockCodeRe),
  fences: sticky(fencesRe),
  hr: sticky(hrRe),
  heading: sticky(headingRe),
  blockquote: sticky(blockquoteRe),
  list: sticky(listRe),
  html: sticky(htmlBlockRe),
  def: sticky(defRe),
  table: sticky(gfmTableRe),
  lheading: sticky(lheadingRe),
  paragraph: sticky(paragraphRe),
  text: sticky(blockTextRe),
  escape: sticky(escapeRe),
  tag: sticky(tagRe),
  link: sticky(linkRe),
  reflink: sticky(reflinkRe),
  nolink: sticky(nolinkRe),
  emStrongLDelim: sticky(emStrongLDelimRe),
  code: sticky(inlineCodeRe),
  br: sticky(brRe),
  del: sticky(delRe),
  delLDelim: sticky(delLDelimRe),
  autolink: sticky(autolinkRe),
  url: sticky(urlRe),
};

// ---------------------------------------------------------------------------
// Inline rendering (direct to HTML; no intermediate inline token objects)
// ---------------------------------------------------------------------------

function isAlnum(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// UTF-16 length of the first / last code point of s (1 or 2 units), and
// the last code point itself — the spread-based `[...s]` counts this but
// allocates an array per call, which is pure overhead in the hot paths.
function firstCpLen(s) {
  const c = s.charCodeAt(0);
  return c >= 0xD800 && c <= 0xDBFF && s.length > 1 ? 2 : 1;
}
function lastCpLen(s) {
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xDC00 && c <= 0xDFFF && s.length >= 2 ? 2 : 1;
}
function lastCp(s) {
  if (s.length === 0) return '';
  return lastCpLen(s) === 2 ? s.slice(-2) : s.slice(-1);
}

// ASCII lookup tables for the hot text scanner.
const ALNUM_TBL = new Uint8Array(128);
const EMAIL_TBL = new Uint8Array(128);
for (let c = 48; c <= 57; c++) { ALNUM_TBL[c] = 1; EMAIL_TBL[c] = 1; }
for (let c = 65; c <= 90; c++) { ALNUM_TBL[c] = 1; EMAIL_TBL[c] = 1; }
for (let c = 97; c <= 122; c++) { ALNUM_TBL[c] = 1; EMAIL_TBL[c] = 1; }
for (const ch of ".!#$%&'*+/=?_`{|}~-") EMAIL_TBL[ch.charCodeAt(0)] = 1;

function isAlnumCode(code) { return code < 128 && ALNUM_TBL[code] === 1; }
function isEmailCharCode(code) { return code < 128 && EMAIL_TBL[code] === 1; }

// First character of an extended autolink (marked's url rule): a letter
// (scheme, www., mailto:/xmpp:), or a digit, '.', '_', '+' or '-' (the
// email local part). Anything else can never start a URL.
function isUrlStartCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 46 || code === 95 || code === 43 || code === 45;
}

function isEmailChar(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return isEmailCharCode(c);
}

// Does src[i..] match [email-chars]+@ ?
function emailLocalAt(src, i) {
  let j = i;
  while (j < src.length && isEmailCharCode(src.charCodeAt(j))) j++;
  return j > i && src.charCodeAt(j) === 64;
}

function protocolAt(src, i) {
  // http://, https://, ftp:// — case-insensitive, without allocating.
  const lower = (c) => c | 32;
  if (lower(src.charCodeAt(i)) === 104 && lower(src.charCodeAt(i + 1)) === 116
    && lower(src.charCodeAt(i + 2)) === 116 && lower(src.charCodeAt(i + 3)) === 112) {
    const e = lower(src.charCodeAt(i + 4));
    if (e === 115) return src.charCodeAt(i + 5) === 58 && src.charCodeAt(i + 6) === 47 && src.charCodeAt(i + 7) === 47;
    return e === 58 && src.charCodeAt(i + 5) === 47 && src.charCodeAt(i + 6) === 47;
  }
  if (lower(src.charCodeAt(i)) === 102 && lower(src.charCodeAt(i + 1)) === 116
    && lower(src.charCodeAt(i + 2)) === 112) {
    return src.charCodeAt(i + 3) === 58 && src.charCodeAt(i + 4) === 47 && src.charCodeAt(i + 5) === 47;
  }
  return false;
}

function mailtoAt(src, i) {
  return src.startsWith('mailto:', i) || src.startsWith('xmpp:', i);
}

function spaceRunBreak(src, i) {
  if (src[i] !== ' ') return false;
  let j = i;
  while (src[j] === ' ') j++;
  return j - i >= 2 && src[j] === '\n';
}

const WWW_PREV = ' \t\n\r\f\v*_~(';

// One regex finds the next place the text run must stop, other than an
// email start: a construct opener, a protocol, www., a mailto:/xmpp: start,
// or a hard-break space run. Alternatives are in the same order the lazy
// scan checks them, so the leftmost match is the stop — except a mailto:
// or space run starting exactly where the scan starts is not a stop (the
// scan is already past the character that would have to precede it), so
// those are skipped and the search resumes just past them. The www stop
// additionally needs its preceding character in WWW_PREV. Email starts are
// handled separately (below): the regex engine rescans every word for '@',
// while a native indexOf finds the next '@' directly.
const TEXT_STOP_RE = /[\\<\[`*~_!]|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|www\.|mailto:|xmpp:| {2,}\n/g;

// Start of the first [email-chars]+@ run after `start` (the stop position
// for the text scan), or -1. The run must start after `start`: an email
// starting at the scan position itself is not a stop.
function nextEmailStart(src, start) {
  let at = src.indexOf('@', start);
  while (at !== -1) {
    let e = at;
    while (e > 0 && isEmailCharCode(src.charCodeAt(e - 1))) e--;
    if (e < at && e > start) return e;
    at = src.indexOf('@', at + 1);
  }
  return -1;
}

// Hand-written equivalent of marked's GFM inline-text regex: scans the text
// run starting at pos and returns its end index. The first character is
// always consumed (backtick/tilde runs whole), then the scan stops exactly
// where the regex would: before a construct opener, a protocol/www/email
// start, or a hard-break run of spaces. The preamble handles the run start
// (where the first character is always consumed); the lazy scan is one
// native regex search for the next stop.
function scanText(src, pos) {
  const len = src.length;
  let i = pos;
  const c0 = src.charCodeAt(i);
  // Alternative A: one non-alphanumeric char before mailto:/xmpp:
  if (!isAlnumCode(c0) && mailtoAt(src, i + 1)) return i + 1;
  // First char (B): a backtick run, a tilde run, or one character.
  if (c0 === 96) { while (i < len && src.charCodeAt(i) === 96) i++; }
  else if (c0 === 126) { while (i < len && src.charCodeAt(i) === 126) i++; }
  else i++;
  if (i >= len) return i;
  let c = src.charCodeAt(i);
  // C/D/E: stop right after the first char when the next char opens a code
  // span / tilde run, starts a hard break, or starts an email address.
  if (c === 96 || c === 126) return i;
  if (c === 32 && spaceRunBreak(src, i)) return i;
  if (isEmailCharCode(c) && emailLocalAt(src, i)) return i;
  // Lazy scan (F): the regex finds the next non-email stop, the email stop
  // comes from nextEmailStart; the run ends at whichever comes first.
  let start = i;
  let emailStop = nextEmailStart(src, start);
  TEXT_STOP_RE.lastIndex = start;
  let m;
  while ((m = TEXT_STOP_RE.exec(src)) !== null) {
    const s = m[0];
    if (s.length === 1) { // construct opener
      if (emailStop !== -1 && emailStop < m.index) return emailStop;
      return m.index;
    }
    if (s === 'www.') {
      if (WWW_PREV.indexOf(src[m.index - 1]) !== -1) {
        if (emailStop !== -1 && emailStop < m.index) return emailStop;
        return m.index;
      }
      start = m.index + 1;
      TEXT_STOP_RE.lastIndex = start;
      if (emailStop !== -1 && emailStop <= start) emailStop = nextEmailStart(src, start);
      continue;
    }
    const last = s.charCodeAt(s.length - 1);
    if (last === 10) { // space run + newline
      if (m.index === start) {
        start = m.index + s.length;
        TEXT_STOP_RE.lastIndex = start;
        if (emailStop !== -1 && emailStop <= start) emailStop = nextEmailStart(src, start);
        continue;
      }
      if (emailStop !== -1 && emailStop < m.index) return emailStop;
      return m.index;
    }
    if (s === 'mailto:' || s === 'xmpp:') {
      if (m.index === start) {
        start++;
        TEXT_STOP_RE.lastIndex = start;
        if (emailStop !== -1 && emailStop <= start) emailStop = nextEmailStart(src, start);
        continue;
      }
      if (emailStop !== -1 && emailStop < m.index) return emailStop;
      return m.index;
    }
    // protocol (http://, https://, ftp://)
    if (emailStop !== -1 && emailStop < m.index) return emailStop;
    return m.index;
  }
  if (emailStop !== -1) return emailStop;
  return len;
}

function renderTextRun(run, ctx, plain) {
  if (ctx.inRawBlock) return run;
  // Fast path: with no '&' and no < > " ' there is nothing to decode or
  // escape, so both helpers are the identity.
  if (!/[&<>"']/.test(run)) return run;
  const decoded = decodeNumericRefs(run);
  return plain ? decoded : escNoEncode(decoded);
}

function renderAutolink(text, href) {
  const clean = cleanUrl(href);
  const parsedText = escEncode(text);
  if (clean === null) return parsedText;
  return '<a href="' + escEncode(clean) + '">' + parsedText + '</a>';
}

function renderLink(href, title, innerHtml) {
  const clean = cleanUrl(href);
  if (clean === null) return innerHtml;
  let out = '<a href="' + escNoEncode(clean) + '"';
  if (title) out += ' title="' + escNoEncode(title) + '"';
  return out + '>' + innerHtml + '</a>';
}

function renderImage(href, title, altText) {
  const clean = cleanUrl(href);
  if (clean === null) return escNoEncode(altText);
  let out = '<img src="' + escNoEncode(clean) + '" alt="' + escNoEncode(altText) + '"';
  if (title) out += ' title="' + escNoEncode(title) + '"';
  return out + '>';
}

// Last `*`/`_` run that can close emphasis/strong and last `~` run that can
// close strikethrough, scanned once per inline run over its masked source.
function scanClosers(src) {
  const last = { '*': -1, '_': -1, del: -1 };
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') last.del = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return last;
}

function linkInText(text, ctx) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(blockSkipRe)) {
    if (linkRe.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(reflinkSearchRe)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), ctx)) continue;
    return true;
  }
  return false;
}

// Mask links, code spans, HTML and escapes so emStrong/del do not see their
// delimiters. Length-preserving, so indexes line up with the source. Each
// pass is skipped when the source cannot contain what it masks.
function maskSrc(src, ctx) {
  let maskedSrc = src;
  if (ctx.linkCount > 0 && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, ctx)) {
          return '[' + text.replace(reflinkSearchRe, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearchRe, maskReflink);
  }
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(anyPunctuationOutsideCodeRe, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(blockSkipRe, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

function isLabelEndInsideToken(src, pos, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = inlineCodeRe.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(pos + labelStart + i);
    const token = tagRe.exec(tokenSrc) || autolinkRe.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Build a link/image from a matched label: tokenize its text, enforce the
// "links may not contain other links" rule, and render it. Returns the HTML
// string, or null when the construct bails out (caller falls through to text).
function outputLink(raw, label, href, title, ctx, plain, end) {
  const text = label.replace(other.outputLinkReplace, '$1');
  const isImage = raw.charAt(0) === '!';
  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = renderInline(text, ctx, ctx.linkParenPossible, plain || isImage);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      ctx.inRawBlock = outerInRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }
  if (plain) return inner;
  if (isImage) return renderImage(href, title, inner);
  return renderLink(href, title, inner);
}

function tryLink(src, pos, ctx, plain) {
  if (ctx.linkParenPossible === false) return null;
  const m = execAt(S.link, src, pos);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, pos, m[1], labelStart)) return null;
  let m0 = m[0], m2 = m[2], m3 = m[3];
  const trimmedUrl = m2.trim();
  if (other.startAngleBracket.test(trimmedUrl)) {
    if (!other.endAngleBracket.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(m2, '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = m0.indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + m[1].length + lastParenIndex;
      m2 = m2.substring(0, lastParenIndex);
      m0 = m0.substring(0, linkLen).trim();
      m3 = '';
    }
  }
  const unescaped = rtrim(m0.slice(0, -1), '\\');
  if ((m0.length - unescaped.length) % 2 === 0) return null;
  const title = m3 ? m3.slice(1, -1) : '';
  let href = m2.trim();
  if (other.startAngleBracket.test(href)) href = href.slice(1, -1);
  const html = outputLink(
    m0, m[1],
    href ? href.replace(anyPunctuationRe, '$1') : href,
    title ? title.replace(anyPunctuationRe, '$1') : title,
    ctx, plain, pos + m0.length,
  );
  if (html === null) return null;
  return { end: pos + m0.length, html };
}

function tryReflink(src, pos, ctx, plain) {
  const m = execAt(S.reflink, src, pos) || execAt(S.nolink, src, pos);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, pos, m[1], labelStart)) return null;
  const link = ctx.links[normalizeLabel(m[2] || m[1])];
  if (!link) {
    // A failed reference leaves just its first character as text.
    return { end: pos + 1, text: m[0].charAt(0) };
  }
  const html = outputLink(m[0], m[1], link.href, link.title, ctx, plain, pos + m[0].length);
  if (html === null) return null;
  return { end: pos + m[0].length, html };
}

function emStrong(src, pos, masked, scan, prevChar, ctx, plain) {
  const m = execAt(S.emStrongLDelim, src, pos);
  if (!m) return null;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
  const delimChar = m[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = lastCp(masked.slice(Math.max(0, runStart - 2), runStart));
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!punctuationRe.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!punctuationRe.exec(prevChar);
  if (m[4] && prevChar.match(other.unicodeAlphaNumeric)) return null;
  const nextChar = m[1] || m[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = m[0].length - lastCpLen(m[0]);
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? emStrongRDelimAstRe : emStrongRDelimUndRe;
    const lastPossible = scan[delimChar];
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    const windowMasked = masked.slice(windowStart);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(windowMasked)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = firstCpLen(match[0]);
      const rawEnd = pos + lLength + match.index + lastCharLength + rLength;
      const raw = src.slice(pos, rawEnd);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const inner = renderInline(text, ctx, ctx.linkParenPossible, plain);
        return { end: rawEnd, html: plain ? inner : `<em>${inner}</em>` };
      }
      const text = raw.slice(2, -2);
      const inner = renderInline(text, ctx, ctx.linkParenPossible, plain);
      return { end: rawEnd, html: plain ? inner : `<strong>${inner}</strong>` };
    }
  }
  return null;
}

function del(src, pos, masked, scan, prevChar, ctx, plain) {
  const m = execAt(S.delLDelim, src, pos);
  if (!m) return null;
  const nextChar = m[1] || '';
  if (!nextChar || !prevChar || punctuationRe.exec(prevChar)) {
    const lLength = m[0].length - lastCpLen(m[0]);
    let rDelim, rLength, delimTotal = lLength;
    const lastPossible = scan.del;
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    const windowMasked = masked.slice(windowStart);
    const lastInWindow = lastPossible - windowStart;
    delRDelimRe.lastIndex = 0;
    let match;
    while ((match = delRDelimRe.exec(windowMasked)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = firstCpLen(match[0]);
      const rawEnd = pos + lLength + match.index + lastCharLength + rLength;
      const raw = src.slice(pos, rawEnd);
      const text = raw.slice(lLength, -lLength);
      const inner = renderInline(text, ctx, ctx.linkParenPossible, plain);
      return { end: rawEnd, html: plain ? inner : `<del>${inner}</del>` };
    }
  }
  return null;
}

function tryUrl(src, pos, ctx, plain) {
  // A URL can only start with a letter, digit, '.', '_', '+' or '-'.
  if (!isUrlStartCode(src.charCodeAt(pos))) return null;
  const m = execAt(S.url, src, pos);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    let cap0 = m[0];
    do {
      prevCapZero = cap0;
      const bp = backpedalRe.exec(cap0);
      cap0 = bp ? bp[0] : '';
    } while (prevCapZero !== cap0);
    text = cap0;
    href = m[1] === 'www.' ? 'http://' + cap0 : cap0;
  }
  const end = pos + text.length;
  if (plain) return { end, html: text };
  return { end, html: renderAutolink(text, href) };
}

function renderInline(src, ctx, parentParen, plain) {
  const prevParen = ctx.linkParenPossible;
  ctx.linkParenPossible = prevParen && src.includes(')');
  // A URL (extended autolink) needs '://', '@' or 'www.' somewhere in the
  // string; without any of them tryUrl can never match, so skip it outright.
  const mayUrl = src.includes('://') || src.includes('@') || src.includes('www.');
  // Masking only changes the string when there is a code span, link, HTML
  // tag or escape to hide delimiters inside; without any of those the
  // masked source is the source itself.
  let masked = src, scan = null;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    if (src.includes('`') || src.includes('[') || src.includes('<') || src.includes('\\')) {
      masked = maskSrc(src, ctx);
    }
    scan = scanClosers(masked);
  }
  let out = '';
  const len = src.length;
  let pos = 0;
  let prevChar = '';
  let keepPrev = false;
  try {
    while (pos < len) {
      if (!keepPrev) prevChar = '';
      keepPrev = false;
      const code = src.charCodeAt(pos);
      let m, res;
      // Constructs are keyed on the first character, so dispatch on its code
      // directly; anything else can only be a URL or text. Marked's order
      // is preserved inside each branch (escape before br for a backslash,
      // tag before autolink for '<', link before reflink for '['/'!').
      // Falling out of a branch (break) reaches the URL/text handling below.
      switch (code) {
        case 92: { // backslash: escape, then br
          if ((m = execAt(S.escape, src, pos))) {
            out += (plain ? m[1] : escNoEncode(m[1]));
            pos += m[0].length;
            continue;
          }
          if (src[pos + 1] === '\n' && (m = execAt(S.br, src, pos))) {
            if (!plain) out += ('<br>');
            pos += m[0].length;
            continue;
          }
          break;
        }
        case 60: { // '<': tag, then autolink
          const nc = src[pos + 1];
          if ((nc === '!' || nc === '/' || nc === '?'
            || (nc >= 'a' && nc <= 'z') || (nc >= 'A' && nc <= 'Z'))
            && (m = execAt(S.tag, src, pos))) {
            if (!ctx.inLink && other.startATag.test(m[0])) ctx.inLink = true;
            else if (ctx.inLink && other.endATag.test(m[0])) ctx.inLink = false;
            if (!ctx.inRawBlock && other.startPreScriptTag.test(m[0])) ctx.inRawBlock = true;
            else if (ctx.inRawBlock && other.endPreScriptTag.test(m[0])) ctx.inRawBlock = false;
            out += (m[0]);
            pos += m[0].length;
            continue;
          }
          // autolink — the char after '<' must be an email char (a scheme
          // starts with a letter, an email address with an email char)
          if (isEmailCharCode(src.charCodeAt(pos + 1)) && (m = execAt(S.autolink, src, pos))) {
            let text, href;
            if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
            else { text = m[1]; href = text; }
            out += (plain ? text : renderAutolink(text, href));
            pos += m[0].length;
            continue;
          }
          break;
        }
        case 91: case 33: { // '[' or '!': link, then reflink / nolink
          if ((res = tryLink(src, pos, ctx, plain))) {
            out += (res.html);
            pos = res.end;
            continue;
          }
          if ((res = tryReflink(src, pos, ctx, plain))) {
            if (res.text !== undefined) {
              out += (res.text);
            } else {
              out += (res.html);
            }
            pos = res.end;
            continue;
          }
          break;
        }
        case 42: case 95: { // '*' or '_': em & strong
          // Needs a closer after this position (scan holds the last closer
          // index per delimiter); without one it cannot match.
          if (scan[code === 42 ? '*' : '_'] > pos && (res = emStrong(src, pos, masked, scan, prevChar, ctx, plain))) {
            out += (res.html);
            pos = res.end;
            continue;
          }
          break;
        }
        case 96: { // '`': codespan — needs a closing backtick somewhere ahead
          if (src.indexOf('`', pos + 1) !== -1 && (m = execAt(S.code, src, pos))) {
            let text = m[2].replace(other.newLineCharGlobal, ' ');
            const hasNonSpace = other.nonSpaceChar.test(text);
            const spaceBothEnds = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
            if (hasNonSpace && spaceBothEnds) text = text.substring(1, text.length - 1);
            out += (plain ? text : '<code>' + escEncode(text) + '</code>');
            pos += m[0].length;
            continue;
          }
          break;
        }
        case 32: { // space: br — needs two spaces + newline
          if (spaceRunBreak(src, pos) && (m = execAt(S.br, src, pos))) {
            if (!plain) out += ('<br>');
            pos += m[0].length;
            continue;
          }
          break;
        }
        case 126: { // '~': del — needs a closer after this position
          if (scan.del > pos && (res = del(src, pos, masked, scan, prevChar, ctx, plain))) {
            out += (res.html);
            pos = res.end;
            continue;
          }
          break;
        }
      }
      // url (extended autolink)
      if (mayUrl && !ctx.inLink && isUrlStartCode(code) && (res = tryUrl(src, pos, ctx, plain))) {
        out += (res.html);
        pos = res.end;
        continue;
      }
      // text
      const end = scanText(src, pos);
      const run = src.slice(pos, end);
      out += (renderTextRun(run, ctx, plain));
      const lastCh = run.charCodeAt(run.length - 1);
      if (lastCh !== 95) prevChar = run[run.length - 1];
      keepPrev = true;
      pos = end;
    }
  } finally {
    ctx.linkParenPossible = prevParen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block lexing (token-based, like marked's, but index-based: sticky regexes
// match at a cursor instead of on fresh substrings)
// ---------------------------------------------------------------------------

function testAt(re, str, pos) {
  re.lastIndex = pos;
  return re.test(str);
}

// First line of src starting at s, and the cursor just past its line end.
function lineFrom(src, s) {
  const nl = src.indexOf('\n', s);
  if (nl === -1) return { line: src.slice(s), next: src.length };
  return { line: src.slice(s, nl), next: nl + 1 };
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(other.indentCodeCompensation);
  if (matchIndentToCode === null) return text;
  const indentToCode = matchIndentToCode[1];
  return text.split('\n').map((node) => {
    const matchIndentInNode = node.match(other.beginningSpace);
    if (matchIndentInNode === null) return node;
    const [indentInNode] = matchIndentInNode;
    return node.slice(Math.min(indentInNode.length, indentToCode.length));
  }).join('\n');
}

function tokSpace(src, pos) {
  const m = execAt(S.newline, src, pos);
  if (m && m[0].length > 0) return { token: { type: 'space', raw: m[0] }, end: pos + m[0].length };
  return null;
}

function tokCode(src, pos) {
  const m = execAt(S.blockCode, src, pos);
  if (!m) return null;
  const raw = trimTrailingBlankLines(m[0]);
  const text = raw.replace(other.codeRemoveIndent, '');
  return { token: { type: 'code', raw, text }, end: pos + raw.length };
}

function tokFences(src, pos) {
  const m = execAt(S.fences, src, pos);
  if (!m) return null;
  const raw = m[0];
  const text = indentCodeCompensation(raw, m[3] || '');
  return {
    token: {
      type: 'code', raw,
      lang: m[2] ? m[2].trim().replace(anyPunctuationRe, '$1') : m[2],
      text,
    },
    end: pos + raw.length,
  };
}

function tokHeading(src, pos) {
  const m = execAt(S.heading, src, pos);
  if (!m) return null;
  let text = m[2].trim();
  if (other.endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || other.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
  }
  const raw = rtrim(m[0], '\n');
  return { token: { type: 'heading', raw, depth: m[1].length, text }, end: pos + raw.length };
}

function tokHr(src, pos) {
  const m = execAt(S.hr, src, pos);
  if (!m) return null;
  const raw = rtrim(m[0], '\n');
  return { token: { type: 'hr', raw }, end: pos + raw.length };
}

function tokBlockquote(src, pos, ctx) {
  const m = execAt(S.blockquote, src, pos);
  if (!m) return null;
  let lines = rtrim(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (other.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(
        other.blockquoteMarkerWhitespace,
        (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
      )
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const top = ctx.top;
    ctx.top = true;
    blockTokens(currentText, 0, tokens, ctx, true);
    ctx.top = top;
    if (lines.length === 0) break;
    const lastToken = tokens.at(-1);
    if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
      break;
    } else if (lastToken?.type === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(newText, 0, ctx).token;
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken?.type === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(newText, 0, ctx).token;
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { token: { type: 'blockquote', raw, tokens, text }, end: pos + raw.length };
}

function tokList(src, pos, ctx) {
  const cap0 = execAt(S.list, src, pos);
  if (!cap0) return null;
  const listStart = pos;
  let s = pos;
  let bull = cap0[1].trim();
  const isordered = bull.length > 1;
  const list = {
    type: 'list', raw: '', ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '', loose: false, items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = sticky(other.listItemRegex(bull));
  let endsWithBlankLine = false;
  while (s < src.length) {
    let endEarly = false;
    let itemContents = '';
    const cap = execAt(itemRegex, src, s);
    if (!cap) break;
    if (testAt(S.hr, src, s)) break;
    const itemStartAbs = s;
    s += cap[0].length;
    let firstLine = cap[2];
    if (firstLine.endsWith('\n')) firstLine = firstLine.slice(0, -1);
    const bulletIndent = cap[1].length;
    // Tab-expanding the first line's leading whitespace is a no-op unless a
    // tab is present there.
    let line = firstLine.includes('\t')
      ? firstLine.replace(other.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent))
      : firstLine;
    // Is the next line (at s) blank? Scan it without slicing.
    const nextNl = src.indexOf('\n', s);
    const nextLineEnd = nextNl === -1 ? src.length : nextNl;
    let nextLineBlank = true;
    for (let i = s; i < nextLineEnd; i++) {
      const c = src[i];
      if (c !== ' ' && c !== '\t') { nextLineBlank = false; break; }
    }
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(other.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && nextLineBlank) {
      s = nextLineEnd + (nextNl === -1 ? 0 : 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = other.nextBulletRegex(indent);
      const hrRegex = other.hrRegex(indent);
      const fencesBeginRegex = other.fencesBeginRegex(indent);
      const headingBeginRegex = other.headingBeginRegex(indent);
      const htmlBeginRegex = other.htmlBeginRegex(indent);
      const blockquoteBeginRegex = other.blockquoteBeginRegex(indent);
      while (s < src.length) {
        const nlIdx = src.indexOf('\n', s);
        const nextS = nlIdx === -1 ? src.length : nlIdx + 1;
        const nextLine2 = nlIdx === -1 ? src.slice(s) : src.slice(s, nlIdx);
        // Scan the raw line's leading whitespace once: expIdx is the
        // tab-stop-expanded index of the first content char (what
        // nextLineWithoutTabs.search(nonSpaceChar) returns), sp the count of
        // leading spaces, fc the first content char. A tab before the first
        // content char makes the six begin-regexes (which run on the raw
        // line and allow only spaces before their marker) unmatchable.
        let e = 0, expIdx = 0, hasTab = false;
        while (e < nextLine2.length) {
          const c = nextLine2[e];
          if (c === ' ') { expIdx++; e++; }
          else if (c === '\t') { hasTab = true; expIdx += 4 - (expIdx % 4); e++; }
          else break;
        }
        const fc = e < nextLine2.length ? nextLine2[e] : '';
        const blank = fc === '';
        let sp = 0;
        while (sp < e && nextLine2[sp] === ' ') sp++;
        const noTabBeforeMarker = sp === e;
        // The tab-expanded line is identical to the raw line unless a tab
        // sits in the leading whitespace.
        const nextLineWithoutTabs = hasTab
          ? nextLine2.replace(other.leadingSpaceTab, (whitespace) => expandTabs(whitespace))
          : nextLine2;
        if (noTabBeforeMarker && sp <= indent) {
          if ((fc === '`' || fc === '~') && fencesBeginRegex.test(nextLine2)) break;
          if (fc === '#' && headingBeginRegex.test(nextLine2)) break;
          if (fc === '<' && htmlBeginRegex.test(nextLine2)) break;
          if (fc === '>' && blockquoteBeginRegex.test(nextLine2)) break;
          if ((fc === '-' || fc === '*' || fc === '+' || (fc >= '0' && fc <= '9')) && nextBulletRegex.test(nextLine2)) break;
          if ((fc === '-' || fc === '_' || fc === '*') && hrRegex.test(nextLine2)) break;
        }
        if (blank || expIdx >= indent) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          // line.replace(tabCharGlobal, '    ').search(nonSpaceChar) >= 4,
          // computed by hand: a tab adds exactly four columns here.
          let col = 0, li = 0, lineFirstNonSpace = -1;
          while (li < line.length) {
            const c = line[li];
            if (c === ' ') { col++; li++; }
            else if (c === '\t') { col += 4; li++; }
            else { lineFirstNonSpace = col; break; }
          }
          if (lineFirstNonSpace >= 4) break;
          // The four begin-regexes on the previous line: guard by its first
          // non-space character (its leading whitespace holds no tabs).
          let lsp = 0;
          while (lsp < line.length && line[lsp] === ' ') lsp++;
          const lfc = lsp < line.length ? line[lsp] : '';
          if (lsp <= indent) {
            if ((lfc === '`' || lfc === '~') && fencesBeginRegex.test(line)) break;
            if (lfc === '#' && headingBeginRegex.test(line)) break;
            if (lfc === '<' && htmlBeginRegex.test(line)) break;
            if ((lfc === '-' || lfc === '_' || lfc === '*') && hrRegex.test(line)) break;
          }
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine2)
            && testAt(S.lheading, `${line}\n${nextLine2}`, 0);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine2;
          itemContents += '\n' + continuation;
        }
        blankLine = blank;
        s = nextS;
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = src.slice(itemStartAbs, s);
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (other.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      type: 'list_item', raw,
      task: other.listIsTask.test(itemContents),
      loose: false, text: itemContents, tokens: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null;
  }
  list.raw = src.slice(listStart, s).trimEnd();
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockTokens(item.text, 0, [], ctx);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => other.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(other.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(other.listReplaceTask, '');
      const taskRaw = other.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = {
          type: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type)) {
            // The checkbox renders inside the first paragraph/text token.
            item.tokens[0].checkbox = checkboxToken;
          } else {
            item.tokens.unshift({
              type: 'paragraph', raw: checkboxToken.raw, text: '', checkbox: checkboxToken, tokens: undefined,
            });
          }
        } else {
          item.tokens.unshift(checkboxToken);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }
  return { token: list, end: listStart + list.raw.length };
}

function tokHtml(src, pos) {
  const m = execAt(S.html, src, pos);
  if (!m) return null;
  const raw = trimTrailingBlankLines(m[0]);
  return {
    token: {
      type: 'html', raw,
      pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      text: raw,
    },
    end: pos + raw.length,
  };
}

function tokDef(src, pos) {
  const m = execAt(S.def, src, pos);
  if (!m) return null;
  if (!other.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) return null;
  const tag = normalizeLabel(m[1]);
  const href = m[2] ? m[2].replace(other.hrefBrackets, '$1').replace(anyPunctuationRe, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(anyPunctuationRe, '$1') : m[3];
  const raw = rtrim(m[0], '\n');
  return { token: { type: 'def', tag, raw, href, title }, end: pos + raw.length };
}

function tokTable(src, pos) {
  const m = execAt(S.table, src, pos);
  if (!m) return null;
  if (!other.tableDelimiter.test(m[2])) return null;
  const headers = splitCells(m[1]);
  const aligns = m[2].replace(other.tableAlignChars, '').split('|');
  const rows = m[3]?.trim() ? m[3].replace(other.tableRowBlankLine, '').split('\n') : [];
  if (headers.length !== aligns.length) return null;
  const item = {
    type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [],
  };
  for (const align of aligns) {
    if (other.tableAlignRight.test(align)) item.align.push('right');
    else if (other.tableAlignCenter.test(align)) item.align.push('center');
    else if (other.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell, header: false, align: item.align[i],
    })));
  }
  return { token: item, end: pos + item.raw.length };
}

function tokLheading(src, pos) {
  const m = execAt(S.lheading, src, pos);
  if (!m) return null;
  const text = m[1].trim();
  const raw = rtrim(m[0], '\n');
  return {
    token: { type: 'heading', raw, depth: m[2].charAt(0) === '=' ? 1 : 2, text },
    end: pos + raw.length,
  };
}

function tokParagraph(src, pos) {
  const m = execAt(S.paragraph, src, pos);
  if (!m) return null;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { token: { type: 'paragraph', raw: m[0], text }, end: pos + m[0].length };
}

function tokText(src, pos) {
  const m = execAt(S.text, src, pos);
  if (!m) return null;
  return { token: { type: 'text', raw: m[0], text: m[0] }, end: pos + m[0].length };
}

function blockTokens(src, pos, tokens, ctx, lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (pos < src.length) {
    const remaining = src.length - pos;
    if (remaining < srcLength) {
      srcLength = remaining;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    }
    // First-non-space dispatch: most block constructs need a specific marker
    // after at most three spaces, so tokenizers whose marker is absent are
    // skipped without running their regex. Order is marked's; only provably
    // impossible matches are skipped (table, setext heading, paragraph and
    // text can start with anything, so they are always tried).
    let ind = 0;
    while (ind < 4 && src[pos + ind] === ' ') ind++;
    const fc = src[pos + ind];
    const ind3 = ind <= 3;
    let res;
    if ((src[pos] === ' ' || src[pos] === '\t' || src[pos] === '\n') && (res = tokSpace(src, pos))) {
      pos = res.end;
      const lastToken = tokens.at(-1);
      if (res.token.raw.length === 1 && lastToken !== undefined) lastToken.raw += '\n';
      else tokens.push(res.token);
      continue;
    }
    if (((ind >= 4) || fc === '\t') && (res = tokCode(src, pos))) {
      pos = res.end;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + res.token.raw;
        lastToken.text += '\n' + res.token.text;
      } else {
        tokens.push(res.token);
      }
      continue;
    }
    if (ind3 && (fc === '`' || fc === '~') && (res = tokFences(src, pos))) {
      pos = res.end;
      tokens.push(res.token);
      continue;
    }
    if (ind3 && fc === '#' && (res = tokHeading(src, pos))) {
      pos = res.end;
      tokens.push(res.token);
      continue;
    }
    if (ind3 && (fc === '-' || fc === '_' || fc === '*') && (res = tokHr(src, pos))) {
      pos = res.end;
      tokens.push(res.token);
      continue;
    }
    if (ind3 && fc === '>' && (res = tokBlockquote(src, pos, ctx))) {
      pos = res.end;
      tokens.push(res.token);
      continue;
    }
    if (ind3 && (fc === '-' || fc === '*' || fc === '+' || (fc >= '0' && fc <= '9')) && (res = tokList(src, pos, ctx))) {
      pos = res.end;
      tokens.push(res.token);
      continue;
    }
    if (ind3 && fc === '<' && (res = tokHtml(src, pos))) {
      pos = res.end;
      tokens.push(res.token);
      continue;
    }
    if (ind3 && fc === '[' && (res = tokDef(src, pos))) {
      pos = res.end;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + res.token.raw;
        lastToken.text += '\n' + res.token.raw;
      } else {
        if (!ctx.links[res.token.tag]) {
          ctx.links[res.token.tag] = { href: res.token.href, title: res.token.title };
          ctx.linkCount++;
        }
        tokens.push(res.token);
      }
      continue;
    }
    if (maybeTable(src, pos) && (res = tokTable(src, pos))) {
      pos = res.end;
      tokens.push(res.token);
      continue;
    }
    if (maybeSetext(src, pos) && (res = tokLheading(src, pos))) {
      pos = res.end;
      tokens.push(res.token);
      continue;
    }
    if (ctx.top && (res = tokParagraph(src, pos))) {
      pos = res.end;
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + res.token.raw;
        lastToken.text += '\n' + res.token.text;
      } else {
        tokens.push(res.token);
      }
      lastParagraphClipped = false;
      continue;
    }
    if ((res = tokText(src, pos))) {
      pos = res.end;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + res.token.raw;
        lastToken.text += '\n' + res.token.text;
      } else {
        tokens.push(res.token);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  ctx.top = true;
  return tokens;
}

// A table needs a delimiter row as its second line: after up to three
// spaces it may hold only '|', ':', '-', spaces and tabs, and must hold a
// '-'. Without such a line the table regex cannot match.
function maybeTable(src, pos) {
  const nl = src.indexOf('\n', pos);
  if (nl === -1) return false;
  let i = nl + 1;
  let spaces = 0;
  while (i < src.length && src[i] === ' ' && spaces < 3) { i++; spaces++; }
  let dash = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') break;
    if (c === '-') dash = true;
    else if (c !== '|' && c !== ':' && c !== ' ' && c !== '\t') return false;
  }
  return dash;
}

// A setext heading needs an underline line (only '='/'-' plus trailing
// blanks) before the next blank line. Without one the lheading regex
// cannot match.
function maybeSetext(src, pos) {
  let i = src.indexOf('\n', pos);
  if (i === -1) return false;
  i++;
  const len = src.length;
  while (i < len) {
    const nl = src.indexOf('\n', i);
    const lineEnd = nl === -1 ? len : nl;
    let blank = true;
    let j = i;
    let spaces = 0;
    while (j < lineEnd && src[j] === ' ') { j++; spaces++; }
    if (spaces <= 3 && j < lineEnd) {
      const c = src[j];
      if (c === '=' || c === '-') {
        let k = j;
        while (k < lineEnd && src[k] === c) k++;
        while (k < lineEnd && (src[k] === ' ' || src[k] === '\t')) k++;
        if (k === lineEnd) return true;
      }
    }
    for (; j < lineEnd; j++) {
      if (src[j] !== ' ' && src[j] !== '\t') { blank = false; break; }
    }
    if (blank) return false;
    if (nl === -1) return false;
    i = nl + 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function checkboxHtml(cb) {
  return '<input ' + (cb.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

// A top-level inline run: marked resets inRawBlock before each queued run
// (an unclosed <pre> must not leak into the next block), while inLink is
// shared across runs, so only inRawBlock is reset here.
function renderInlineTop(text, ctx, plain) {
  ctx.inRawBlock = false;
  return renderInline(text, ctx, true, plain);
}

function renderCode(token) {
  const langString = (token.lang || '').match(other.notSpaceStart)?.[0];
  const code = token.text ? token.text.replace(other.endingNewline, '') + '\n' : '';
  if (!langString) return '<pre><code>' + escEncode(code) + '</code></pre>\n';
  return '<pre><code class="language-' + escNoEncode(langString) + '">'
    + escEncode(code) + '</code></pre>\n';
}

function renderTableCell(cell, ctx) {
  const content = renderInlineTop(cell.text, ctx, false);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTable(token, ctx) {
  let cell = '';
  for (const h of token.header) cell += renderTableCell(h, ctx);
  let header = `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (const row of token.rows) {
    cell = '';
    for (const c of row) cell += renderTableCell(c, ctx);
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderBlocks(tokens, ctx) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${token.depth}>${renderInlineTop(token.text, ctx, false)}</h${token.depth}>\n`;
        break;
      case 'code':
        out += renderCode(token);
        break;
      case 'table':
        out += renderTable(token, ctx);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(token.tokens, ctx)}</blockquote>\n`;
        break;
      case 'list': {
        let body = '';
        for (const item of token.items) body += `<li>${renderBlocks(item.tokens, ctx)}</li>\n`;
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox':
        out += checkboxHtml(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${token.checkbox ? checkboxHtml(token.checkbox) : ''}${renderInlineTop(token.text, ctx, false)}</p>\n`;
        break;
      case 'text':
        out += (token.checkbox ? checkboxHtml(token.checkbox) : '') + renderInlineTop(token.text, ctx, false);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const src = markdown.replace(other.carriageReturn, '\n');
  const ctx = {
    links: Object.create(null),
    linkCount: 0,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
  const tokens = blockTokens(src, 0, [], ctx, false);
  return renderBlocks(tokens, ctx);
}
