# CLAUDE.md

Guard rails for working on this repo.

## What this is

An MCP server that runs the **real query engine of the Obsidian Tasks plugin**
outside of Obsidian instead of reimplementing it. The plugin sits unmodified
as a submodule in `vendor/obsidian-tasks`; at build time esbuild aliases the
module `obsidian` to `src/obsidian-shim.ts`.

The heart of the matter: **no silent dropping of filters.** Every response
carries `query.error` and `explainQuery()` along with it — that is exactly
where the existing servers failed.

The second goal, of the same rank: **a vault is private data, and this server
is what points a language model at it.** Correctness and security are the two
things this project is for; a feature that trades away either is not a feature
here. The risks and the defences that answer them are in
`docs/ARCHITECTURE.md` under "Security is a goal of the same rank as
correctness", and the rules below are the short form.

## Before starting or resuming work

**Check whether the submodule pin is stale, and say so.** The engine lives
upstream and develops on its own schedule; the pin here is deliberate, but it
goes quietly out of date, and finding that out *after* debugging a
discrepancy against Obsidian is the wrong order.

```sh
git -C vendor/obsidian-tasks fetch -q --depth=100 origin main
git -C vendor/obsidian-tasks rev-list --count HEAD..FETCH_HEAD   # commits behind
```

This is a report, not a task: nothing is updated automatically, and the pin
is not moved without being asked. If the count is non-zero, mention it and
leave the decision to the user. How a bump is then carried out, and which
tripwires catch what, is in CONTRIBUTING.md under "Keeping the submodule
current".

**A bump is not finished until the README says so.** The README names the
obsidian-tasks version the project was tested against; move the pin across a
release and that line is a false claim. `npm test` fails while the two
disagree, so the reminder is enforced rather than remembered — but update the
line in the same commit as the pin, not afterwards.

## Hard rules

- **Never modify `vendor/obsidian-tasks`.** The whole point is
  `git submodule update --remote` without conflicts. Every adjustment goes
  into `src/`. If the engine is missing something at run time, it belongs in
  the shim — not in the vendor tree.
- **Vaults are read-only.** No writes, not even to `.obsidian/`. This is a
  guarantee against a damaged vault — a mangled task, a note rewritten by a
  parsing edge case, an edit landing while Obsidian has the file open — and it
  is only a guarantee while it has no exceptions. One write path and every
  later lost note has to be investigated instead of ruled out.
- **Nothing outside the vault is ever read.** The walk in `src/vault.ts` is
  bounded by the real path of the root: a symbolic link leading out is skipped
  and reported, `..` in a scope is refused, and `outsideConfiguredRoots()` in
  `src/mcp.ts` pins `rootDirs` to the configured roots whenever `-scope` or
  HTTP is in play. Any new path that reaches the file system goes through the
  same check. Think of `~/Documents/tax-2024.md`: also Markdown, also full of
  `- [ ]` lines.
- **Nothing from inside the vault comes out but tasks.** The answer is built
  from `Task` objects, never from file contents, and `includeDetails` emits the
  field-by-field projection `TaskDetails` in `src/engine.ts` — *not* the task
  object, which carries its file's whole `CachedMetadata`, frontmatter
  included. Widening `TaskDetails` or serialising an engine object wholesale is
  a disclosure decision, not a convenience.
- **Nothing from a request may reach the host.** `filter by function`
  evaluates arbitrary JavaScript in this process; it stays off over MCP
  (`src/server.ts` never sets `enableJs`) and that is deliberate, not an
  oversight to be tidied up. No shell, no `eval`, no path taken from the
  query. `--http` binds loopback, requires `-root`, validates `Host` and
  `Origin`, and there is no `--host` flag — and never will be.
- **An error message is a disclosure path.** It is the one built from whatever
  went wrong rather than from the result, and therefore the one nobody reviews.
  `src/paths.ts` is the only place that decides how a path is said: every
  `problems` entry and every settings warning is vault-relative, a failing line
  is reported by number and never quoted (it passed neither the global filter
  nor the query), and a Node error's absolute path is cut off its message.
  Never conceal a problem to fix that; say the same fact vault-relatively.
  A new report gets the same scrutiny as a new result field, and
  `tests/selftest.ts` fails a `problems.push()` that names an absolute path.
- **`rootDirs` is pinned to `-root` on every transport**, opened only by
  `--allow-any-root` on the command line and never by which transport carried
  the call — `rootDirs` is an argument a language model chooses, possibly from
  a note it just read. Everything a response takes from the vault is fenced in
  `<vault-content>` by `src/mcp.ts`, so the reader can tell data from
  instructions.
- **Output outlives the query.** Task lines and file names end up in
  scrollback, journals, client logs and session transcripts. Anything that
  lands somewhere readable later is produced with `--summary`.
- **TypeScript stays.** The engine arrives as a TypeScript submodule and is
  called unmodified; a port to Go would be exactly the mistake the existing
  servers made.
- **Everything is in English** — code, comments, documentation, commit
  messages, test fixtures, the texts the server returns to its caller. The
  project is public, the query language is English and `explainQuery()`
  answers in English; a second language around an English DSL invites mistakes
  and splits the readership.
  The one deliberate exception is the multilingual fixtures under
  `tests/fixture-vault/Languages/`, one file per script. They are test data
  for non-Latin scripts in file names, task text and tags — not prose. What
  each one stresses is listed in `docs/TESTS.md`.
  Indentation 4 spaces, as in the plugin.
