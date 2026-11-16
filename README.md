# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Wayot07/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Wayot07/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast drop-in replacement for [marked](https://github.com/markedjs/marked)
18.1.3 (default options: GFM on, breaks off, pedantic off, async off), built
for the make.fun `markdown-render-speed-02` competition.

`parse.js` is a dependency-free ES module whose `parse(markdown)` returns
exactly the HTML `marked.parse` returns — byte-identical on all 720 practice
cases (680 CommonMark 0.31.2 + GFM 0.29 spec examples and 40 generated long
READMEs) — and runs about 1.6x faster than marked itself on the practice set
(~555 ms/run vs ~900 ms/run locally).

How it gets there: index-based scanning with sticky regexes (no per-token
substring churn), a hand-written inline text scanner driven by a single
native regex for the next stop position, first-character dispatch guards on
both the block and inline loops, and direct HTML rendering with no
intermediate inline token objects. The block grammar regexes are the same
grammar marked defines (they are the specification of its output); the
parsing, scanning and rendering machinery around them is original.

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, renders each with `parse`, and writes
`/output/html.json`.

## Layout

- `parse.js` — the parser (dependency-free ES module, `parse(markdown)`)
- `main.ts` — the harness driver
- `LICENSE` — MIT

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
