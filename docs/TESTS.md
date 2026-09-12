# Checks

```bash
npm test                              # everything: static checks, self-check, invariants, comparison
npm run typecheck                     # only the types, src/ and tests/
npm run lint                          # only the lint rules
npm run conformance                   # only the comparison with Obsidian
npm run check -- /path/to/vault       # only the invariants, against a real vault
node scripts/mcp-smoke.mjs [vault]           # the MCP layer over real stdio
node scripts/mcp-smoke.mjs --http [vault]    # the same over Streamable HTTP
node scripts/mcp-smoke.mjs --era modern      # only one of the two protocol eras
```

Four layers, each able to do something different:

| | checks against | needs an expected result? |
|---|---|---|
| static checks | the code, without running it | no — and no vault either |
| self-check | invented fixtures | yes, written by hand |
| comparison | real Obsidian data | yes, but produced by **Obsidian** |
| invariants | themselves | **no** — runs on any vault |

The static layer is the cheapest and the narrowest: `tsc --noEmit` plus
ESLint, over `src/`, `tests/` and `scripts/` only. It can say that a value is
not what the code thinks it is, or that a promise is never awaited — it can
say nothing at all about whether a query returns what Obsidian returns. Why
it stops at the vendor tree, and which lint rules are there for a reason, is
in [CONTRIBUTING.md](../CONTRIBUTING.md) under "The static checks".

Alongside them the self-check runs one smoke test on `docs/` itself:
[TODO.md](TODO.md) is written in the Tasks format, so the repository is a
small vault, and reading it proves in one step that the build reads tasks out
of ordinary notes at all. It asserts nothing about the contents — the file is
short and gets shorter as items are ticked off, which is exactly why it
replaces neither the fixtures nor a run against a real vault.

## Why there is no test suite of our own for the query language

The submodule brings along a good 700 test files. They check the 40 filter
classes, the boolean parser, the date and recurrence logic — that is, exactly
the part this project does **not** touch. Reproducing those tests here would be
the same mistake as reimplementing the engine.

What is checked, therefore, is only what this project contributes:

| File | checks |
|---|---|
| `tests/selftest.ts` | settings, tree, tabs, CRLF, block quotes and callouts, numbered parents, nesting, special characters, writing systems, dependencies, headings, frontmatter, code blocks — against `tests/fixture-vault`, plus the global filter and vault switching against `tests/fixture-vault-filter`, plus the directory walk (links out of the vault, links that loop, a broken link, an unreadable directory, an unreadable file) and how a problem is worded (no absolute path, no quoted source line) against throwaway vaults built on the spot, because neither symlinks nor permissions survive a fixture in git |
| `src/invariants.ts` | properties that must hold for **every** vault; from `selftest.ts` over the fixtures, via `--check` over any other vault |
| `tests/conformance.ts` | `src/metadata.ts` and the shim against real Obsidian data |
| `scripts/mcp-smoke.mjs` | the MCP layer against a real server: tool list, call, error case, the `<vault-content>` fence around what was read — over both transports (stdio, Streamable HTTP) and in both protocol eras (the 2025 `initialize` handshake and 2026-07-28), four combinations in all; over stdio the `rootDirs` boundary and its `--allow-any-root` opt-out, over HTTP the same boundary plus refused methods, the Origin check, the body-size and `Content-Length` limits and the optional shared secret |
| `examples/*.txt` | run by `selftest.ts`: every example query still parses and runs — an instruction renamed in the submodule surfaces here |

## The comparison with Obsidian

