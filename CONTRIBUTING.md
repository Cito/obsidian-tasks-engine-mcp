# Contributing

Thanks for your interest. This project has few rules, but hard ones — and they
all follow from the fact that the query language does **not** live here, but in
the embedded plugin.

## Setting up

```bash
git clone --recurse-submodules https://github.com/Cito/obsidian-tasks-engine-mcp.git obsidian-tasks-engine-mcp
cd obsidian-tasks-engine-mcp
npm install
npm test
```

Nothing works without the submodule — it *is* the engine. For an already cloned
repo: `git submodule update --init --depth 1`.

## The hard rules

**`vendor/obsidian-tasks` is never modified.** The whole point of the setup is
`git submodule update --remote` without conflicts. Every adjustment belongs in
`src/`. If the engine is missing a symbol from `'obsidian'` at run time, it
goes into `src/obsidian-shim.ts` as a dummy — not into the vendor tree. A patch
that touches the submodule will not be accepted.

**Do not reimplement what the submodule already has.** Reimplementing a
function of the plugin reproduces exactly the mistake that this project exists
because of. Look in the submodule first.

**Errors are never concealed.** `query.error` and `explainQuery()` belong in
every response. A filter line that was not understood leads to an error
response, never to a silently smaller result. The same goes for files that
cannot be read and for scopes that do not exist.

**Vaults are only ever read.** No writes, not even to `.obsidian/`.

**Tool names and parameters stay stable.** `query_tasks`, `rootDirs` and
`filters` are the call shape of the older Obsidian Tasks MCP server written in
Go, so that moving from it means changing the `command` line and nothing else.
Changing them forces every existing installation to adapt.

## Style

- **Everything in English** — code, comments, documentation, commit messages,
  test fixtures, the texts the server returns. The project is public, the query
  language is English and `explainQuery()` answers in English; a second
  language around an English DSL invites mistakes and splits the readership.
- The one deliberate exception is the multilingual fixtures under
  `tests/fixture-vault/Languages/`, one file per script. They are test data,
  not prose — they exist so that non-Latin scripts in file names, task text
  and tags stay covered, including right-to-left writing, combining marks and
  invisible format characters. Which script stresses what is listed in
  [docs/TESTS.md](docs/TESTS.md).
- Indentation 4 spaces, as in the plugin.
- Comments explain the **why**, not the what. Anyone making a non-obvious
  decision writes down the reason — the traps in this project are nearly all
  invisible (see below).

## Before every patch

```bash
npm test                          # static checks, fixtures, invariants, comparison with Obsidian
npm run check -- /path/to/vault   # invariants against a real, large vault
```

Pasting that output into a patch or an
[issue](https://github.com/Cito/obsidian-tasks-engine-mcp/issues)? Use
`node dist/cli.js --check --summary /path/to/vault` instead: same check, but
counts only — no task text, no note names, no quoted lines.

**Both, not just the first.** The Obsidian comparison data does not cover
everything: it contains neither tabs nor CRLF, and reading has already failed
on both — silently with CRLF, yielding zero tasks. If you do not have a large
vault at hand, say so in the patch.

The layers of checking and their limits: **[docs/TESTS.md](docs/TESTS.md)**.

## The static checks

`npm test` starts with two checks that run no code:

```bash
npm run typecheck        # tsc --noEmit over src/ and tests/
npm run typecheck -- --vendor   # …and show the vendor diagnostics too
npm run lint             # eslint over src/, tests/ and scripts/
```

They come first because they are the cheapest way to be wrong. The build is
esbuild, which strips types without ever looking at them — without
`npm run typecheck` nothing in this project asks TypeScript whether the code
is correct, and a type error ships into `dist/` in silence.

Two things about the scope are deliberate:

- **`vendor/obsidian-tasks` is never linted**, and its type errors never fail
  the check. It is compiled upstream under its own tsconfig against the real
  `obsidian` type definitions; here it is compiled against
  `src/obsidian-shim.ts`, which supplies the runtime symbols the engine needs
  and only the few types our own code hands to it. A finding there would be a
  finding we must not act on. `scripts/typecheck.mjs` therefore counts them
  and prints the count.
- **The type-aware lint rules are the point.** `no-floating-promises` above
  all: the engine's singletons are process-wide and `src/engine.ts` serialises
  queries under a mutex, so a promise nobody waits for does not crash here —
  it returns a plausible, wrong answer. The stylistic rules are along for the
  ride.

Lint runs with `--max-warnings 0`, and `no-explicit-any` is an error. Where the
engine's types are loose, the shim names the shape we hand over (it
re-exports `CachedMetadata` from `src/metadata.ts`), and a value whose type is
genuinely open is `unknown`, narrowed where it is used.

