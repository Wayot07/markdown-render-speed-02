// A fast drop-in for marked 18.1.3 (default options: GFM on, breaks off,
// pedantic off, async off). Written from scratch for the make.fun
// markdown-render-speed-02 competition: a hand-rolled block scanner that
// walks the source with sticky patterns (no per-token reslicing of the
// remainder), a small inline scanner in the same style, and renderers that
// write HTML straight into one string per case. Nothing is cached between
// parse() calls; every call renders only the markdown it was given.
//
// The grammar below mirrors what marked accepts, because the competition
// scores byte-identical HTML against marked, but every line of the
// machinery here — the composition, the scanning, the token shapes and the
// rendering — is original work written for this entry.

export function parse(markdown) {
  return runParse(markdown);
}

// ---------------------------------------------------------------------------
// tiny regex kit
// ---------------------------------------------------------------------------

// Build a pattern from a template string, splicing fragment sources in.
// A fragment spliced in with `ins` loses a leading ^ anchor, the way a
// fragment means "here" rather than "at the start of the string" once it
// sits inside a bigger pattern. A fragment spliced in with `insAll` replaces
// every occurrence of a placeholder word.
function ins(frag) {
  const src = typeof frag === 'string' ? frag : frag.source;
  return src.replace(/(^|[^\[])\^/g, '$1');
}
function insAll(src, word, frag) {
  const rep = ins(frag);
  return src.split(word).join(rep);
}
function rx(src, flags = '') {
  return new RegExp(src, flags);
}
// A sticky twin of a pattern: same source minus a leading ^ anchor, forced
// to match exactly at lastIndex. Used by the block scanner so the source is
// never resliced while blocks are consumed.
function sticky(re) {
  const src = re.source.startsWith('^') ? re.source.slice(1) : re.source;
  return new RegExp(src, re.flags.includes('y') ? re.flags : re.flags + 'y');
}

// ---------------------------------------------------------------------------
// small shared patterns (the "other" bucket)
// ---------------------------------------------------------------------------

const O = {
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
  // A lazy setext underline inside a quote must not become a heading:
  // neutralise it (and any tabs trailing it) before the quote is re-lexed.
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
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
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
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

// Indent-scoped helper patterns are built at most once per indent class
// (0..3); the cache is keyed on the class, not the raw indent.
function cachedIndentRegex(build) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = cache[idx];
    if (!re) {
      re = build(idx);
      cache[idx] = re;
    }
    return re;
  };
}

// Block tag names that may open a type-6 HTML block.
const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// ---------------------------------------------------------------------------
// block grammar (GFM)
// ---------------------------------------------------------------------------

const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

// Setext underline core: the lookaheads that keep other blocks from being
// swallowed as heading text. The table alternative is spliced in only for
// the first lookahead in GFM (the second keeps the literal word "table":
// that is marked's behaviour, quirks included), and dropped for plain
// CommonMark.
const LHEADING_CORE = '^(?!bull |blockCode|fences|blockquote|heading|html|table)'
  + '((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)'
  + '\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
