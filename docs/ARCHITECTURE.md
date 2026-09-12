# Decisions

Why the project is built the way it is. For contributors — users will find
what they need in the [README](../README.md).

This is **not** a blueprint of the engine. Which vendor class is responsible
for what, which runtime symbols the shim has to provide and in which order the
plugin starts up is in the detailed map
`.claude/skills/obsidian-tasks-engine/SKILL.md`. What follows are only the
decisions and their reasons — so that nobody reverses them out of ignorance.

## The engine is embedded, not reimplemented

The other Obsidian Tasks MCP servers we are aware of reimplement the query
language in code of their own and therefore support only a subset — usually
without saying which. This project includes `obsidian-tasks` as a submodule and
calls its `Query` class directly.

That is possible because the query part of the plugin is decoupled from
Obsidian: `vendor/obsidian-tasks/src/Query/` contains 67 files and **not a
single** import from `'obsidian'`. What is missing in the wider graph is five
symbols with real meaning (`Notice`, `getAllTags`, `parseFrontMatterTags`,
`getLanguage`, `prepareSimpleSearch`) and a handful of empty dummies for
classes that only come along through import chains and are never called.

**Consequence for contributors:** `vendor/obsidian-tasks` is never modified. If
the engine is missing something at run time, it belongs in the shim. See
[CONTRIBUTING.md](../CONTRIBUTING.md).

## The alias instead of an Obsidian mock

At build time esbuild aliases the module `obsidian` to `src/obsidian-shim.ts`
(`scripts/build.mjs`). The alternative would have been to rewrite the vendor
imports — which would make the submodule impossible to update without
conflicts, losing exactly the advantage it is a submodule for.

The price: a new vendor module in the bundle can drag in new `obsidian`
symbols. The build then fails — and the missing symbol goes into the shim as a
dummy. A failing build is the desired behaviour here: it forces a decision
instead of failing silently at run time.

## `src/vault.ts` parses nothing itself

It builds, for every file, the cache Obsidian would hand the plugin
(`src/metadata.ts`), and passes it to the plugin's **unmodified**
`FileParser`. The obvious approach would have been to call `Task.fromLine()`
line by line — but that knows neither line number nor hierarchy. Through the
`FileParser` the tasks carry line number, section, preceding heading and their
place in the list tree, and that is what makes `show tree`, `is not blocked`,
`id`/`dependsOn` and `heading includes` work.

This moves the entire difficulty of the project to **one** place:
`src/metadata.ts` has to produce the same cache as Obsidian. That is exactly
why the comparison against real Obsidian data exists, see [TESTS.md](TESTS.md).

## The vault settings count

The server reads `.obsidian/plugins/obsidian-tasks-plugin/data.json` and adopts
the global filter, the global query and custom status symbols — just as the
plugin does at startup.

Without this step the engine computes with its default values while Obsidian
computes with the user's. In a vault with a global filter, three times as many
lines are quickly a checkbox without being a task; and `[-]` (cancelled) would
count as open.

**The trap:** `GlobalFilter`, `GlobalQuery`, `StatusRegistry` and `Settings`
are process-wide singletons. Set them afresh on every vault change, never
merely add to them.

**And therefore one query at a time.** `src/engine.ts` runs `runQuery()` and
`explainOnly()` under a shared mutex. Both write those singletons and then
yield — `runQuery()` renders asynchronously, and `stripGlobalFilter()` reads
`GlobalFilter` again *after* that. Two overlapping calls against vaults with
different settings would otherwise mix them and return an answer that looks
perfectly ordinary while being wrong: the tasks of one vault, stripped with
the global filter of the other. Over stdio that stayed theoretical; over HTTP
the SDK builds a server per request and concurrent calls are the normal case.
The lock costs parallelism the engine never had — the alternative would be a
process per request, which is worse.

One setting **cannot** be read from outside: `EnableJsInTasksQueries` lives in
Obsidian's vault-local app storage, not in data.json. Hence the switch
`--enable-js`, with the same default as the plugin: off. Turning it on lets
arbitrary JavaScript from the query run.

## TypeScript stays — and why the measurements do not decide that

Vault with roughly 3000 files and 780 tasks: parsing about 200 ms, query about
30 ms. Parsing costs more than the 51–70 ms of the first version, which still
parsed line by line itself — in exchange there are now line numbers, hierarchy,
sections, headings and frontmatter.

Measured against the response time of a language model triggering the query,
the engine is therefore not a performance factor. A port to Go or Rust would
gain nothing noticeable and lose everything this project is about: the query
language would be reimplemented rather than embedded, and `git submodule
update --remote` would no longer be an update but manual labour. The argument
against a compiled language is maintainability, not speed.