## Keeping the submodule current

The submodule is pinned to a commit, deliberately: a build has to be
reproducible, and the engine must not change under us between two runs. The
flip side is that the pin goes stale — upstream develops on its own schedule
and does not know we exist.

Worth knowing where you stand before you start, rather than halfway through
debugging a difference against Obsidian:

```bash
git -C vendor/obsidian-tasks fetch -q --depth=100 origin main
git -C vendor/obsidian-tasks rev-list --count HEAD..FETCH_HEAD   # commits behind
```

Nothing updates by itself, and that is on purpose — a pin that moves on its
own is not a pin. Moving it is three commands, and the third is the one that
matters:

```bash
git submodule update --remote vendor/obsidian-tasks
npm test                               # also tells you if the README version is now wrong
npm run check -- /path/to/vault        # add --summary if the output leaves the machine
git add vendor/obsidian-tasks README.md && git commit
```

If the bump crosses a release, `npm test` fails until the version named in
the README matches the submodule again. That is deliberate: the README says
what the code was tested against, and a stale claim there is worse than
none.

Three tripwires stand between a bump and a silent regression, and they fail
in the order the damage would occur:

1. **The build** fails with "No matching export … 'obsidian'" if a vendor
   module new to the bundle needs a runtime symbol the shim does not have.
   Loud and immediate; add the dummy.
2. **`tests/conformance.ts`** compares `src/metadata.ts` against Obsidian's
   own cache data, which ships *with* the submodule — so a bump brings newer
   truth along with the newer engine, and a changed cache contract shows up
   as a mismatch rather than as wrong query results.
3. **`examples/*.txt`** are parsed by the self-check, so a query instruction
   that upstream renames or drops is reported as an unparsed line.

A fourth is a report rather than a tripwire: `npm run typecheck` prints how
many type errors the vendor tree has against our shim. The number only means
something as a difference — if a bump moves it, upstream has started using a
part of the `obsidian` API the shim does not describe. Worth a look at
`npm run typecheck -- --vendor` before assuming it is cosmetic.

What none of them covers is a change in what a filter *means* while its
spelling stays the same. That is why the run against a real vault is in the
list: the invariants do not know the expected result and therefore survive
any bump.

## Contributing a new check

- **A concrete result** belongs in `tests/fixture-vault/` as a fixture with an
  expectation in `tests/selftest.ts`. New fixtures should close a **gap in the
  Obsidian comparison data**, not enlarge the pile.
- **A property that always holds** belongs in `src/invariants.ts` as an
  invariant. It must not assume anything about the content of a vault —
  otherwise it no longer runs on foreign vaults, and that is precisely its
  purpose. Phrase it so that it stays true independently of debatable details;
  `docs/TESTS.md` shows what that means, using the tab rule as an example.

## Where things are

| | |
|---|---|
| [README.md](README.md) | for users: set up, use, check your own vault |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | why the project is built this way |
| [docs/TESTS.md](docs/TESTS.md) | the three layers of checking and their limits |
| [docs/TODO.md](docs/TODO.md) | what is open — and, in ARCHITECTURE.md, what is ruled out |
| [CLAUDE.md](CLAUDE.md) | guard rails for work with Claude Code |
| `.claude/skills/obsidian-tasks-engine/` | detailed map of the engine: which vendor class does what |

## The traps

They are all invisible and otherwise cost an afternoon:

- `window.moment` has to be set **before** the first task is parsed. ESM
  imports are hoisted — hence the setup lives in a module of its own that is
  imported first (`src/bootstrap.ts`).
- `i18n.t()` throws if `initializeI18n()` has not run.
- `GlobalFilter`, `GlobalQuery`, `StatusRegistry` and `Settings` are
  **process-wide singletons** and have to be populated from the vault settings,
  otherwise the engine computes differently from Obsidian. For the same reason
  `src/engine.ts` serialises every run through a mutex: concurrent queries over
  HTTP would otherwise overwrite each other's settings mid-run.
- A new vendor module in the bundle may drag in new `obsidian` symbols; the
  build then fails. Add the missing symbol to the shim as a dummy.
- In `scripts/build.mjs` the output names have to be spelled out, otherwise
  `dist/server.js` suddenly becomes `dist/src/server.js`. That is why the HTTP
  transport is a flag on the one entry point and not a second one.
- Nothing in `src/mcp.ts` may live in module state. Over HTTP the SDK calls the
  server factory **once per request**; whatever the tools need arrives as
  `ServerConfig`.

## Security issues

Not as an issue and not as a pull request — both are public before a fix
exists. Report them privately as described in [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is covered by the project's
[MIT license](LICENSE).