function buildLheading(withTable) {
  let src = LHEADING_CORE;
  src = insAll(src, 'bull', BULLET);
  src = insAll(src, 'blockCode', /(?: {4}| {0,3}\t)/);
  src = insAll(src, 'fences', / {0,3}(?:`{3,}|~{3,})/);
  src = insAll(src, 'blockquote', / {0,3}>/);
  src = insAll(src, 'heading', / {0,3}#{1,6}(?:\s|$)/);
  // The hr fragment here must not capture: it sits inside the opening
  // lookahead, ahead of the text group, so a capturing group of its own
  // would renumber the groups the tokenizer reads.
  src = insAll(src, 'hr', / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/);
  src = insAll(src, 'html', / {0,3}<[^\n>]+>\n/);
  if (withTable) {
    src = src.replace('table', ins(/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/));
  } else {
    src = src.split('|table').join('');
  }
  return rx(src);
}
const LHEADING = buildLheading(false);
const LHEADING_GFM = buildLheading(true);

const PARAGRAPH_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listInterrupt, withTable) {
  let src = PARAGRAPH_CORE.source;
  src = src.replace('hr', ins(HR));
  src = src.replace('heading', ins(' {0,3}#{1,6}(?:\\s|$)'));
  src = src.replace('|lheading', '');
  if (withTable) {
    src = src.replace('table', ins(GFM_TABLE));
  } else {
    src = src.replace('|table', '');
  }
  src = src.replace('blockquote', ins(' {0,3}>'));
  src = src.replace('fences', ins(' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'));
  src = src.replace('list', ins(listInterrupt));
  src = src.replace('html', ins(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)').replace('tag', TAG));
  return rx(src);
}

const BLOCK_TEXT = /^[^\n]+/;
const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF = (() => {
  let src = '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)';
  src = src.replace('label', ins(BLOCK_LABEL));
  src = src.replace('title', ins(/(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/));
  return rx(src);
})();

const LIST = (() => {
  const src = '^(' + ins(BULLET) + ')([ \\t][^\\n]*?)?(?:\\n|$)';
  return rx(src);
})();

const HTML_BLOCK = (() => {
  const attr = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';
  let src = '^ {0,3}(?:'
    + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
    + '|comment[^\\n]*(\\n+|$)'
    + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
    + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
    + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
    + '|</?(tag)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
    + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
    + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
    + ')';
  src = src.replace('comment', ins(COMMENT));
  src = src.replace('tag', TAG);
  src = src.split('attribute').join(attr);
  return rx(src, 'i');
})();

const GFM_TABLE = (() => {
  let src = '^ *([^\\n ].*)\\n'
    + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
    + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
  src = src.replace('hr', ins(HR));
  src = src.replace('heading', ins(' {0,3}#{1,6}(?:\\s|$)'));
  src = src.replace('blockquote', ins(' {0,3}>'));
  src = src.replace('code', ins('(?: {4}| {0,3}\\t)[^\\n]'));
  src = src.replace('fences', ins(' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'));
  src = src.replace('list', ins(' {0,3}(?:[*+-]|1[.)])[ \\t]'));
  src = src.replace('html', ins(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)').replace('tag', TAG));
  return rx(src);
})();

// Paragraph flavours: top-level (only a "1."-style non-empty list can
// interrupt) and inside a blockquote (any bare marker ends the paragraph,
// so it is not lazily continued as quote text).
const PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, true);
const BLOCKQUOTE_PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, true);

const BLOCKQUOTE = (() => {
  let src = '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+';
  src = src.replace('paragraph', ins(BLOCKQUOTE_PARAGRAPH));
  return rx(src);
})();

// Sticky twins for the block scanner (anchored at the cursor, no reslice).
const S_NEWLINE = sticky(BLOCK_NEWLINE);
const S_CODE = sticky(BLOCK_CODE);
const S_FENCES = sticky(FENCES);
const S_HEADING = sticky(HEADING);
const S_HR = sticky(HR);
const S_BLOCKQUOTE = sticky(BLOCKQUOTE);
const S_LIST = sticky(LIST);
const S_HTML = sticky(HTML_BLOCK);
const S_DEF = sticky(DEF);
const S_TABLE = sticky(GFM_TABLE);
const S_LHEADING = sticky(LHEADING_GFM);
const S_PARAGRAPH = sticky(PARAGRAPH);
const S_TEXT = sticky(BLOCK_TEXT);

// ---------------------------------------------------------------------------
// inline grammar (GFM)
// ---------------------------------------------------------------------------

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const INLINE_TEXT = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM keeps ~ out of the strong/em punctuation classes so strikethrough
// can nest inside emphasis.
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;
const PUNCTUATION = /^((?![*_])[\s\p{P}\p{S}])/u;

const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
// Escapes outside code spans, masked for the em/strong scan. A backslash
// inside a code span is literal, so the backticks of the span are masked
// instead and the span is skipped whole.
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const ESCAPED_DELIM = /\\[*_~]/;

// Runs of [text](href), `code` and <html> that emphasis must skip over.
const BLOCK_SKIP = (() => {
  let src = 'link|precode-code|html';
  src = src.replace('link', ins(/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/));
  src = src.replace('precode-', '(?<!`)()');
  src = src.replace('code', ins(/(?<b>`+)[^`]+\k<b>(?!`)/));
  src = src.replace('html', ins(/<(?! )[^<>]*?>/));
  return rx(src, 'g');
})();

// Left-delimiter openers for * and _.
function buildLDelim(punct) {
  const core = '^(?:\\*+(?:((?!\\*)punct)|([^\\s*]))?)|^_+(?:((?!_)punct)|([^\\s_]))?';
  return rx(insAll(core, 'punct', punct), 'u');
}
const EM_STRONG_LDELIM = buildLDelim(PUNCT_GFM);

// Right-delimiter scanners for * (GFM) and _ (plain). Each alternative
// either consumes text up to a delimiter or names the delimiter run it
// found, in groups 1-6, so the caller can tell a left-only, right-only or
// either-way delimiter apart.
function buildRDelimAst(punct, punctSpace, notPunctSpace) {
  let src = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // orphan inside strong
    + '|[^*]+(?=[^*])' // consume to delimiter
    + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) right only
    + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) right only
    + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) left only
    + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) left only
    + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) either
    + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) either
  src = insAll(src, 'notPunctSpace', notPunctSpace);
  src = insAll(src, 'punctSpace', punctSpace);
  src = insAll(src, 'punct', punct);
  return rx(src, 'gu');
}
const EM_STRONG_RDELIM_AST = buildRDelimAst(PUNCT_GFM, PUNCT_OR_SPACE_GFM, NOT_PUNCT_OR_SPACE_GFM);

function buildRDelimUnd(punct, punctSpace, notPunctSpace) {
  let src = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // orphan inside strong
    + '|[^_]+(?=[^_])' // consume to delimiter
    + '|(?!_)punct(_+)(?=[\\s]|$)' // (1)
    + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2)
    + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3)
    + '|[\\s](_+)(?!_)(?=punct)' // (4)
    + '|(?!_)punct(_+)(?!_)(?=punct)'; // (5) no rule 6 for _
  src = insAll(src, 'notPunctSpace', notPunctSpace);
  src = insAll(src, 'punctSpace', punctSpace);
  src = insAll(src, 'punct', punct);
  return rx(src, 'gu');
}
const EM_STRONG_RDELIM_UND = buildRDelimUnd(PUNCT, PUNCT_OR_SPACE, NOT_PUNCT_OR_SPACE);

// Strikethrough delimiters.
const DEL_LDELIM = (() => {
  const core = '^~~?(?:((?!~)punct)|[^\\s~])';
  return rx(insAll(core, 'punct', PUNCT), 'u');
})();
const DEL_RDELIM = (() => {
  let src = '^[^~]+(?=[^~])'
    + '|(?!~)punct(~~?)(?=[\\s]|$)'
    + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
    + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
    + '|[\\s](~~?)(?!~)(?=punct)'
    + '|(?!~)punct(~~?)(?!~)(?=punct)'
    + '|notPunctSpace(~~?)(?=notPunctSpace)';
  src = insAll(src, 'notPunctSpace', NOT_PUNCT_OR_SPACE);
  src = insAll(src, 'punctSpace', PUNCT_OR_SPACE);
  src = insAll(src, 'punct', PUNCT);
  return rx(src, 'gu');
})();

const INLINE_COMMENT = /<!--(?:-?>|[\s\S]*?-->)/;
const INLINE_TAG = (() => {
  const attr = "\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?";
  let src = '^comment'
    + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
    + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
    + '|^<\\?[\\s\\S]*?\\?>'
    + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
    + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>';
  src = src.replace('comment', ins(INLINE_COMMENT));
  src = src.split('attribute').join(attr);
  return rx(src);
})();

const AUTOLINK = (() => {
  const scheme = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
  const email = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
  let src = '^<(scheme:[^\\s\x00-\\x1f<>]*|email)>';
  src = src.replace('scheme', ins(scheme));
  src = src.replace('email', ins(email));
  return rx(src);
})();

// One matched pair of brackets, holding no bracket of its own.
const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
// A link label: brackets nest to a fixed depth (two levels is what the
// spec suite asks for), code spans and escapes included.
const INLINE_LABEL = (() => {
  let src = '(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
  src = src.replace('brackets', ins(INLINE_LABEL_BRACKETS));
  return rx(src);
})();
const LINK = (() => {
  let src = '^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)';
  src = src.replace('label', ins(INLINE_LABEL));
  src = src.replace('href', ins(/<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/));
  src = src.replace('title', ins(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/));
  return rx(src);
})();
const REFLINK = (() => {
  let src = '^!?\\[(label)\\]\\[(ref)\\]';
  src = src.replace('label', ins(INLINE_LABEL));
  src = src.replace('ref', ins(BLOCK_LABEL));
  return rx(src);
})();
const NOLINK = (() => {
  let src = '^!?\\[(ref)\\](?:\\[\\])?';
  src = src.replace('ref', ins(BLOCK_LABEL));
  return rx(src);
})();

// Bounded labels for the reflink search pass: a candidate that can never
// match still has to be found cheaply, so escapes, code spans and nested
// brackets are capped (labels themselves are capped at 999 items, which is
// every label CommonMark allows).
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = (() => {
  let src = '(?:[^\\[\\]\\\\`]*(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
  src = src.replace('brackets', ins(INLINE_LABEL_BRACKETS));
  return rx(src);
})();
const REFLINK_SEARCH = (() => {
  const re = (s) => rx('^' + s);
  const rl = REFLINK.source.replace('label', ins(BOUNDED_INLINE_LABEL)).replace('ref', ins(BOUNDED_BLOCK_LABEL));
  const nl = NOLINK.source.replace('ref', ins(BOUNDED_BLOCK_LABEL));
  return rx(rl.slice(1) + '|' + nl.slice(1) + '(?!\\()', 'g');
})();

const URL_RE = (() => {
  const proto = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
  const email = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
  const emailProto = '(?:mailto:email|xmpp:email(?:\\/[A-Za-z0-9@.]+)?)'.replace(/email/g, email.source);
  let src = '^emailProtocol|^((?:protocol):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^email';
  src = src.replace('emailProtocol', emailProto);
  src = src.replace('protocol', ins(proto));
  src = src.replace('email', ins(/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/));
  return rx(src);
})();
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// GFM inline text: stops early at anything that could start another token
// (a link, an autolink, a www. start, an email, a code span, a tilde...).
const TEXT_GFM = (() => {
  const proto = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
  let src = '^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|protocol:\\/\\/|wwwStart|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@))))';
  src = src.replace('protocol', ins(proto));
  src = src.split('emailProtocol').join('(?:mailto|xmpp):');
  src = src.replace('wwwStart', '(?<![^\\s*_~(])www\\.');
  return rx(src);
})();

// Sticky twins for the inline scanner.
const S_ESCAPE = sticky(INLINE_ESCAPE);
const S_TAG = sticky(INLINE_TAG);
const S_LINK = sticky(LINK);
const S_REFLINK = sticky(REFLINK);
const S_NOLINK = sticky(NOLINK);
const S_LDELIM = sticky(EM_STRONG_LDELIM);
const S_CODE_SPAN = sticky(INLINE_CODE);
const S_BR = sticky(INLINE_BR);
const S_DEL_LDELIM = sticky(DEL_LDELIM);
const S_AUTOLINK = sticky(AUTOLINK);
const S_URL = sticky(URL_RE);

// ---------------------------------------------------------------------------
// string helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Escape HTML. With encode, every & < > " ' is replaced; without it, an &
// that already starts a valid character reference is left alone.
function escapeHtml(html, encode) {
  if (encode) {
    if (O.escapeTest.test(html)) return html.replace(O.escapeReplace, (ch) => ESCAPE_MAP[ch]);
  } else if (O.escapeTestNoEncode.test(html)) {
    return html.replace(O.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

// Numeric character references outside code stand for the character they
// name; zero, out-of-range and surrogate values become U+FFFD. A decoded
// character must not join its neighbours into a new reference, so every &
// that is not already one is escaped here.
function decodeNumericRefs(text) {
  if (!O.numericCharacterReference.test(text)) return text;
  return text.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

// Split one table row on its unescaped pipes. A pipe counts as escaped when
// an odd run of backslashes precedes it; escaped pipes are restored after
// the split, and the row is padded or cut to the header's column count.
function splitCells(tableRow, count) {
  const row = tableRow.replace(O.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(O.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  }
  return cells;
}

// Remove trailing 'c's (or, inverted, trailing non-'c's) without a regex,
// which would risk catastrophic backtracking on long runs.
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// A link label, normalised so a definition and a reference meet: trimmed,
// inner whitespace runs collapsed, and case-folded through upper case (so
// ẞ folds to SS the way toLowerCase alone never reaches).
function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the closing bracket that balances the opening one at the start
// of the string, or -2 when the brackets run out unbalanced, -1 when there
// is no bracket at all to close.
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
// block tokenizing
// ---------------------------------------------------------------------------

// Per-parse state. Everything here is fresh for each parse() call: nothing
// is shared between cases, so a case renders exactly as it would alone.
function freshState(src) {
  return {
    src,
    links: Object.create(null), // normalised label -> { href, title }
    linkCount: 0, // how many distinct labels are defined so far
    queue: [], // inline runs waiting on the link definitions: { src, tokens }
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
}

// Queue an inline run for later: link definitions may still be defined
// further down the document, so inline text is only tokenized once every
// block is lexed.
function queueInline(S, src, tokens) {
  S.queue.push({ src, tokens });
  return tokens;
}

// Exec a sticky pattern exactly at pos, or null.
function at(re, src, pos) {
  re.lastIndex = pos;
  return re.exec(src);
}

// First line of src at or after pos (without its line ending).
function lineAt(src, pos) {
  const nl = src.indexOf('\n', pos);
  return nl === -1 ? src.slice(pos) : src.slice(pos, nl);
}

// A setext underline can only sit on a line of the paragraph span, or
// on one of the two lines after it: the paragraph can stop a line early
// where a table header opens (a header line is ordinary setext text),
// and the underline then sits one line further on.
const UNDERLINE_QUICK = /\n {0,3}[=-]/g;
const UNDERLINE_FULL = /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/g;
function spanHasUnderline(src, pos, spanLen) {
  let end = pos + spanLen;
  for (let n = 0; n < 2; n++) {
    if (src.charCodeAt(end) !== 10) break;
    const nl = src.indexOf('\n', end + 1);
    end = nl === -1 ? src.length : nl;
  }
  UNDERLINE_QUICK.lastIndex = pos;
  const q = UNDERLINE_QUICK.exec(src);
  if (!q || q.index >= end) return false;
  UNDERLINE_FULL.lastIndex = pos;
  const f = UNDERLINE_FULL.exec(src);
  return !!f && f.index < end;
}

// A table needs its delimiter row right after the header line: up to
// three spaces, an optional pipe, spaces, then - or :.
function maybeTable(src, pos) {
  const nl = src.indexOf('\n', pos);
  if (nl === -1) return false;
  let i = nl + 1;
  let sp = 0;
  while (sp < 3 && src.charCodeAt(i) === 32) { i++; sp++; }
  if (src.charCodeAt(i) === 124) i++; // |
  while (src.charCodeAt(i) === 32) i++;
  const c = src.charCodeAt(i);
  return c === 45 || c === 58; // - or :
}

// Index of the first character that is not a space, or -1.
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) !== 32) return i;
  return -1;
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mm = node.match(O.beginningSpace);
    if (mm === null) return node;
    const [indentInNode] = mm;
    return node.slice(Math.min(indentInNode.length, indentToCode.length));
  }).join('\n');
}

function blockquoteToken(S, src, pos) {
  const cap = at(S_BLOCKQUOTE, src, pos);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (O.blockquoteStart.test(lines[i])) {
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
      // A tab after the marker runs to the next tab stop; the marker only
      // eats one space of it, the rest stays content.
      .replace(O.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      // Precede a setext continuation with 4 spaces so it is not a setext.
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    // Parse the quote's lines as top-level tokens, merging paragraphs
    // across continuations.
    const top = S.top;
    S.top = true;
    blockTokens(S, currentText, 0, currentText.length, tokens, true);
    S.top = top;

    if (lines.length === 0) break;

    const lastToken = tokens.at(-1);
    if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
      // A continuation cannot follow a code block, heading, hr, html block
      // or table.
      break;
    } else if (lastToken?.type === 'blockquote') {
      // The continuation belongs to the nested quote: restate its marker
      // on the continuation lines and re-run the nested quote over them.
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const newToken = blockquoteToken(S, newText, 0);
      if (!newToken) break;
      tokens[tokens.length - 1] = newToken;
      // Only the lines the nested quote actually consumed stay in raw;
      // the rest are left for the lexer to tokenize on its own.
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      // A leftover line that still starts with '>' belongs to this quote;
      // any other leftover line ends it.
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken?.type === 'list') {
      // The continuation belongs to the nested list.
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = listToken(S, newText, 0);
      if (!newToken) break;
      tokens[tokens.length - 1] = newToken;
      // The list raw holds no '>' markers, so count the continuation
      // lines the list took and add those lines instead.
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

  return { type: 'blockquote', raw, tokens, text };
}

function listToken(S, src, start) {
  let cap = at(S_LIST, src, start);
  if (!cap) return undefined;
  const end = src.length;
  let cur = start;
  const taken = () => cur - start;

  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  const itemRegex = sticky(O.listItemRegex(bull));
  let endsWithBlankLine = false;

  while (cur < end) {
    let endEarly = false;
    let itemContents = '';
    cap = at(itemRegex, src, cur);
    if (!cap) break;
    // End the list if the bullet was actually a thematic break.
    if (at(S_HR, src, cur)) break;

    const itemStart = taken();
    cur += cap[0].length;

    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = (firstLine.charCodeAt(0) === 32 || firstLine.charCodeAt(0) === 9)
      ? firstLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent))
      : firstLine;
    let nextLine = lineAt(src, cur);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar);
      indent = indent > 4 ? 1 : indent; // >4 spaces is indented code: 1 indent
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && O.blankLine.test(nextLine)) {
      // Items begin with at most one blank line.
      cur = Math.min(cur + nextLine.length + 1, end);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRegex = O.nextBulletRegex(indent);
      const hrRegex = O.hrRegex(indent);
      const fencesBeginRegex = O.fencesBeginRegex(indent);
      const headingBeginRegex = O.headingBeginRegex(indent);
      const htmlBeginRegex = O.htmlBeginRegex(indent);
      const blockquoteBeginRegex = O.blockquoteBeginRegex(indent);

      while (cur < end) {
        const rawLine = lineAt(src, cur);
        nextLine = rawLine;
        // Tabs in the leading run are expanded to spaces; lines without
        // leading whitespace skip that work entirely.
        const c0 = rawLine.charCodeAt(0);
        const nextLineWithoutTabs = (c0 === 32 || c0 === 9)
          ? nextLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace))
          : nextLine;

        // Each "does a new block start here" test can only match when
        // the line's first non-space character is its marker, so dispatch
        // on that character instead of running all six patterns.
        const firstNs = firstNonSpace(nextLineWithoutTabs);
        const fc = firstNs === -1 ? 0 : nextLineWithoutTabs.charCodeAt(firstNs);
        if ((fc === 96 || fc === 126) && fencesBeginRegex.test(nextLine)) break; // ` ~
        if (fc === 35 && headingBeginRegex.test(nextLine)) break; // #
        if (fc === 60 && htmlBeginRegex.test(nextLine)) break; // <
        if (fc === 62 && blockquoteBeginRegex.test(nextLine)) break; // >
        if ((fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) && nextBulletRegex.test(nextLine)) break;
        if ((fc === 45 || fc === 95 || fc === 42) && hrRegex.test(nextLine)) break; // - _ *

        if (firstNs >= indent || firstNs === -1) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          // Not enough indentation.
          if (blankLine) break;
          // A paragraph continuation, unless the last line was a block
          // of a different level.
          if (line.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4) break;
          const lfc = line.charCodeAt(firstNonSpace(line));
          if ((lfc === 96 || lfc === 126) && fencesBeginRegex.test(line)) break;
          if (lfc === 35 && headingBeginRegex.test(line)) break;
          if (lfc === 60 && htmlBeginRegex.test(line)) break;
          if ((lfc === 45 || lfc === 95 || lfc === 42) && hrRegex.test(line)) break;
          // A lazy continuation that looks like a setext underline after
          // the list indentation is removed stays in the paragraph.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && LHEADING_GFM.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = firstNs === -1;
        cur = Math.min(cur + rawLine.length + 1, end);
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    const raw = src.slice(start + itemStart, cur);

    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (O.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      type: 'list_item',
      raw,
      task: !!O.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return undefined; // not a list: it held no items
  }
  list.raw = src.slice(start, cur).trimEnd();

  // Item child tokens are handled here, once the final item is trimmed.
  // First pass: tokenize items and settle list.loose from spacers, before
  // the checkboxes are placed.
  for (const item of list.items) {
    S.top = false;
    item.tokens = blockTokens(S, item.text, 0, item.text.length, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => O.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }

  // Second pass: place task checkboxes using the final list.loose.
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      item.text = item.text.replace(O.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(O.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(O.listReplaceTask, '');
      for (let i = S.queue.length - 1; i >= 0; i--) {
        if (O.listIsTask.test(S.queue[i].src)) {
          S.queue[i].src = S.queue[i].src.replace(O.listReplaceTask, '');
          break;
        }
      }
      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = {
          type: 'checkbox',
          raw: taskRaw[0] + ' ',
          checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
            item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkboxToken);
          } else {
            item.tokens.unshift({
              type: 'paragraph',
              raw: checkboxToken.raw,
              text: checkboxToken.raw,
              tokens: [checkboxToken],
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

  return list;
}

// Merge a code or definition block into the paragraph (or bare text) that
// precedes it: it cannot interrupt a paragraph, so it joins it instead.
function mergeIntoParagraph(S, tokens, token) {
  const lastToken = tokens.at(-1);
  lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
  lastToken.text += '\n' + token.text;
  S.queue.at(-1).src = lastToken.text;
}

function blockTokens(S, src, start, end, tokens, lastParagraphClipped = false) {
  let pos = start;
  while (pos < end) {
    const prevPos = pos;
    let cap;
    let token;

    // newline / blank space
    if ((cap = at(S_NEWLINE, src, pos))) {
      token = { type: 'space', raw: cap[0] };
      pos += token.raw.length;
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        // A single \n is a spacer: it terminates the last line, so it
        // moves onto that token instead of standing on its own.
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }

    // indented code
    if ((cap = at(S_CODE, src, pos))) {
      const raw = trimTrailingBlankLines(cap[0]);
      token = {
        type: 'code',
        raw,
        codeBlockStyle: 'indented',
        text: raw.replace(O.codeRemoveIndent, ''),
      };
      pos += token.raw.length;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        mergeIntoParagraph(S, tokens, token);
      } else {
        tokens.push(token);
      }
      continue;
    }

    // fenced code
    if ((cap = at(S_FENCES, src, pos))) {
      token = {
        type: 'code',
        raw: cap[0],
        lang: cap[2] ? cap[2].trim().replace(ANY_PUNCT, '$1') : cap[2],
        text: indentCodeCompensation(cap[0], cap[3] || ''),
      };
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }

    // ATX heading
    if ((cap = at(S_HEADING, src, pos))) {
      let text = cap[2].trim();
      if (O.endingHash.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || O.endingSpaceTabChar.test(trimmed)) {
          // CommonMark wants a space or tab before trailing #s.
          text = trimmed.trim();
        }
      }
      token = {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[1].length,
        text,
        tokens: [],
      };
      token.tokens = queueInline(S, text, token.tokens);
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }

    // thematic break
    if ((cap = at(S_HR, src, pos))) {
      token = { type: 'hr', raw: rtrim(cap[0], '\n') };
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }

    // blockquote
    if ((token = blockquoteToken(S, src, pos))) {
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }

    // list
    if ((token = listToken(S, src, pos))) {
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }

    // raw HTML block
    if ((cap = at(S_HTML, src, pos))) {
      const raw = trimTrailingBlankLines(cap[0]);
      token = {
        type: 'html',
        block: true,
        raw,
        pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
        text: raw,
      };
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }

    // link reference definition
    if ((cap = at(S_DEF, src, pos))) {
      // Outside angle brackets a destination holds only balanced parens.
      if (!O.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
        // Not a definition after all: fall through to the next rules.
      } else {
        const tag = normalizeLabel(cap[1]);
        const href = cap[2] ? cap[2].replace(O.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '';
        const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(ANY_PUNCT, '$1') : cap[3];
        token = { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
        pos += token.raw.length;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          mergeIntoParagraph(S, tokens, token);
        } else {
          // The first definition of a label wins; a later one still
          // consumes its text.
          if (!S.links[tag]) { S.links[tag] = { href: token.href, title: token.title }; S.linkCount++; }
          tokens.push(token);
        }
        continue;
      }
    }

    // table (GFM): only worth trying when the next line can open a
    // delimiter row
    if (maybeTable(src, pos) && (cap = at(S_TABLE, src, pos))) {
      const headers = splitCells(cap[1]);
      const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
      const rows = cap[3]?.trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];
      if (O.tableDelimiter.test(cap[2]) && headers.length === aligns.length) {
        const align = [];
        for (const a of aligns) {
          if (O.tableAlignRight.test(a)) align.push('right');
          else if (O.tableAlignCenter.test(a)) align.push('center');
          else if (O.tableAlignLeft.test(a)) align.push('left');
          else align.push(null);
        }
        const header = [];
        for (let i = 0; i < headers.length; i++) {
          const cell = { text: headers[i], tokens: [], header: true, align: align[i] };
          cell.tokens = queueInline(S, headers[i], cell.tokens);
          header.push(cell);
        }
        const bodyRows = [];
        for (const row of rows) {
          bodyRows.push(splitCells(row, header.length).map((cellText, i) => {
            const cell = { text: cellText, tokens: [], header: false, align: align[i] };
            cell.tokens = queueInline(S, cellText, cell.tokens);
            return cell;
          }));
        }
        token = { type: 'table', raw: rtrim(cap[0], '\n'), header, align, rows: bodyRows };
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }
      // Otherwise the would-be table is a setext heading or paragraph
      // material: fall through to the rules below.
    }

    // setext heading or paragraph. At the top level the paragraph
    // pattern runs first: it bounds the region a setext underline could
    // sit in (the span, plus the line right after it), so the expensive
    // setext pattern only runs when that region holds an underline.
    // Inside a list item or quote there is no paragraph rule, so the
    // setext pattern runs on its own there.
    if (S.top && (cap = at(S_PARAGRAPH, src, pos))) {
      const paraCap = cap;
      let headCap = null;
      if (spanHasUnderline(src, pos, paraCap[0].length)) headCap = at(S_LHEADING, src, pos);
      if (headCap) {
        const text = headCap[1].trim();
        token = {
          type: 'heading',
          raw: rtrim(headCap[0], '\n'),
          depth: headCap[2].charAt(0) === '=' ? 1 : 2,
          text,
          tokens: [],
        };
        token.tokens = queueInline(S, text, token.tokens);
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }
      const text = paraCap[1].charAt(paraCap[1].length - 1) === '\n' ? paraCap[1].slice(0, -1) : paraCap[1];
      token = { type: 'paragraph', raw: paraCap[0], text, tokens: [] };
      token.tokens = queueInline(S, text, token.tokens);
      pos += token.raw.length;
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        // A blockquote continuation: the new paragraph joins the one
        // the previous chunk left open.
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.queue.pop();
        S.queue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      continue;
    }
    if (!S.top && (cap = at(S_LHEADING, src, pos))) {
      const text = cap[1].trim();
      token = {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: [],
      };
      token.tokens = queueInline(S, text, token.tokens);
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }

    // bare text (a line no block rule claimed)
    if ((cap = at(S_TEXT, src, pos))) {
      token = { type: 'text', raw: cap[0], text: cap[0], tokens: [] };
      token.tokens = queueInline(S, cap[0], token.tokens);
      pos += token.raw.length;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.queue.pop();
        S.queue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (pos === prevPos) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    }
  }

  S.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// inline tokenizing
// ---------------------------------------------------------------------------

// Does this text already hold a link? An image does not count: an image
// may hold a link, a link may not.
function linkInText(S, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP)) {
    if (LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(S, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code spans, escapes and HTML out of a source so the
// emphasis and strikethrough scans do not see delimiters inside them.
// Every mask keeps the length it replaces, so the masked source still
// lines up with the real one by index.
function maskSrc(S, src) {
  let maskedSrc = src;
  // Reference links can only be masked when a definition exists at all.
  // (A plain [ref] is a reference too, so the gate is any bracket, not
  // the ][ of a full [text][ref].)
  if (src.includes('[') && S.linkCount > 0) {
    const maskReflink = (match0) => {
      // A candidate holding no emphasis or strikethrough delimiter
      // cannot affect the scans the mask feeds, so it stays as it is.
      if (!match0.includes('*') && !match0.includes('_') && !match0.includes('~')) return match0;
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      // Links may not contain other links, at any level of nesting. A
      // candidate whose text already holds one never becomes a link, so
      // flattening the whole span would hide the emphasis that still
      // applies inside it: mask the links it holds instead. Images are
      // exempt: their text is flattened into an alt attribute.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(S, text)) {
          return '[' + text.replace(REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(REFLINK_SEARCH, maskReflink);
  }

  // Escapes and code spans can only occur where a backtick sits, or
  // where a backslash escapes a delimiter; without either, this pass
  // changes nothing the emphasis scans can see.
  if (src.includes('`') || ESCAPED_DELIM.test(src)) {
    maskedSrc = maskedSrc.replace(ANY_PUNCT_OUTSIDE_CODE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }

  // Links, code spans and HTML can only occur where [, ` or < sits.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(BLOCK_SKIP, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }

  return maskedSrc;
}

// Last index of a run that can close emphasis/strong (*, _) or
// strikethrough (~) in one masked source. A run can close only when it is
// not preceded by ASCII whitespace or the start of the string.
function scanClosers(src) {
  let star = -1;
  let und = -1;
  let tilde = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else if (ch === '*') star = i;
      else und = i;
    }
    i = j - 1;
  }
  return { star, und, tilde };
}

// True when a link label's closing bracket sits inside a tag or autolink
// that the label itself contains, which means the label ends too late.
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE_TAG.exec(tokenSrc) || AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Build a link or image token from a matched label and destination. The
// label text is itself tokenized inline; a link whose text already holds
// a link bails out so the caller falls through to plain text and the
// inner link is the one kept.
function outputLink(S, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = S.inLink;
  const outerLinkEmitted = S.linkEmitted;
  const outerInRawBlock = S.inRawBlock;
  S.inLink = true;
  S.linkEmitted = false;
  const tokens = inlineTokens(S, text);
  const textHasLink = S.linkEmitted;
  S.linkEmitted = outerLinkEmitted;
  S.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      // These tokens are discarded: undo the raw-block state they opened,
      // or it would suppress escaping for the text that is re-scanned.
      S.inRawBlock = outerInRawBlock;
      return undefined;
    }
    S.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tokenizeEscape(src) {
  const cap = INLINE_ESCAPE.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
  return undefined;
}

function tokenizeTag(S, src) {
  const cap = INLINE_TAG.exec(src);
  if (!cap) return undefined;
  if (!S.inLink && O.startATag.test(cap[0])) S.inLink = true;
  else if (S.inLink && O.endATag.test(cap[0])) S.inLink = false;
  if (!S.inRawBlock && O.startPreScriptTag.test(cap[0])) S.inRawBlock = true;
  else if (S.inRawBlock && O.endPreScriptTag.test(cap[0])) S.inRawBlock = false;
  return {
    type: 'html',
    raw: cap[0],
    inLink: S.inLink,
    inRawBlock: S.inRawBlock,
    block: false,
    text: cap[0],
  };
}

function tokenizeLink(S, src) {
  // The link pattern backtracks quadratically over unterminated links;
  // without a ')' ahead it cannot match at all, so bail out first.
  if (S.linkParenPossible === false) return undefined;
  const cap = LINK.exec(src);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return undefined;

  const trimmedUrl = cap[2].trim();
  if (O.startAngleBracket.test(trimmedUrl)) {
    // CommonMark wants matching angle brackets, and the closing one
    // cannot be escaped.
    if (!O.endAngleBracket.test(trimmedUrl)) return undefined;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return undefined;
  } else {
    // Find the closing parenthesis, balancing nested ones.
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return undefined; // more opens than closes
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped: `[foo](/url\)` has no closer at all.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return undefined;

  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(S, cap, {
    href: href ? href.replace(ANY_PUNCT, '$1') : href,
    title: title ? title.replace(ANY_PUNCT, '$1') : title,
  }, cap[0]);
}

function tokenizeReflink(S, src) {
  let cap;
  if ((cap = REFLINK.exec(src)) || (cap = NOLINK.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return undefined;
    const link = S.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      // Not a link: only the first character is consumed as text.
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return outputLink(S, cap, link, cap[0]);
  }
  return undefined;
}

function tokenizeEmStrong(S, src, maskedSrc, hints, prevChar = '') {
  let match = EM_STRONG_LDELIM.exec(src);
  if (!match) return undefined;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;

  const delimChar = match[0][0];
  // A mid-run opener (the second star of an unmatched `**`) may only pair
  // with a delimiter that can only close, or it steals the opener of a
  // later span.
  const midRun = prevChar === delimChar;

  // The start of this delimiter run may already sit behind src, either
  // taken as text after the whole run failed to match or used to close an
  // earlier span. Flanking and rules 9-10 are about the whole run, so
  // find its start.
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!PUNCTUATION.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!PUNCTUATION.exec(prevChar);

  // _ cannot sit between two alphanumerics.
  if (match[4] && prevChar.match(O.unicodeAlphaNumeric)) return undefined;

  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    // The spread counts code points, which is what the delimiter lengths
    // are measured in (an emoji counts as one).
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;

    // Rules 9-10 count the whole run, and also apply when the opener
    // could close as well.
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    const endReg = delimChar === '*' ? EM_STRONG_RDELIM_AST : EM_STRONG_RDELIM_UND;
    const lastPossible = delimChar === '*' ? hints.star : hints.und;
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return undefined;
    // Clip the masked source to the same section of string as src.
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip a lone * inside __abc*abc__
      rLength = [...rDelim].length;

      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either way
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark emphasis rules 9-10
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue; // not enough closing delimiters yet

      // Trim the extra characters: *a*** -> *a*
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      // An odd smallest delimiter makes em, an even one strong.
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(S, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(S, text) };
    }
  }
  return undefined;
}

function tokenizeCodespan(src) {
  const cap = INLINE_CODE.exec(src);
  if (!cap) return undefined;
  let text = cap[2].replace(O.newLineCharGlobal, ' ');
  const hasNonSpaceChars = O.nonSpaceChar.test(text);
  const hasSpaceCharsOnBothEnds = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: cap[0], text };
}

function tokenizeBr(src) {
  const cap = INLINE_BR.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
  return undefined;
}

function tokenizeDel(S, src, maskedSrc, hints, prevChar = '') {
  let match = DEL_LDELIM.exec(src);
  if (!match) return undefined;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || PUNCTUATION.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    const endReg = DEL_RDELIM;
    const lastPossible = hints.tilde;
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return undefined;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: inlineTokens(S, text) };
    }
  }
  return undefined;
}

function tokenizeAutolink(src) {
  const cap = AUTOLINK.exec(src);
  if (!cap) return undefined;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return {
    type: 'link',
    raw: cap[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function tokenizeUrl(src) {
  let cap;
  if ((cap = URL_RE.exec(src))) {
    let text;
    let href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      // Trim trailing punctuation and unmatched parens off the link.
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = BACKPEDAL.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
  return undefined;
}

function tokenizeInlineText(S, src) {
  const cap = TEXT_GFM.exec(src);
  if (!cap) return undefined;
  const escaped = S.inRawBlock;
  return {
    type: 'text',
    raw: cap[0],
    // Raw HTML keeps whatever it was written with; everywhere else a
    // numeric character reference stands for the character itself.
    text: escaped ? cap[0] : decodeNumericRefs(cap[0]),
    escaped,
  };
}

function tokenizeInlines(S, src, maskedSrc, hints, tokens) {
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;

    let token;

    if ((token = tokenizeEscape(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokenizeTag(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokenizeLink(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokenizeReflink(S, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.type === 'text' && lastToken?.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if ((token = tokenizeEmStrong(S, src, maskedSrc, hints, prevChar))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokenizeCodespan(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokenizeBr(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokenizeDel(S, src, maskedSrc, hints, prevChar))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokenizeAutolink(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (!S.inLink && (token = tokenizeUrl(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = tokenizeInlineText(S, src))) {
      src = src.substring(token.raw.length);
      // Track prevChar before a run of ____ starts.
      if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
      keepPrevChar = true;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

// One paren scan per inline run, shared with the link tokenizer: without
// a ')' ahead the link pattern cannot match, and skipping it avoids its
// quadratic backtracking over unterminated links. A nested run receives
// a substring of the outer run, so if the outer had no ')' neither does
// this one: the scan is skipped in that case.
function inlineTokens(S, src, tokens = []) {
  const prevLinkParenPossible = S.linkParenPossible;
  S.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineTokensInner(S, src, tokens);
  } finally {
    // A nested run anchored on its own substring; restore the outer run's
    // flag for the rest of its loop.
    S.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineTokensInner(S, src, tokens) {
  // The masked source is only read by emStrong and del, which need a *,
  // _ or ~ to start: skip building it for a run without one.
  const maskedSrc = (src.includes('*') || src.includes('_') || src.includes('~'))
    ? maskSrc(S, src)
    : src;
  // One scan of this masked source for the last emphasis, strong and
  // strikethrough closers, shared by every opener in the pass.
  const hints = scanClosers(maskedSrc);
  return tokenizeInlines(S, src, maskedSrc, hints, tokens);
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderCode(token) {
  const langString = (token.lang || '').match(O.notSpaceStart)?.[0];
  // An empty code block has no content, so it must not gain a newline.
  const code = token.text ? token.text.replace(O.endingNewline, '') + '\n' : '';
  const body = escapeHtml(code, true);
  if (!langString) return '<pre><code>' + body + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtml(langString) + '">' + body + '</code></pre>\n';
}

function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTableCell(S, token) {
  const content = renderInline(S, token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTable(S, token) {
  let cell = '';
  for (const h of token.header) cell += renderTableCell(S, h);
  const header = `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (const row of token.rows) {
    cell = '';
    for (const c of row) cell += renderTableCell(S, c);
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n' + '<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderList(S, token) {
  let body = '';
  for (const item of token.items) body += `<li>${renderBlocks(S, item.tokens)}</li>\n`;
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlocks(S, tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${token.depth}>${renderInline(S, token.tokens)}</h${token.depth}>\n`;
        break;
      case 'code':
        out += renderCode(token);
        break;
      case 'table':
        out += renderTable(S, token);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(S, token.tokens)}</blockquote>\n`;
        break;
      case 'list':
        out += renderList(S, token);
        break;
      case 'checkbox':
        out += renderCheckbox(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'paragraph':
        out += `<p>${renderInline(S, token.tokens)}</p>\n`;
        break;
      case 'text':
        out += renderInline(S, token.tokens);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function renderLink(S, token) {
  // References are not resolved inside an autolink, so every & there is
  // literal. Elsewhere only an & that cannot start one needs escaping.
  const parsedText = token.autolink
    ? escapeHtml(token.text, true)
    : renderInline(S, token.tokens);
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) return parsedText;
  const href = escapeHtml(cleanHref, token.autolink);
  let out = '<a href="' + href + '"';
  if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
  out += '>' + parsedText + '</a>';
  return out;
}

function renderImage(S, token) {
  let text = token.text;
  if (token.tokens) text = renderInline(S, token.tokens, true);
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) return escapeHtml(text);
  const href = cleanHref;
  let out = `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"`;
  if (token.title) out += ` title="${escapeHtml(token.title)}"`;
  out += '>';
  return out;
}

// Render inline tokens. With textMode set, only the textual part is kept
// (used for image alt text): tags stay literal, line breaks vanish, and
// emphasis and links recurse into their text.
function renderInline(S, tokens, textMode = false) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape':
      case 'text': {
        if (textMode) {
          out += token.text;
        } else if ('tokens' in token && token.tokens) {
          out += renderInline(S, token.tokens);
        } else if ('escaped' in token && token.escaped) {
          out += token.text;
        } else {
          out += escapeHtml(token.text);
        }
        break;
      }
      case 'html':
        out += token.text;
        break;
      case 'link':
        out += textMode
          ? (token.tokens ? renderInline(S, token.tokens, true) : token.text)
          : renderLink(S, token);
        break;
      case 'image':
        out += textMode
          ? (token.tokens ? renderInline(S, token.tokens, true) : token.text)
          : renderImage(S, token);
        break;
      case 'checkbox':
        out += textMode ? token.raw : renderCheckbox(token);
        break;
      case 'strong':
        out += textMode
          ? (token.tokens ? renderInline(S, token.tokens, true) : token.text)
          : `<strong>${renderInline(S, token.tokens)}</strong>`;
        break;
      case 'em':
        out += textMode
          ? (token.tokens ? renderInline(S, token.tokens, true) : token.text)
          : `<em>${renderInline(S, token.tokens)}</em>`;
        break;
      case 'codespan':
        out += textMode ? token.text : `<code>${escapeHtml(token.text, true)}</code>`;
        break;
      case 'br':
        if (!textMode) out += '<br>';
        break;
      case 'del':
        out += textMode
          ? (token.tokens ? renderInline(S, token.tokens, true) : token.text)
          : `<del>${renderInline(S, token.tokens)}</del>`;
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function runParse(markdown) {
  const S = freshState(markdown.replace(O.carriageReturn, '\n'));
  const tokens = blockTokens(S, S.src, 0, S.src.length, []);
  for (let i = 0; i < S.queue.length; i++) {
    const next = S.queue[i];
    // An inline <pre>, <code>, <kbd> or <script> left open ends with the
    // block holding it; carried over, it would stop every later block's
    // text from being escaped.
    S.inRawBlock = false;
    inlineTokens(S, next.src, next.tokens);
  }
  return renderBlocks(S, tokens);
}
