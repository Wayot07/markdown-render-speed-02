// parse.js — a fast, dependency-free CommonMark + GFM renderer.
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with its
// default options (gfm on, breaks off). Written from scratch: single module,
// block lexer -> inline lexer -> direct HTML renderer.
'use strict';

// ---- tiny regex composer: build a pattern from pieces, stripping a leading
// ^ from any piece that is embedded mid-pattern (it would anchor wrongly).
const CARET = /(^|[^\[])\^/g;
function C(src, flags) {
  let s = typeof src === 'string' ? src : src.source;
  return {
    rep(a, b) {
      let t = typeof b === 'string' ? b : b.source;
      t = t.replace(CARET, '$1');
      s = s.replace(a, t);
      return this;
    },
    get() { return new RegExp(s, flags); }
  };
}

const TAGNAMES = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const COMMENT_RE = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HR_SRC = '^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_BEGIN_SRC = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const BULL_RE = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const LABEL_RE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/; // link label / ref content
const TITLE_RE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)/;
const BRACKET_RE = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL_RE = C(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).rep('brackets', BRACKET_RE).get();
const LINK_LABEL_LT_RE = C(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).rep('brackets', BRACKET_RE).get();
const REF_BODY_RE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;

// ---- block grammar ----
const R_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const R_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const R_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const R_HR = new RegExp(HR_SRC);
const R_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const R_TEXT = /^[^\n]+/;
const R_LIST = C(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).rep(/bull/g, BULL_RE).get();
const R_DEF = C(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).rep('label', LABEL_RE).rep('title', TITLE_RE).get();
const R_HTML = C('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .rep('comment', COMMENT_RE).rep('tag', TAGNAMES)
  .rep('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).get();
const R_TABLE = C('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .rep('hr', R_HR).rep('heading', HEADING_SRC).rep('blockquote', ' {0,3}>')
  .rep('code', '(?: {4}| {0,3}\t)[^\\n]').rep('fences', FENCES_SRC)
  .rep('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]').rep('html', HTML_BEGIN_SRC).rep('tag', TAGNAMES).get();
const PARA_TMPL = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function paraWith(listSrc) {
  return C(PARA_TMPL).rep('hr', R_HR).rep('heading', HEADING_SRC).rep('|lheading', '')
    .rep('table', R_TABLE).rep('blockquote', ' {0,3}>').rep('fences', FENCES_SRC)
    .rep('list', listSrc).rep('html', HTML_BEGIN_SRC).rep('tag', TAGNAMES).get();
}
const R_PARA = paraWith(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]');
const R_PARA_LIST = paraWith(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
const R_BLOCKQUOTE = C(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).rep('paragraph', R_PARA_LIST).get();
const R_LHEADING = C(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
  .rep(/bull/g, BULL_RE).rep('blockCode', /(?: {4}| {0,3}\t)/).rep('fences', ' {0,3}(?:`{3,}|~{3,})')
  .rep('blockquote', ' {0,3}>').rep('heading', HEADING_SRC)
  .rep('hr', / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .rep('html', ' {0,3}<[^\\n>]+>\\n').rep('table', ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n').get();

// indent-dependent block regexes (memoised by indent width).
// NB: marked's memoiser clamps the width to min(3, n-1) AND builds the regex
// from the clamped value, so a nested bullet at exactly R spaces does NOT
// count as a sibling bullet.
const _rc = {};
function rxFor(kind, n) {
  const k = kind + n;
  let r = _rc[k];
  if (r) return r;
  if (kind === 'item') r = new RegExp(`^( {0,3}${n})((?:[ \t][^\n]*)?(?:\n|$))`);
  else {
    const m = Math.max(0, Math.min(3, n - 1));
    if (kind === 'bullet') r = new RegExp(`^ {0,${m}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`);
    else if (kind === 'hr') r = new RegExp(`^ {0,${m}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`);
    else if (kind === 'fence') r = new RegExp(`^ {0,${m}}(?:\`\`\`|~~~)`);
    else if (kind === 'heading') r = new RegExp(`^ {0,${m}}#{1,6}(?:\\s|$)`);
    else if (kind === 'html') r = new RegExp(`^ {0,${m}}(?:</?(?:${TAGNAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
    else r = new RegExp(`^ {0,${m}}>`);
  }
  _rc[k] = r;
  return r;
}

// ---- inline grammar ----
const R_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const R_CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const R_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const SCHEME_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_AT_RE = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const AUTOLINK_EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const R_AUTOLINK = C(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).rep('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).rep('email', AUTOLINK_EMAIL_RE).get();
const R_TAG = C('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .rep('comment', /<!--(?:-?>|[\s\S]*?-->)/)
  .rep('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).get();
const R_LINK = C(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .rep('label', LINK_LABEL_RE).rep('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).rep('title', TITLE_RE).get();
const R_REFLINK = C(/^!?\[(label)\]\[(ref)\]/).rep('label', LINK_LABEL_RE).rep('ref', LABEL_RE).get();
const R_NOLINK = C(/^!?\[(ref)\](?:\[\])?/).rep('ref', LABEL_RE).get();
const R_REFLINK_SEARCH = C('reflink|nolink(?!\\()', 'g')
  .rep('reflink', C(/^!?\[(label)\]\[(ref)\]/).rep('label', LINK_LABEL_LT_RE).rep('ref', REF_BODY_RE).get())
  .rep('nolink', C(/^!?\[(ref)\](?:\[\])?/).rep('ref', REF_BODY_RE).get()).get();
const R_URL = C(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .rep('emailProtocol', C(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).rep(/email/g, EMAIL_RE).get())
  .rep('protocol', SCHEME_RE).rep('email', EMAIL_AT_RE).get();
const R_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const R_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const R_ANY_PUNCT_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const R_BLOCK_SKIP = C('link|precode-code|html', 'g')
  .rep('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .rep('precode-', '(?<!`)()').rep('code', /(?<b>`+)[^`]+\k<b>(?!`)/).rep('html', /<(?! )[^<>]*?>/).get();
const PUNCT = /[\p{P}\p{S}]/u, PUNCT_SP = /[\s\p{P}\p{S}]/u, NOT_PUNCT_SP = /[^\s\p{P}\p{S}]/u;
const PUNCT_NT = /(?!~)[\p{P}\p{S}]/u, PUNCT_SP_NT = /(?!~)[\s\p{P}\p{S}]/u, NOT_PUNCT_SP_T = /(?:[^\s\p{P}\p{S}]|~)/u;
const R_PUNCT_CHECK = /^((?![*_])[\s\p{P}\p{S}])/u;
const R_EM_L = C(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u').rep(/punct/g, PUNCT_NT).get();
const R_EM_R_AST = C('^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)', 'gu')
  .rep(/notPunctSpace/g, NOT_PUNCT_SP_T).rep(/punctSpace/g, PUNCT_SP_NT).rep(/punct/g, PUNCT_NT).get();
const R_EM_R_UND = C('^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .rep(/notPunctSpace/g, NOT_PUNCT_SP).rep(/punctSpace/g, PUNCT_SP).rep(/punct/g, PUNCT).get();
const R_DEL_L = C(/^(~~?(?:((?!~)punct)|[^\s~]))/, 'u').rep(/punct/g, PUNCT).get();
const R_DEL_R = C('^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
  .rep(/notPunctSpace/g, NOT_PUNCT_SP).rep(/punctSpace/g, PUNCT_SP).rep(/punct/g, PUNCT).get();
const R_TEXT_INLINE = C(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .rep('protocol', SCHEME_RE).rep(/emailProtocol/g, /(?:mailto|xmpp):/).rep('wwwStart', '(?<![^\\s*_~(])www\\.').get();

// ---- small string helpers ----
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_REP = /[&<>"']/g;
const ESC_TEST_NE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REP_NE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function esc(s, all) {
  if (all) { if (ESC_TEST.test(s)) return s.replace(ESC_REP, c => ESC_MAP[c]); }
  else if (ESC_TEST_NE.test(s)) return s.replace(ESC_REP_NE, c => ESC_MAP[c] || '&amp;');
  return s;
}
function unescNum(s) { // decode numeric character references only; stray & -> &amp;
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_AMP, (m, d, h) => {
    if (d === undefined && h === undefined) return '&amp;';
    const cp = d === undefined ? parseInt(h, 16) : parseInt(d, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    return cp === 38 ? '&amp;' : String.fromCodePoint(cp);
  });
}
function hrefEncode(s) {
  try { return encodeURI(s).replace(/%25/g, '%'); } catch { return null; }
}
function normLabel(s) { return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase(); }
function rtrimCh(s, ch, invert) { // strip trailing ch (or trailing non-ch when invert)
  let n = s.length, k = 0;
  while (k < n) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}
function trimEndBlanks(s) { // drop trailing blank lines, keeping at most one blank line's worth
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}
function expandTabs(s, col) { // expand tabs to spaces from column col
  let out = '', c = col || 0;
  for (const ch of s) {
    if (ch === '\t') { const w = 4 - c % 4; out += ' '.repeat(w); c += w; }
    else { out += ch; c++; }
  }
  return out;
}
// Index of the first char that is not a space (RE_NONSPACE is /[^ ]/).
function firstNonSpace(s) {
  let p = 0;
  while (p < s.length && s[p] === ' ') p++;
  return p;
}
// First non-space column after expanding each tab to 4 spaces; -1 if none.
function firstNonSpaceTab4(s) {
  let col = 0;
  for (let p = 0; p < s.length; p++) {
    const c = s[p];
    if (c === '\t') col += 4;
    else if (c === ' ') col += 1;
    else return col;
  }
  return -1;
}
function findParen(s, pair) { // index of unmatched closer, -2 if unclosed opener, -1 if balanced
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}
function splitCells(s, count) { // table row -> cells, honouring escaped pipes
  const t = s.replace(/\|/g, (m, o, str) => {
    let odd = false, p = o;
    while (--p >= 0 && str[p] === '\\') odd = !odd;
    return odd ? '|' : ' |';
  });
  const cells = t.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}
function fenceDedent(raw, text, indent) { // strip fence-indent compensation from code text
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return text;
  const ind = m[1];
  return text.split('\n').map(line => {
    const o = line.match(/^\s+/);
    if (o === null) return line;
    const lead = o[0];
    return line.slice(Math.min(lead.length, ind.length));
  }).join('\n');
}

// ---- block tokenizers, part 1 ----
const RE_CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const RE_END_HASH = /#$/;
const RE_END_SPACE_TAB = /[ \t]$/;

function ctxNew() {
  return { links: Object.create(null), queue: [], masks: [], inLink: false, inRawBlock: false,
    linkEmitted: false, linkParenPossible: true, top: true };
}
function queueInline(ctx, src) { // inline work deferred until all link refs are known
  const tokens = [];
  ctx.queue.push({ src, tokens });
  return tokens;
}
function tokSpace(src) {
  const m = R_NEWLINE.exec(src);
  return m && m[0].length > 0 ? { type: 'space', raw: m[0] } : null;
}
function tokCode(src) {
  const m = R_CODE.exec(src);
  if (!m) return null;
  const raw = trimEndBlanks(m[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RE_CODE_INDENT, '') };
}
function tokFences(src) {
  const m = R_FENCES.exec(src);
  if (!m) return null;
  const lang = m[2] ? m[2].trim().replace(R_ANY_PUNCT, '$1') : m[2];
  return { type: 'code', raw: m[0], lang, text: fenceDedent(m[0], m[3] || '') };
}
function tokHeading(src, ctx) {
  const m = R_HEADING.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (RE_END_HASH.test(text)) {
    const s = rtrimCh(text, '#');
    if (!s || RE_END_SPACE_TAB.test(s)) text = s.trim();
  }
  return { type: 'heading', raw: rtrimCh(m[0], '\n'), depth: m[1].length,
    text, tokens: queueInline(ctx, text) };
}
function tokHr(src) {
  const m = R_HR.exec(src);
  return m ? { type: 'hr', raw: rtrimCh(m[0], '\n') } : null;
}
function tokBlockquote(src, ctx) {
  const m = R_BLOCKQUOTE.exec(src);
  if (!m) return null;
  let lines = rtrimCh(m[0], '\n').split('\n');
  let raw = '', text = '';
  const tokens = [];
  while (lines.length > 0) {
    let lazy = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (RE_BQ_START.test(lines[p])) { chunk.push(lines[p]); lazy = true; }
      else if (!lazy) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const clean = joined.replace(RE_BQ_MARKER_WS, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(RE_BQ_SETEXT, '\n    $1').replace(RE_BQ_SETEXT2, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + clean : clean;
    const savedTop = ctx.top;
    ctx.top = true;
    blockTokens(clean, tokens, ctx, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (!last || last.type === 'code' || last.type === 'heading' || last.type === 'hr' ||
        last.type === 'html' || last.type === 'table') break;
    if (last.type === 'blockquote') {
      const g = last, rest = lines.join('\n');
      const merged = g.raw + '\n' + rest.replace(RE_BQ_SETEXT2, '');
      const f = tokBlockquote(merged, ctx);
      tokens[tokens.length - 1] = f;
      const y = merged.substring(f.raw.length).replace(/^\n/, '');
      const rc = y ? y.split('\n').length : 0;
      const taken = rc ? lines.slice(0, -rc) : lines;
      if (taken.length > 0) raw = raw + '\n' + taken.join('\n');
      text = text.substring(0, text.length - g.text.length) + f.text;
      lines = lines.slice(taken.length);
      if (lines.length > 0 && RE_BQ_START.test(lines[0])) continue;
      break;
    } else if (last.type === 'list') {
      const g = last, rest = g.raw + '\n' + lines.join('\n');
      const ml = tokList(rest, ctx);
      tokens[tokens.length - 1] = ml;
      const f = ml.raw.length > g.raw.length
        ? rest.slice(g.raw.length + 1, ml.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        raw = raw + '\n' + y; text = text + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}
function tokHtml(src) {
  const m = R_HTML.exec(src);
  if (!m) return null;
  const raw = trimEndBlanks(m[0]);
  return { type: 'html', block: true, raw,
    pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
}

// ---- block tokenizers, part 2 ----
const RE_LEADING_WS = /^[ \t]+/;
const RE_NONSPACE = /[^ ]/;
const RE_BLANK = /^[ \t]*$/;
const RE_DBLANK = /\n[ \t]*\n[ \t]*$/;
const RE_ANYLINE = /\n.*\n/;
const RE_LIST_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_TASK_REP = /^\[[ xX]\][ \t]+/;
const RE_TASK_CB = /\[[ xX]\]/;
const RE_TAB = /\t/g;
const RE_SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;
const RE_LEAD3 = /^ {0,3}/;

function tokList(src, ctx) {
  let e = src;
  let t = R_LIST.exec(e);
  if (!t) return null;
  const n = e, s = () => n.length - e.length;
  const rb = t[1].trim(), ordered = rb.length > 1;
  const list = { type: 'list', raw: '', ordered, start: ordered ? +rb.slice(0, -1) : '', loose: false, items: [] };
  const bulletPat = ordered ? `\\d{1,9}\\${rb.slice(-1)}` : `\\${rb}`;
  const itemRe = rxFor('item', bulletPat);
  let loosePending = false;
  while (e) {
    let emptyItem = false, d = '';
    t = itemRe.exec(e);
    if (!t || R_HR.test(e)) break;
    const k = s();
    e = e.substring(t[0].length);
    const g = t[2].split('\n', 1)[0], b = t[1].length;
    let mline = g.replace(RE_LEADING_WS, v => expandTabs(v, b));
    let f = e.split('\n', 1)[0];
    const y0 = !mline.trim();
    let R = 0;
    if (y0) R = b + 1;
    else { R = firstNonSpace(mline); if (R > 4) R = 1; d = mline.slice(R); R += b; }
    if (y0 && RE_BLANK.test(f)) { e = e.substring(f.length + 1); emptyItem = true; }
    if (!emptyItem) {
      const vRe = rxFor('bullet', R), qRe = rxFor('hr', R), eeRe = rxFor('fence', R),
        teRe = rxFor('heading', R), mRe = rxFor('html', R), neRe = rxFor('bq', R);
      let y = y0;
      while (e) {
        const nl = e.indexOf('\n');
        const U = nl === -1 ? e : e.slice(0, nl);
        f = U;
        let Z = f;
        let isBlank = f.length === 0;
        if (f.charCodeAt(0) === 9 || f.charCodeAt(0) === 32) {
          let p = 0, hasTab = false;
          while (p < f.length && (f[p] === ' ' || f[p] === '\t')) { if (f[p] === '\t') hasTab = true; p++; }
          if (hasTab) Z = f.replace(RE_LEADING_WS, me => expandTabs(me));
          isBlank = p === f.length;
        }
        let k = 0;
        while (k < 3 && f[k] === ' ') k++;
        const fc = f[k];
        let brk = false;
        if (fc === '`' || fc === '~') brk = eeRe.test(f);
        else if (fc === '#') brk = teRe.test(f);
        else if (fc === '<') brk = mRe.test(f);
        else if (fc === '>') brk = neRe.test(f);
        else if (fc >= '0' && fc <= '9') brk = vRe.test(f);
        else if (fc === '*') brk = vRe.test(f) || qRe.test(f);
        else if (fc === '+') brk = vRe.test(f);
        else if (fc === '-') brk = vRe.test(f) || qRe.test(f);
        else if (fc === '_') brk = qRe.test(f);
        if (brk) break;
        if (firstNonSpace(Z) >= R || isBlank) d += '\n' + Z.slice(R);
        else {
          if (y || firstNonSpaceTab4(mline) >= 4 || eeRe.test(mline) || teRe.test(mline) || mRe.test(mline) || qRe.test(mline)) break;
          const qe = RE_SETEXT_LINE.test(f) && R_LHEADING.test(mline + '\n' + f)
            ? '    ' + Z.replace(RE_LEAD3, '') : f;
          d += '\n' + qe;
        }
        y = isBlank;
        e = nl === -1 ? '' : e.slice(nl + 1);
        mline = Z.slice(R);
      }
    }
    const rawA = n.slice(k, s());
    if (!list.loose) {
      if (loosePending) list.loose = true;
      else if (RE_DBLANK.test(rawA)) loosePending = true;
    }
    list.items.push({ type: 'list_item', raw: rawA, task: RE_LIST_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const lastIt = list.items[list.items.length - 1];
  if (!lastIt) return null;
  lastIt.raw = lastIt.raw.trimEnd();
  lastIt.text = lastIt.text.trimEnd();
  list.raw = n.slice(0, s()).trimEnd();
  for (const it of list.items) {
    ctx.top = false;
    it.tokens = blockTokens(it.text, [], ctx, false);
    if (!list.loose) {
      const spaces = it.tokens.filter(g => g.type === 'space');
      if (spaces.length > 0 && spaces.some(g => RE_ANYLINE.test(g.raw))) list.loose = true;
    }
  }
  for (const it of list.items) {
    const d0 = it.tokens[0];
    if (it.task && (d0?.type === 'text' || d0?.type === 'paragraph')) {
      it.text = it.text.replace(RE_LIST_TASK_REP, '');
      d0.raw = d0.raw.replace(RE_LIST_TASK_REP, '');
      d0.text = d0.text.replace(RE_LIST_TASK_REP, '');
      for (let gi = ctx.queue.length - 1; gi >= 0; gi--) {
        if (RE_LIST_TASK.test(ctx.queue[gi].src)) {
          ctx.queue[gi].src = ctx.queue[gi].src.replace(RE_LIST_TASK_REP, '');
          break;
        }
      }
      const cb = RE_TASK_CB.exec(it.raw);
      if (cb) {
        const g = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        it.checked = g.checked;
        if (list.loose) {
          if (it.tokens[0] && (it.tokens[0].type === 'paragraph' || it.tokens[0].type === 'text') && 'tokens' in it.tokens[0] && it.tokens[0].tokens) {
            it.tokens[0].raw = g.raw + it.tokens[0].raw;
            it.tokens[0].text = g.raw + it.tokens[0].text;
            it.tokens[0].tokens.unshift(g);
          } else it.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, tokens: [g] });
        } else it.tokens.unshift(g);
      }
    } else if (it.task) it.task = false;
  }
  if (list.loose) for (const it of list.items) {
    it.loose = true;
    for (const tk of it.tokens) if (tk.type === 'text') tk.type = 'paragraph';
  }
  return list;
}
function tokDef(src) {
  const m = R_DEF.exec(src);
  if (!m) return null;
  if (!/^</.test(m[2]) && findParen(m[2], '()') !== -1) return null;
  const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(R_ANY_PUNCT, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(R_ANY_PUNCT, '$1') : m[3];
  return { type: 'def', tag: normLabel(m[1]), raw: rtrimCh(m[0], '\n'), href, title };
}
function tokTable(src, ctx) {
  const m = R_TABLE.exec(src);
  if (!m || !/[:|]/.test(m[2])) return null;
  const header = splitCells(m[1]);
  const aligns = m[2].replace(/^\||\| *$/g, '').split('|');
  const rows = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  const table = { type: 'table', raw: rtrimCh(m[0], '\n'), header: [], align: [], rows: [] };
  if (header.length !== aligns.length) return null;
  for (const a of aligns) {
    if (/^ *-+: *$/.test(a)) table.align.push('right');
    else if (/^ *:-+: *$/.test(a)) table.align.push('center');
    else if (/^ *:-+ *$/.test(a)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < header.length; i++)
    table.header.push({ text: header[i], tokens: queueInline(ctx, header[i]), header: true, align: table.align[i] });
  for (const row of rows)
    table.rows.push(splitCells(row, header.length).map((cell, p) =>
      ({ text: cell, tokens: queueInline(ctx, cell), header: false, align: table.align[p] })));
  return table;
}
function tokLheading(src, ctx) {
  const m = R_LHEADING.exec(src);
  if (!m) return null;
  const text = m[1].trim();
  return { type: 'heading', raw: rtrimCh(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2,
    text, tokens: queueInline(ctx, text) };
}
function tokParagraph(src, ctx) {
  const m = R_PARA.exec(src);
  if (!m) return null;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { type: 'paragraph', raw: m[0], text, tokens: queueInline(ctx, text) };
}
function tokText(src, ctx) {
  const m = R_TEXT.exec(src);
  if (!m) return null;
  return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(ctx, m[0]) };
}

// Necessary conditions for the expensive table / setext-heading regexes.
const RE_LH_GUARD = /\n {0,3}(=+|-+)[ \t]*(?:\n|$)/;
function tableGuard(src) { // delimiter line (2nd line) must hold - and : or |
  const nl1 = src.indexOf('\n');
  if (nl1 === -1) return false;
  const nl2 = src.indexOf('\n', nl1 + 1);
  const line2 = nl2 === -1 ? src.slice(nl1 + 1) : src.slice(nl1 + 1, nl2);
  return line2.includes('-') && (line2.includes('|') || line2.includes(':'));
}
// ---- block driver: lex src into tokens; inline work is queued, not run yet ----
function blockTokens(src, tokens, ctx, nested) {
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let r;
    if (r = tokSpace(src)) {
      src = src.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (r.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(r);
      continue;
    }
    if (r = tokCode(src)) {
      src = src.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else tokens.push(r);
      continue;
    }
    if (r = tokFences(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokHeading(src, ctx)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokHr(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokBlockquote(src, ctx)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokList(src, ctx)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokHtml(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokDef(src)) {
      src = src.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.raw;
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        if (!ctx.links[r.tag]) ctx.links[r.tag] = { href: r.href, title: r.title };
        tokens.push(r);
      }
      continue;
    }
    if (tableGuard(src) && (r = tokTable(src, ctx))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
    if (RE_LH_GUARD.test(src) && (r = tokLheading(src, ctx))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
    if (ctx.top && (r = tokParagraph(src, ctx))) {
      const prev = tokens[tokens.length - 1];
      if (nested && prev?.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else tokens.push(r);
      nested = false;
      src = src.substring(r.raw.length);
      continue;
    }
    if (r = tokText(src, ctx)) {
      src = src.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else tokens.push(r);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
  return tokens;
}

// ---- inline tokenizers, part 1 ----
const RE_START_A = /^<a /i, RE_END_A = /^<\/a>/i;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i, RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_OUT_LINK = /\\([\[\]])/g;

function tokEscape(src) {
  const m = R_ESCAPE.exec(src);
  return m ? { type: 'escape', raw: m[0], text: m[1] } : null;
}
function tokTag(src, ctx) {
  const m = R_TAG.exec(src);
  if (!m) return null;
  if (!ctx.inLink && RE_START_A.test(m[0])) ctx.inLink = true;
  else if (ctx.inLink && RE_END_A.test(m[0])) ctx.inLink = false;
  if (!ctx.inRawBlock && RE_START_PRE.test(m[0])) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && RE_END_PRE.test(m[0])) ctx.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: ctx.inLink, inRawBlock: ctx.inRawBlock, block: false, text: m[0] };
}
function linkHasTag(src, label, off) { // label hides a tag/autolink running past its end?
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = R_CODE_SPAN.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(off + i);
    const m = R_TAG.exec(rest) || R_AUTOLINK.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}
function makeLink(m, ref, raw, ctx) { // build a link/image token, parsing its text inline
  const isImg = m[0].charAt(0) === '!';
  const text = m[1].replace(RE_OUT_LINK, '$1');
  const savedLink = ctx.inLink, savedEmitted = ctx.linkEmitted, savedRaw = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const tokens = inlineTokens(text, ctx, []);
  const emitted = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedLink;
  if (!isImg) {
    if (emitted) { ctx.inRawBlock = savedRaw; return null; }
    ctx.linkEmitted = true;
  }
  return { type: isImg ? 'image' : 'link', raw, href: ref.href, title: ref.title || null, text, tokens };
}
function tokLink(src, ctx) {
  if (ctx.linkParenPossible === false) return null;
  const m = R_LINK.exec(src);
  if (!m) return null;
  const off = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkHasTag(src, m[1], off)) return null;
  const s = m[2].trim();
  if (/^</.test(s)) {
    if (!/>$/.test(s)) return null;
    const stripped = rtrimCh(s.slice(0, -1), '\\');
    if ((s.length - stripped.length) % 2 === 0) return null;
  } else {
    const p = findParen(m[2], '()');
    if (p === -2) return null;
    if (p > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + p;
      m[2] = m[2].substring(0, p);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const r = rtrimCh(m[0].slice(0, -1), '\\');
  if ((m[0].length - r.length) % 2 === 0) return null;
  const title = m[3] ? m[3].slice(1, -1) : '';
  let href = m[2].trim();
  if (/^</.test(href)) href = href.slice(1, -1);
  return makeLink(m, {
    href: href && href.replace(R_ANY_PUNCT, '$1'),
    title: title && title.replace(R_ANY_PUNCT, '$1')
  }, m[0], ctx);
}
function tokReflink(src, ctx) {
  const m = R_REFLINK.exec(src) || R_NOLINK.exec(src);
  if (!m) return null;
  const off = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkHasTag(src, m[1], off)) return null;
  const ref = ctx.links[normLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return makeLink(m, ref, m[0], ctx);
}
function tokCodespan(src) {
  const m = R_CODE_SPAN.exec(src);
  if (!m) return null;
  let text = m[2].replace(/\n/g, ' ');
  if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: m[0], text };
}
function tokBr(src) {
  const m = R_BR.exec(src);
  return m ? { type: 'br', raw: m[0] } : null;
}
function tokInlineText(src, ctx) {
  const len = textRunLen(src);
  if (len === 0) return null;
  const raw = src.slice(0, len);
  const inRaw = ctx.inRawBlock;
  return { type: 'text', raw, text: inRaw ? raw : unescNum(raw), escaped: inRaw };
}
// Length of the next plain-text run, replicating the inline text regex's stops:
// any of \ < ! [ ` * ~ _ (with _ only mattering as a stop char), www. (when
// preceded by start/space/*/_/~/(), http(s)/ftp://, an email's local-part start,
// a hard break (2+ spaces + newline, token ends at the space run), or end.
const RE_TEXT_NEXT = /[*_~`\[\\<>!@]|www\.|:\/\/|  \n/g;
const EMAIL_LOCAL_TBL = new Uint8Array(128);
for (const _c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?_`{|}~-") EMAIL_LOCAL_TBL[_c.charCodeAt(0)] = 1;
function textRunLen(src) {
  const n = src.length;
  if (n === 0) return 0;
  const c0 = src.charCodeAt(0);
  if ((c0 < 48 || (c0 > 57 && c0 < 65) || (c0 > 90 && c0 < 97) || c0 > 122)
    && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) return 1;
  let i = 0;
  const ch0 = src[0];
  if (ch0 === '`' || ch0 === '~') { while (i < n && src[i] === ch0) i++; }
  else i = 1;
  // Stop right after the first char when an email local part + @ starts there.
  let j = i;
  while (j < n && src.charCodeAt(j) < 128 && EMAIL_LOCAL_TBL[src.charCodeAt(j)] === 1) j++;
  if (j > i && src[j] === '@') return i;
  RE_TEXT_NEXT.lastIndex = i;
  let m;
  while ((m = RE_TEXT_NEXT.exec(src)) !== null) {
    const idx = m.index, hit = m[0];
    if (hit === 'www.') {
      if (idx === 0 || src[idx - 1] === ' ' || src[idx - 1] === '\t' || src[idx - 1] === '\n'
        || src[idx - 1] === '*' || src[idx - 1] === '_' || src[idx - 1] === '~' || src[idx - 1] === '(') return idx;
      RE_TEXT_NEXT.lastIndex = idx + 4;
      continue;
    }
    if (hit === '://') {
      let j = idx - 1;
      while (j >= 0) {
        const c = src.charCodeAt(j);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) j--;
        else break;
      }
      const run = src.slice(j + 1, idx).toLowerCase();
      let pstart = -1;
      if (run.endsWith('https')) pstart = idx - 5;
      else if (run.endsWith('http')) pstart = idx - 4;
      else if (run.endsWith('ftp')) pstart = idx - 3;
      if (pstart >= i) return pstart;
      RE_TEXT_NEXT.lastIndex = idx + 3;
      continue;
    }
    if (hit === '  \n') {
      let s = idx;
      while (s > 0 && src[s - 1] === ' ') s--;
      if (s < i) { RE_TEXT_NEXT.lastIndex = idx + 3; continue; }
      return s;
    }
    if (hit === '@') {
      let j = idx - 1;
      while (j >= 0 && src.charCodeAt(j) < 128 && EMAIL_LOCAL_TBL[src.charCodeAt(j)] === 1) j--;
      j++;
      if (j > i && j < idx) return j;
      RE_TEXT_NEXT.lastIndex = idx + 1;
      continue;
    }
    return idx;
  }
  return n;
}

// ---- inline tokenizers, part 2: emphasis, strikethrough, autolinks ----
function scanDelims(src) { // last *-/_-run and ~-run starts not preceded by whitespace
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < n && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else em[ch] = i;
    }
    i = j - 1;
  }
  return { src, em, del };
}
function lastEm(ctx, src, delim) {
  const top = ctx.masks[ctx.masks.length - 1];
  return top && top.src === src ? top.em[delim] : scanDelims(src).em[delim];
}
function lastDel(ctx, src) {
  const top = ctx.masks[ctx.masks.length - 1];
  return top && top.src === src ? top.del : scanDelims(src).del;
}
function maskReflinks(src, ctx) { // hide link labels so emphasis cannot span them
  return src.replace(R_REFLINK_SEARCH, (r) => {
    const o = r.lastIndexOf('[');
    if (!Object.hasOwn(ctx.links, normLabel(r.slice(o + 1, -1)))) return r;
    if (o > 1 && r.charAt(0) !== '!') {
      const inner = r.slice(1, o - 1);
      if (linkInText(inner, ctx)) return '[' + maskReflinks(inner, ctx) + '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
    return '[' + 'a'.repeat(r.length - 2) + ']';
  });
}
function maskInline(src, ctx) { // length-preserving mask of links, code spans, tags, \punct
  let t = src;
  if (ctx.links && src.includes('[')) t = maskReflinks(t, ctx);
  if (src.includes('`') || src.includes('\\')) t = t.replace(R_ANY_PUNCT_CODE, (n, s, r) => r ? '+'.repeat(n.length)
    : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  if (src.includes('`') || src.includes('<') || src.includes('[')) t = t.replace(R_BLOCK_SKIP, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}
function linkInText(src, ctx) { // does this text contain a link (for masking decisions)?
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(R_BLOCK_SKIP)) {
    if (R_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(R_REFLINK_SEARCH)) {
    const s = m[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(ctx.links, normLabel(s.slice(r + 1, -1))))
      && !(r > 1 && linkInText(s.slice(1, r - 1), ctx))) return true;
  }
  return false;
}
const RE_ALPHA_NUM = /[\p{L}\p{N}]/u;
function tokEmStrong(src, masked, prev, ctx) {
  const m = R_EM_L.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const samePrev = prev === delim;
  const i = masked.length - src.length;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!R_PUNCT_CHECK.exec(p);
  if (l < i) prev = p;
  const u = l < i ? h : !!R_PUNCT_CHECK.exec(prev);
  if (m[4] && RE_ALPHA_NUM.test(prev)) return null;
  const d = m[1] || m[3] || '';
  if (!d || !prev || u) {
    const k = [...m[0]].length - 1;
    let open = k, extra = 0;
    const y = i - l + k;
    const canClose = !!p.trim() && (!!d || (delim === '*' && !h));
    if (delim !== '*' && delim !== '_') return null;
    const closerRe = delim === '*' ? R_EM_R_AST : R_EM_R_UND;
    const v = lastEm(ctx, masked, delim);
    const q = masked.length - src.length + k;
    if (v < q) return null;
    const rest = masked.slice(-src.length + k);
    const limit = v - q;
    closerRe.lastIndex = 0;
    let cm;
    while ((cm = closerRe.exec(rest)) !== null && !(cm.index > limit)) {
      const g = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
      if (!g) continue;
      const b = [...g].length;
      if (cm[3] || cm[4]) { open += b; continue; }
      else if (cm[5] || cm[6] || canClose) {
        if (samePrev && (cm[5] || cm[6])) break;
        if (y % 3 && !((y + b) % 3)) { extra += b; continue; }
      }
      open -= b;
      if (open > 0) continue;
      const bl = Math.min(b, b + open + extra);
      const te = [...cm[0]][0].length;
      const raw = src.slice(0, k + cm.index + te + bl);
      if (Math.min(k, bl) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: inlineTokens(inner, ctx, []) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: inlineTokens(inner, ctx, []) };
    }
  }
  return null;
}
function tokDel(src, masked, prev, ctx) {
  const m = R_DEL_L.exec(src);
  if (!m) return null;
  if (!m[1] && prev && !R_PUNCT_CHECK.exec(prev)) return null;
  const o = [...m[0]].length - 1;
  let p = o;
  const u = lastDel(ctx, masked);
  const d = masked.length - src.length + o;
  if (u < d) return null;
  const rest = masked.slice(-src.length + o);
  const limit = u - d;
  R_DEL_R.lastIndex = 0;
  let cm;
  while ((cm = R_DEL_R.exec(rest)) !== null && !(cm.index > limit)) {
    const g = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
    if (!g) continue;
    const l = [...g].length;
    if (l !== o) continue;
    if (cm[3] || cm[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    const bl = Math.min(l, l + p);
    const te = [...cm[0]][0].length;
    const raw = src.slice(0, o + cm.index + te + bl);
    const inner = raw.slice(o, -o);
    return { type: 'del', raw, text: inner, tokens: inlineTokens(inner, ctx, []) };
  }
  return null;
}
function tokAutolink(src) {
  const m = R_AUTOLINK.exec(src);
  if (!m) return null;
  const text = m[1];
  const href = m[2] === '@' ? 'mailto:' + text : text;
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}
function tokUrl(src) {
  const m = R_URL.exec(src);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') { text = m[0]; href = 'mailto:' + text; }
  else {
    let r;
    do { r = m[0]; m[0] = R_BACKPEDAL.exec(m[0])?.[0] ?? ''; } while (r !== m[0]);
    text = m[0];
    href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

// ---- inline driver ----
const RE_INLINE_SPECIAL = /[*_~`\[\\<]|  \n|\\\n|:\/\/|www\.|@/;
function inlineTokens(src, ctx, tokens) {
  if (!ctx.inRawBlock && src.length > 0 && !RE_INLINE_SPECIAL.test(src)) {
    // plain text: no emphasis, code, links, tags, escapes, breaks or autolinks
    tokens.push({ type: 'text', raw: src, text: unescNum(src), escaped: false });
    return tokens;
  }
  const savedParen = ctx.linkParenPossible;
  ctx.linkParenPossible = savedParen && src.includes(')');
  try {
    const hasEm = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = hasEm ? maskInline(src, ctx) : src;
    ctx.masks.push(hasEm ? scanDelims(masked) : { src: masked, em: { '*': -1, _: -1 }, del: -1 });
    try {
      return inlineLoop(src, masked, ctx, tokens);
    } finally {
      ctx.masks.pop();
    }
  } finally {
    ctx.linkParenPossible = savedParen;
  }
}
function inlineLoop(src, masked, ctx, tokens) {
  let s = false, r = '', guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!s) r = '';
    s = false;
    let tok;
    const c0 = src[0];
    // Dispatch on the first char: each tokenizer can only match from one
    // (or two) starting chars, and the order within a branch is marked's.
    if (c0 === '\\') {
      if (tok = tokEscape(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = tokBr(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (c0 === '<') {
      if (tok = tokTag(src, ctx)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = tokAutolink(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (c0 === '[' || c0 === '!') {
      if (tok = tokLink(src, ctx)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (tok = tokReflink(src, ctx)) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.type === 'text' && prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
    } else if (c0 === '*' || c0 === '_') {
      if (tok = tokEmStrong(src, masked, r, ctx)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (!ctx.inLink && (tok = tokUrl(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (c0 === '`') {
      if (tok = tokCodespan(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (c0 === ' ') {
      if (tok = tokBr(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (c0 === '~') {
      if (tok = tokDel(src, masked, r, ctx)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (!ctx.inLink && (tok = tokUrl(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    } else if (src.charCodeAt(0) < 128 && EMAIL_LOCAL_TBL[src.charCodeAt(0)] === 1) {
      if (!ctx.inLink && (tok = tokUrl(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    }
    if (tok = tokInlineText(src, ctx)) {
      src = src.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') r = tok.raw.slice(-1);
      s = true;
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
      else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

// ---- renderer: tokens -> HTML ----
function renderText(tokens) { // plain-text rendering, used for image alt text
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'strong': case 'em': case 'del': case 'link': case 'image':
        out += t.tokens ? renderText(t.tokens) : t.text;
        break;
      case 'codespan': case 'html': case 'text': case 'escape':
        out += t.text;
        break;
      case 'br': break;
      case 'checkbox': out += t.raw; break;
      default: out += t.text ?? '';
    }
  }
  return out;
}
function renderCell(c) {
  const tag = c.header ? 'th' : 'td';
  return (c.align ? '<' + tag + ' align="' + c.align + '">' : '<' + tag + '>')
    + renderInline(c.tokens) + '</' + tag + '>\n';
}
function renderInline(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape': out += esc(t.text); break;
      case 'html': out += t.text; break;
      case 'link': {
        const inner = t.autolink ? esc(t.text, true) : renderInline(t.tokens);
        const href = hrefEncode(t.href);
        if (href === null) { out += inner; break; }
        out += '<a href="' + esc(href, t.autolink) + '"'
          + (t.title ? ' title="' + esc(t.title) + '"' : '') + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const alt = t.tokens ? renderText(t.tokens) : t.text;
        const href = hrefEncode(t.href);
        if (href === null) { out += esc(alt); break; }
        out += '<img src="' + esc(href) + '" alt="' + esc(alt) + '"'
          + (t.title ? ' title="' + esc(t.title) + '"' : '') + '>';
        break;
      }
      case 'checkbox': out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'strong': out += '<strong>' + renderInline(t.tokens) + '</strong>'; break;
      case 'em': out += '<em>' + renderInline(t.tokens) + '</em>'; break;
      case 'codespan': out += '<code>' + esc(t.text, true) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'del': out += '<del>' + renderInline(t.tokens) + '</del>'; break;
      case 'text':
        out += ('tokens' in t && t.tokens) ? renderInline(t.tokens)
          : ('escaped' in t && t.escaped) ? t.text : esc(t.text);
        break;
      default: throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}
function renderBlock(t) {
  switch (t.type) {
    case 'space': return '';
    case 'hr': return '<hr>\n';
    case 'heading': return '<h' + t.depth + '>' + renderInline(t.tokens) + '</h' + t.depth + '>\n';
    case 'code': {
      const lang = (t.lang || '').match(/^\S*/)[0];
      const text = t.text ? t.text.replace(/\n$/, '') + '\n' : '';
      const body = esc(text, true);
      return lang ? '<pre><code class="language-' + esc(lang) + '">' + body + '</code></pre>\n'
        : '<pre><code>' + body + '</code></pre>\n';
    }
    case 'table': {
      let head = '';
      for (const c of t.header) head += renderCell(c);
      let body = '';
      for (const row of t.rows) {
        let r = '';
        for (const c of row) r += renderCell(c);
        body += '<tr>\n' + r + '</tr>\n';
      }
      if (body) body = '<tbody>' + body + '</tbody>';
      return '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + body + '</table>\n';
    }
    case 'blockquote': return '<blockquote>\n' + renderBlocks(t.tokens) + '</blockquote>\n';
    case 'list': {
      let items = '';
      for (const it of t.items) items += '<li>' + renderBlocks(it.tokens) + '</li>\n';
      const tag = t.ordered ? 'ol' : 'ul';
      const start = t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '';
      return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
    }
    case 'checkbox': return '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    case 'html': return t.text;
    case 'def': return '';
    case 'paragraph': return '<p>' + renderInline(t.tokens) + '</p>\n';
    case 'text':
      return ('tokens' in t && t.tokens) ? renderInline(t.tokens)
        : ('escaped' in t && t.escaped) ? t.text : esc(t.text);
    default: throw new Error('Token with "' + t.type + '" type was not found.');
  }
}
function renderBlocks(tokens) {
  let out = '';
  for (const t of tokens) out += renderBlock(t);
  return out;
}

export function parse(markdown) {
  const ctx = ctxNew();
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const tokens = blockTokens(src, [], ctx, false);
  for (const job of ctx.queue) {
    ctx.inRawBlock = false;
    inlineTokens(job.src, ctx, job.tokens);
  }
  return renderBlocks(tokens);
}