This is the most important check. Under
`vendor/obsidian-tasks/tests/Obsidian/__test_data__/` are 89 JSON files (that
count is upstream's and grows with the submodule), each
holding the content of a note **and** the `CachedMetadata` Obsidian itself
produced for it — plus Obsidian's results for `getAllTags()` and
`parseFrontMatterTags()`.

That allows `src/metadata.ts` to be checked against the truth instead of
against a guess. Compared is what `FileParser` actually evaluates: which lines
are list items, which character sits in the checkbox, who is whose parent, and
the headings. Columns and byte offsets are not compared — they are evaluated
nowhere.

**Status: all of them — 89 of 89 at the time of writing.**

The comparison brought several rules to light that nobody would invent:

- A list item is a child of the previous one if its indentation reaches at
  least that item's **content column** (CommonMark) — not already when it is
  larger. ` - [ ] x` after `- [ ] y` is a sibling, not a child.
- `tags: one, two` in the frontmatter yields **not two tags, but none**:
  Obsidian does not split the string, and a tag containing a comma and a space
  is invalid. An empty list yields `[]`, an empty field `null`.
- List items in `%% … %%` and `<!-- … -->` do not count. For **tags**, though,
  Obsidian differs: those in `%% … %%` end up in the cache, those in
  `<!-- … -->` do not.
- If the text after the checkbox itself starts with a list marker
  (`- [ ] 1. Text`), a second, embedded list item appears on the same line
  (Obsidian issue 3481).

## The invariants

The two checks above need an **expected result** that somebody wrote down. For
a vault with a few thousand files nobody writes that down — which is why
eyeballing was the only option there for a long time. That is exactly how the
tab bug was found: not by a test, but because some output looked odd.

An invariant needs no expected result. It is a statement that is true in
itself, whatever the files contain:

| Rule | Statement |
|---|---|
| LineNumber | The line number of a list item points at the line it came from. |
| Indentation | Two consecutive list items with character-identical indentation, with nothing less deeply indented between them, are siblings. |
| Tree | Parents come before their children, in the same file, without cycles, linked both ways. |
| Heading | The preceding heading is the nearest heading above the line. |
| Tags | Every tag of a task also appears in the Markdown of its line. |
| RoundTrip | The line written back contains the same characters as the original line. |

The same check therefore runs over the fixtures **and** over an arbitrarily
large, unknown vault — including one whose contents nobody may show anybody
else, which is the usual case for the vaults that matter most.

### Why "Indentation" would have found the tab bug

The bug measured indentation in columns (tab = 4) but the parent's content
column in characters; tab-indented siblings turned into a staircase. The rule
says: two items with **character-identical** indentation are siblings. It
knows nothing about tabs and does not need to know how wide one counts —
precisely the question the bug turned on.

Reproduced: build the old bug back into `src/metadata.ts` and
`npm run check -- tests/fixture-vault` promptly reports
`Tabs.md:5 — indented identically to line 4 ("\t"), but a different parent`.
An invented fixture case only ever catches what somebody thought of; the
invariant also catches what nobody thought of.

### The limit

Invariants do not prove that the result is *right* — only that it is
self-consistent. An engine that swallows every task violates none of them. So
they do not replace the other two layers but come on top as a third: the only
one that works on input nobody has read in advance.

### What they have already found

The rule "RoundTrip" was at first "produces the same line again" and reported
nine hits against a real vault — all harmless: `toFileLineString()` normalises
on purpose (double spaces disappear, the emoji fields come out in the plugin's
order). The rule was then narrowed down to what really must always hold: **the
same characters**. A swallowed date changes the multiset of characters,
reordering does not.

## What the real vault found on top

The Obsidian comparison files do not cover everything. Two gaps are known and
are now closed by fixtures of our own:

- **Tabs** do not appear in the comparison files (`Tabs.md`).
- **CRLF line endings** do not either. A vault from Windows yielded **zero**
  tasks because of that: the line analysis recognised neither headings nor list
  items, and did so silently. Since then `src/vault.ts` normalises while
  reading (`Line-Endings.md`).

So this still holds: **after every change to `src/`, also run against a real,
large vault** — but now with `npm run check -- /path/to/vault` instead of mere
eyeballing.

### Keeping that output to yourself

The check reads somebody's private notes, and a finding quotes the line it
found and names the note it sits in. `--summary` prints the same run as
counts, rule names and timings only — no task text, no note names, no quoted
lines — for output that goes into an issue, a CI log or a terminal somebody
else reads:

```bash
node dist/cli.js --check --summary /path/to/vault
node dist/cli.js --summary /path/to/vault examples/morning-briefing.txt
```

The promise is checked rather than asserted: the *Discretion* section of
`tests/selftest.ts` runs the real CLI both ways and fails if a task line or a
note name survives `--summary`.

## Writing systems

`tests/fixture-vault/Languages/` holds one file per script. Each exercises its
characters in three places at once — in the **file name**, in the **task text**
and in a **tag** — because those take different paths: file names go through
the directory walk and `path includes`, task text goes through description and
round trip, tags go through the tag regex in `src/metadata.ts`.

The scripts are picked for what they stress, not for reach:

| File | What it stresses |
|---|---|
| `Deutsch.md` | umlauts and eszett |
| `Français.md` | accents and cedillas |
| `Português.md` | til, cedilla, circumflex and crase on top of each other |
| `Українська.md` | Cyrillic |
| `日本語.md` | kanji, hiragana, katakana; no letter case |
| `中文.md` | Han characters, full-width punctuation |
| `한국어.md` | Hangul syllables |
| `Türkçe.md` | dotless `ı` and dotted `İ` — the classic case-folding trap, and `includes` matches case-insensitively |
| `فارسی.md` | right-to-left, plus a zero-width non-joiner **inside** a word |
| `עברית.md` | right-to-left, plus combining niqqud on the letters |
| `ภาษาไทย.md` | written without spaces between words, with marks stacked above and below |

`tests/selftest.ts` has a *Writing systems* section that checks, per file,
that it is found under its own name, that the task text survives intact and
that a tag in that script matches — plus, across all of them, that
`description includes` works with a non-Latin search text (including the
dotless `ı`, accented capitals folded to lower case, right-to-left text and a
Thai word not delimited by spaces), that the tree still nests, and that every
language file contributes its five open and one done task. The invariants run
over these files as well, so line numbers, tree and round trip are covered
for them too.

Everything there works per code point, not per byte; these fixtures are what
says so. They are also the one place in this repo where prose is deliberately
not English.

Deliberately not covered: Greek final sigma (`ς`/`σ`), Devanagari, and
Unicode normalisation — a file name in NFD, as macOS writes it, would be a
worthwhile test but behaves differently depending on the file system, so it
does not belong in a fixture that has to pass everywhere.

## Running the submodule's tests directly

Not set up so far. It would need the plugin's development dependencies
(`yarn install` in `vendor/obsidian-tasks`, with Jest, ts-jest and Svelte) and
a Jest configuration of its own aliasing `obsidian` to our shim. The benefit
would be small: those tests check the engine, and we do not change it. Their
**data** is the valuable part — and `tests/conformance.ts` already uses it,
without any extra dependency.