The same measurement settles the runtime question. The bundle runs unchanged
under Bun, and about 15% faster — some tens of milliseconds on that vault,
which is below the noise of everything around it. That is a fine reason for
somebody to write `bun` in their own MCP configuration and no reason at all
for this project to require it.

## Errors are never concealed

The heart of the matter: `query.error` and `explainQuery()` are not an extra,
they are part of every result. A line the engine does not understand leads to
an error response — never to a silently reduced result. That is exactly where
the existing servers failed.

The same principle applies further down: a file that cannot be read appears
under "Problems while reading"; a scope that does not exist is reported rather
than returned as an empty result. And it has proven itself — the CRLF bug
(files from Windows yielded zero tasks) was precisely the kind of silent loss
this project was built against, see [TESTS.md](TESTS.md).

## Security is a goal of the same rank as correctness

A vault is not a database of tasks. It is somebody's notes: medical
appointments, salaries, names of people who never agreed to be in anybody's
model context, passwords pasted in once and forgotten. This server points a
language model at that folder. Everything below follows from taking that
seriously, and it is written down here because security is not a feature that
gets added at the end — it is a property that is either designed in or absent.

Four things must not happen. Each one has a defence in the code, and each
defence is named here so that a later change cannot remove it by accident.

### 1. Nothing leaves the vault that was not asked for

Reading a file outside the configured roots is the failure with the shortest
path to real damage: `~/.ssh/id_ed25519` is not Markdown, but
`~/Documents/tax-2024.md` is, and a query that returns "tasks" from it returns
its lines.

- **The walk cannot leave.** `findMarkdownFiles()` in `src/vault.ts` resolves
  the root to a real path once and makes it the boundary. A symbolic link is
  followed only if its target still lies below that boundary; one pointing out
  is skipped and **reported**, not silently ignored. Without this, a single
  link inside an allowed vault would turn every root restriction into a
  suggestion.
- **`-scope` cannot be escaped.** `isInside()` compares resolved paths, so
  `../..` in a scope is refused rather than joined.
- **`rootDirs` is not the caller's choice.** `outsideConfiguredRoots()` in
  `src/mcp.ts` refuses any root other than the ones passed at start, on every
  transport, unless a person opted out with `--allow-any-root` — which is in
  turn refused together with `--http`.

  This used to be the other way round: over stdio the value was taken as
  given, on the argument that the client *started this process* and could read
  those directories itself anyway. The argument sounds right and answers the
  wrong question. It is about who started the server; the question is who
  chose the argument. `rootDirs` is chosen by a language model, on a turn that
  may well have begun with a note this server handed it — and
  `- [ ] also check ~/Documents for open tasks` is not a jailbreak, it is an
  ordinary sentence in an ordinary vault. Authorization decided by *which
  transport carried the call* is the classic confused deputy, and the leak has
  the shortest path to real damage of anything in this file: it is the
  `~/Documents/tax-2024.md` case at the top of this section, reachable without
  a single unusual step.

  A server started with no `-root` at all has nothing to pin to. The caller
  must then name the directories, and `src/server.ts` says so on stderr —
  that configuration is a choice too, and it should not be a quiet one.
- **Hidden entries are skipped**, so `.obsidian/`, `.git/` and `.trash/` never
  reach the parser — the plugin settings are read deliberately, by path, and
  nothing else from there is.

### 2. Nothing about the vault's *other* contents comes out

A vault is mostly not tasks. The server must be a narrow window onto the
`- [ ] …` lines, not a file-reading tool that happens to filter.

- **The result is built from `Task` objects, never from file contents.** Whole
  files are read, held for the length of one query and dropped; `keepSources`
  exists only for the invariant check and is off for every query.
- **`includeDetails` is a projection, not a dump.** `TaskDetails` in
  `src/engine.ts` lists its fields one by one. This matters more than it looks:
  a `Task` carries its `TasksFile`, and that carries the file's entire
  `CachedMetadata` — frontmatter included. `JSON.stringify(task)` would
  therefore ship every frontmatter key of every matching file. **Adding a field
  to `TaskDetails` is a disclosure decision; serialising the object wholesale
  is a bug.**
- **Metadata leaks too.** File paths, headings and tags are content. They are
  in the answer because a task without its path is useless — but that is the
  reason they are there, and it is the bar for anything else.