- **The static checks are not to be silenced.** `npm run typecheck` and
  `npm run lint` are part of `npm test`. A `@ts-expect-error`, an
  `eslint-disable` or a widened type to make them pass is a change to the
  check, not to the code — it needs a comment saying why the checker is wrong
  here, or it does not go in. The one such suppression in `src/` today is in
  `src/metadata.ts` and carries its reason.

## Commands

```bash
npm run build     # esbuild -> dist/cli.js, dist/server.js, dist/selftest.js …
npm run typecheck # tsc --noEmit over src/ and tests/ (vendor: reported, not enforced)
npm run lint      # eslint over src/, tests/, scripts/ — never vendor/
npm test          # typecheck + lint + self-check + invariants + Obsidian comparison
                  # (89/89) + MCP smoke
npm run check -- <vault>                   # only the invariants, against a real vault
node dist/cli.js --check --summary <vault>  # same, but counts only — no task text
node dist/cli.js <vault> examples/morning-briefing.txt
node scripts/mcp-smoke.mjs                 # the MCP layer over real stdio
node scripts/mcp-smoke.mjs --http          # the same over Streamable HTTP
                                           # each runs both protocol eras
```

**The real vault is private. Run it with `--summary` whenever the output
lands anywhere it can be read later — a shared terminal, a session
transcript, a log.** Without the flag the output quotes task lines and names
notes; with it there are only counts, rule names and timings. Read the full
output only when a finding actually needs chasing down, and keep it local.

**After every change to `src/`, run both: `npm test` and
`npm run check -- <large, real vault>`.** The fixtures alone are not enough —
the Obsidian comparison data contains neither tabs nor CRLF, and reading has
already failed on both. The invariants need no expected result and therefore
run on any vault. Details: `docs/TESTS.md`.

## Layout

```
src/obsidian-shim.ts   replacement for every runtime symbol from 'obsidian'
src/metadata.ts        Markdown -> Obsidian's CachedMetadata (the heart)
src/settings.ts        adopt the vault settings (singletons!)
src/paths.ts           how a path is compared, and how a problem is said
src/vault.ts           read the vault -> Task[], via the plugin's FileParser
src/engine.ts          build, run and shape the query — the shared middle
                       (serialised: one run at a time, see below)
src/invariants.ts      checks that hold for every vault (--check)
src/cli.ts             test tool without the MCP layer
src/server.ts          MCP server: entry point, stdio (default) or
                       Streamable HTTP (--http, loopback only)
src/mcp.ts             the tools themselves: query_tasks / explain_query /
                       tasks_query_syntax
src/quick-reference.ts query language quick reference, from the vendor docs
tests/                 selftest.ts (fixture vault) + conformance.ts (Obsidian)
scripts/build.mjs      esbuild + the 'obsidian' alias
scripts/typecheck.mjs  tsc --noEmit; vendor errors counted, never fatal
vendor/obsidian-tasks  submodule, unmodified
```

Detailed map of the engine (which vendor class does what, which symbols the
shim needs, how the plugin starts up): skill `obsidian-tasks-engine`,
`.claude/skills/obsidian-tasks-engine/SKILL.md`.

## Traps

- `window.moment` has to be set before the first task is parsed. ESM imports
  are hoisted — hence the setup lives in a module of its own that is imported
  first.
- `i18n.t()` throws if `initializeI18n()` has not run.
- `GlobalFilter`, `GlobalQuery`, `StatusRegistry` and `Settings` are
  **process-wide singletons**. They have to be populated from the vault
  settings (`.obsidian/plugins/obsidian-tasks-plugin/data.json`), otherwise
  the engine computes with different values than Obsidian itself.
- A new vendor module in the bundle can drag in new `obsidian` symbols. The
  build then fails; add the missing symbol to the shim as a dummy.
- `filter by function` and relatives need `EnableJsInTasksQueries`. That value
  lives in Obsidian's vault-local app storage and therefore **cannot** be read
  from the vault — hence the switch `--enable-js`, off by default as in the
  plugin.
- Entry points from several directories: in `scripts/build.mjs` the output
  names have to be spelled out, otherwise `dist/server.js` suddenly becomes
  `dist/src/server.js` — and the MCP configuration points at nothing. Hence
  HTTP is a flag on `src/server.ts`, not a second entry point.
- Over HTTP the SDK builds a server **per request**, so nothing in `src/mcp.ts`
  may live in module state — it all arrives as `ServerConfig`. And because the
  engine's singletons are process-wide, `src/engine.ts` runs one query at a
  time under a mutex; without it, concurrent calls against different vaults
  return plausible, wrong answers.
- `npm run typecheck` reports type errors in `vendor/` without failing on
  them: the shim supplies the engine's runtime symbols and only the few types
  our own code hands to it. The count is only meaningful as a difference
  across a submodule bump.
- `--http` binds to `127.0.0.1` only and requires `-root`, which then becomes a
  boundary for `rootDirs`. Neither is optional: under stdio the client spawned
  us and could read those directories anyway, but a port has no such
  relationship.

## Call shape

Tool names and parameters (`rootDirs`, `filters`) are those of the older
Obsidian Tasks MCP server written in Go that this one replaces. **They have to
stay the same:** switching over should mean swapping only the `command` line
in the MCP configuration, without touching the calling side.