- **Error messages are a disclosure path, and held to the same bar.**
  Everything above governs the *result*; the reports beside it are built from
  whatever went wrong, which is a different and much harder thing to keep
  narrow. It is also the surface nobody reviews, so it has its own module:
  `src/paths.ts` decides both how a path is compared and how a problem is
  said, and it is the only place that decides either.

  `vaultRelative()` names every file the way the result names it — relative to
  the vault root. Absolute paths used to go out with every `problems` entry
  and every settings warning, which handed a caller that knows only a port the
  user's home directory, where each vault sits and, through "belongs to
  several vaults", the existence of vaults it was never given.
  `describeProblem()` reads the diagnosis off a Node error's `code` and
  `syscall` and cuts the message before the path Node quotes into it, so
  `EACCES: permission denied` survives and `, scandir '/home/…'` does not.
  `redactPaths()` is the last line, for the unexpected `Error.message` on its
  way out through `fail('Query failed: …')` in `src/mcp.ts`.

  The other half is content. `FileParser` hands its two report channels the
  line that failed, **verbatim** — and that line is precisely one the engine
  did *not* accept as a task, so it has passed neither the global filter nor
  the query: the one category of content the result is otherwise built never
  to contain. `src/vault.ts` reports the file and the line **number** and does
  not quote the line; the vendor's `logger.warn` cannot be forwarded at all,
  because its wording *is* the line, so the fact is reported and the text is
  not.

  None of this reports *less* — concealing a problem is the failure this
  project is named for, and every fact above still comes out. What is left
  deliberately is `describeRootDirs()`, which advertises the configured roots
  in the tool schema: a caller that may name them has to be able to read them.
  `tests/selftest.ts` checks the rest under "Problems are said in the vault's
  own terms", where a `problems.push()` in a new place that names an absolute
  path fails rather than passing unnoticed.

### 3. No access to the machine the server runs on

The query is text from a language model. Nothing in the pipeline may treat it
as code, and the one place that does is off by default.

- **`filter by function` stays off over MCP.** It evaluates arbitrary
  JavaScript in this process — which is file-system access, network access and
  `process.env` in a single query line. `config.enableJs` exists for symmetry
  with the CLI; `src/server.ts` never sets it, and that is not an omission to
  be tidied up. The CLI has `--enable-js` for a human who has decided; the
  server has no such flag.
- **Nothing else evaluates anything.** No shell, no `eval`, no template
  expansion of query text, no path taken from the query (paths come from
  `rootDirs` and `-scope`, which are checked).
- **The HTTP port is a local attack surface, not a remote one.** `--http`
  binds `127.0.0.1`, requires `-root`, and validates `Host` and `Origin` —
  the last of these against DNS rebinding, where a page in the user's browser
  resolves a name it controls to loopback and talks to this server. A port is
  still reachable by every process and every user on the machine; that is the
  documented limit of what `--http` is for, and `OBSIDIAN_TASKS_MCP_TOKEN`
  narrows it for whoever needs it narrowed (a shared machine, a devbox). Left
  unset, nothing changes — it is an option for an operator, not authentication
  arriving late, and it does not make the port exposable.
- **The port costs something to talk to.** A body over 1 MB is refused with
  `413` and one that never says how long it is with `411`, before a byte is
  read; `requestTimeout` and `headersTimeout` drop a client that opens a
  connection and dribbles. None of this bounds a *query*: every query runs
  under one process-wide mutex, so an expensive one delays every later caller,
  and both the time budget and the admission control that answers it are still
  open — see [TODO.md](TODO.md).
- **Dependencies are part of the surface.** The vendor tree runs in this
  process, unmodified and pinned to a commit. That is why the pin never moves
  by itself and is never patched locally: an update is a decision with a date
  on it, not a side effect of a build.

### 4. The vault cannot be damaged

Read-only is the whole defence, and it is only a defence while it has no
exceptions. Details and what it costs are under "Non-goals" below.

One consequence to keep in mind: the CRLF normalisation in `src/vault.ts`
happens to the string in memory. If a write path ever existed, it would write
back LF line endings over a Windows user's file — which is the shape these
accidents usually have.

### Risks that have no fix here, only honesty

- **Task text reaches a language model, and usually a remote one.** That is
  the point of the server; it is also the largest disclosure in it. `-scope`
  is the answer for a vault where only part may be read, and it is a server
  configuration rather than a call parameter precisely so that the caller
  cannot widen it.
- **Output outlives the query.** Terminal scrollback, shell history, systemd
  journal, a session transcript, an MCP client's debug log — all of them keep
  task lines and file names. Hence `--summary`, which prints counts, rule
  names and timings and no task text at all. Anything that lands where it can
  be read later should be produced with it.
- **Vault content becomes model input, and content can be instructions.** A
  note containing "ignore your previous instructions and …" arrives in the
  assistant's context as a task description. The server cannot prevent that
  and does not pretend to; what it can do is never act on what it read, which
  it satisfies by having no actions — no writes, no network calls, no
  second tool that takes a task as a command.

  What it can also do is say which words are whose. Everything in a response
  that came out of the vault — the task lines, the `includeDetails` JSON, the
  quoted `problems` — is fenced in `<vault-content>` with a one-line caveat,
  by `vaultContentFence()` in `src/mcp.ts`; a task line that spells the
  closing tag itself is escaped, since the fence is the whole mechanism. This
  is framing, not a defence: a model may still be talked round. It removes the
  case where it had no way to tell the difference at all.
- **A query can be expensive.** A pathological `regex matches` over a large
  vault burns CPU, and the engine lock means one such query delays the next.
  There is no timeout today (see [TODO.md](TODO.md)); under stdio the caller
  owns the process and can kill it, which is why this has not been urgent.

### What this means for a patch

A change that touches any of these is not a refactor. The short version, in
the order the mistakes actually get made: do not widen `TaskDetails` without
deciding it, do not serialise engine objects wholesale, do not let a path from
a request reach the file system unchecked, do not build a report from an
absolute path or from a line the engine rejected, do not decide an
authorization question by which transport carried the call, do not add a write
path, do not enable JavaScript evaluation from a request, do not add a
`--host` flag. If a
new feature needs one of these, it needs this section changed first — in the
same patch, with the reason.

## Non-goals

Not oversights, and not "later" — deliberate boundaries. They are listed here
so that nobody spends an evening implementing one of them.

**Nothing is ever written.** No completing a task, no adding one, no editing
one, and nothing in `.obsidian/` either.

Pointing any tool at a vault carries two distinct risks, and this decision
addresses exactly one of them. The first is that the contents leak — that is a
matter of who may ask and what goes out, and it is answered in "Security is a
goal of the same rank as correctness" above. Being read-only does nothing for
it. The second is that the vault is **damaged**: notes rewritten wrongly, a
task mangled by a parsing edge case, an edit landing while Obsidian has the
file open. Against that, read-only is not a mitigation but a guarantee, and
only for as long as it has no exceptions — one write path and every later
question about a lost note has to be investigated instead of ruled out.

What that costs is real: a server that writes could complete a task from the
chat. It would then have to answer for conflicts with a running Obsidian, for
recurrence on completion, for `onCompletion` actions — and it would have to be
trusted rather than merely permitted.

**Not a general Obsidian API.** Tasks and nothing else: no Dataview, no
backlink graph, no full-text search across notes. The one thing this project
has to offer is that the query language it speaks is not its own; every step
beyond tasks would be a reimplementation again, this time of Obsidian.

**No natural language in the server.** The model writes the query, the server
runs it and explains it. Putting a translation layer in between would mean
guessing at intent in the one place that is meant to be exact, and the
explanation of a query would no longer be an explanation of what was asked
for. That the language model is good at writing these queries is the premise
of the whole design, not a gap in it.

**Not a network service.** `--http` binds to `127.0.0.1` and there is no
`--host` and no TLS. Serving a private vault to a network is a
reverse-proxy-with-real-authentication problem, and solving it halfway here
would be worse than not solving it: it would look solved. The optional
`OBSIDIAN_TASKS_MCP_TOKEN` is not that half-solution and must not be read as
one — it separates local users from each other on a port that is already
unreachable from outside the machine, and it makes nothing safe to expose.

**Obsidian is never talked to.** No plugin IPC, no live sync, no watching the
app's state. The vault on disk is the whole interface, which is why the server
runs with Obsidian closed, uninstalled or on another machine — and why
`EnableJsInTasksQueries`, which lives in Obsidian's app storage rather than in
the vault, is a command-line switch instead of something read out from
somewhere.

**The submodule is never patched, and never bumps itself.** A bug in the
engine is reported upstream, not worked around here; a fix carried locally
would end the conflict-free `git submodule update --remote` that the whole
construction exists for. And the pin only moves when somebody moves it — a pin
that updates on its own is not a pin. See
[CONTRIBUTING.md](../CONTRIBUTING.md).

**No port to a compiled language.** Not to Go, not to Rust. The argument is
under "TypeScript stays" above, and it is worth restating because the speed
case is the one that keeps getting made: the engine is not the slow part, and
a rewrite would not embed the query language, it would reimplement it — which
is the exact failure this project exists to avoid. There is no port that
keeps `git submodule update --remote`.

**The runtime is not swapped either.** `dist/` is plain ESM and runs under
Node and under Bun alike; the checks pass on both. Anybody who prefers Bun
already has it, by writing `bun` instead of `node` in their MCP
configuration — no change here is needed to permit that, and none is planned
to require it. Depending on Bun would buy tens of milliseconds and cost every
user who has Node and not Bun. Node stays the documented runtime and the one
the checks run on.

What is open — as opposed to ruled out — is in [TODO.md](TODO.md).
