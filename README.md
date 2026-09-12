<div align="center">

# Obsidian Tasks Engine MCP

**Your whole task list, one question away —
answered by the real Obsidian Tasks query engine.**

[![CI](https://github.com/Cito/obsidian-tasks-engine-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Cito/obsidian-tasks-engine-mcp/actions/workflows/ci.yml)
[![Obsidian Tasks 8.4.0](https://img.shields.io/badge/Obsidian%20Tasks-8.4.0-7C3AED?logo=obsidian&logoColor=white)](https://github.com/obsidian-tasks-group/obsidian-tasks)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20HTTP-111111?logo=modelcontextprotocol&logoColor=white)](https://modelcontextprotocol.io)
[![Node.js ≥ 22](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/github/license/Cito/obsidian-tasks-engine-mcp)](LICENSE)

</div>

An [MCP](https://modelcontextprotocol.io) server that runs the **real query
engine of the [Obsidian Tasks](https://publish.obsidian.md/tasks/) plugin**
outside of [Obsidian](https://obsidian.md).

[Obsidian](https://obsidian.md) keeps your notes as plain Markdown files in a
folder called a vault, and the
[Obsidian Tasks](https://publish.obsidian.md/tasks/) plugin
([source](https://github.com/obsidian-tasks-group/obsidian-tasks)) turns the
`- [ ] …` lines in them into real tasks, with due dates, recurrence and
dependencies between them. What makes the plugin worth building on, though, is
its **[query language]**: instructions such as `not done`, `due before
tomorrow`, `is not blocked` or `group by filename`, written one per line,
across forty kinds of filter.

That query language is what this server hands to an AI assistant. MCP, the
[Model Context Protocol](https://modelcontextprotocol.io), is an open
standard for offering an assistant tools it can call and letting it decide
when to call them; here the central tool takes a Tasks query and runs it over
your vault.

So the range of what you can ask for is the range of the query language
itself. "What is due today, and leave out anything that still depends on
another task" is one obvious example; equally possible are "which tasks under
Projects/ have no due date at all", "group everything open by file and sort
by urgency", "what did I finish last week", "what is scheduled for this month
and tagged #work". Anything that would work in a `tasks` code block inside
Obsidian works here.

**Obsidian itself need not be running** — nor even be installed. The server
reads the Markdown files directly, so the vault can be queried with the app
closed, on a headless server, over SSH, or from a script. And it only reads:
nothing is ever written back.

Every other Obsidian Tasks MCP server we are aware of reimplements that query
language in code of its own, and so supports only part of it — usually
without saying which part. This one takes the opposite route: the plugin
comes in unchanged as a git submodule, and its `Query` class is called
directly. Every filter is therefore available — boolean combinations,
relative dates, recurrence rules — and stays available, because keeping up
with the plugin is a `git submodule update` rather than a reimplementation.

How that works is described below under "How it works"; why it is built this
way, in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. If you want to
contribute, start at **[CONTRIBUTING.md](CONTRIBUTING.md)**.

> Built and tested against **obsidian-tasks 8.4.0**. The submodule is pinned
> to an exact commit — `git submodule status` names it — and that pin is what
> the test suite runs against. The version here is checked by `npm test`, so
> it cannot quietly fall behind the submodule.

## Features

- **The whole query language**, run by the plugin's own `Query` class —
  boolean combinations, relative dates, recurrence, dependencies, grouping and
  sorting.
- **No silently dropped filters.** Every response explains the query as the
  engine understood it; a line it does not understand is an error, not a
  smaller result.
- **Reads the vault the way Obsidian does:** the plugin's `FileParser`, your
  global filter, global query and custom statuses, frontmatter as real YAML —
  checked against real Obsidian data from the submodule.
- **Read-only and bounded.** Nothing is written; nothing outside the configured
  vault is read; `-scope` restricts the server to part of it.
- **Two transports:** stdio, or Streamable HTTP on loopback with an optional
  shared secret.
- **Three tools:** `query_tasks`, `explain_query` and `tasks_query_syntax`,
  with the same names and parameters as the Go server it replaces.
- **A CLI** for running queries and for `--check`, which verifies invariants on
  any vault of your own, with `--summary` for output that must not quote tasks.

## What it does not do

Boundaries, not omissions — the reasoning is in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** under "Non-goals":

- **It never writes.** No completing or adding tasks, nothing in `.obsidian/`.
  Your vault is only ever read, so nothing here can damage it.
- **Tasks only** — not a general Obsidian API: no Dataview, no backlinks, no
  full-text search across notes.
- **It does not invent queries.** The assistant writes the query; the server
  runs it and explains it, and refuses what it does not understand.
- **It is not a networked service.** `--http` listens on loopback and there is
  no `--host` and no TLS; exposing a vault to a network is left to a proper
  reverse proxy. (An optional shared secret narrows who on the *same* machine
  may call it — that is a different, smaller thing.)
- **It does not talk to Obsidian.** The vault on disk is the whole interface.

Those boundaries are mostly there for one reason: a vault is private. Medical
appointments, salaries, other people's names. So the server reads only below
the roots it was given — a symbolic link pointing out of the vault is skipped,
not followed, and a call may not name a directory outside them unless a person
allowed that at the command line. It returns tasks and nothing else from the
files it reads, says its problems in the vault's own terms rather than in
absolute paths, marks everything that came out of the vault as read data
rather than as instructions, never evaluates JavaScript from a query unless a
human turns it on at the command line, and never writes. `-scope` narrows it to part of a vault, `--summary`
keeps task text out of anything that gets logged. The full risk model — what
could go wrong and which code prevents it — is in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** under "Security is a goal of
the same rank as correctness". Found a way around it? Please report it
privately, as described in **[SECURITY.md](SECURITY.md)**.

What is open, as opposed to ruled out, is in
**[docs/TODO.md](docs/TODO.md)** — itself written in the Tasks format, and
queryable with the server.

## Setup

```bash
git clone --recurse-submodules <repo> obsidian-tasks-engine-mcp
cd obsidian-tasks-engine-mcp
npm install
npm run build
```

If you have already cloned without it, fetch the submodule afterwards:

```bash
git submodule update --init --depth 1
```

> **`--recurse-submodules` is not optional, and GitHub's "Download ZIP" does
> not include submodules.** A ZIP, or a plain `git clone`, leaves
> `vendor/obsidian-tasks` empty and the build fails immediately — the
> submodule *is* the engine. Use the clone command above.

> **`dist/` is not in the repo** (see `.gitignore`). After a fresh clone and
> after every `git pull`, `npm install && npm run build` has to have run, or
> `dist/server.js` will not be there and the server will silently fail to
> start.

This is all that setup is, for both ways of running the server below: the
build produces `dist/server.js`, and how it is then reached — started by the
client over stdio, or running as a service on a port — is a matter of
configuration, not of installing anything further.

## Usage

### As an MCP server

It offers three tools:

| Tool | Parameters | Purpose |
|---|---|---|
| `query_tasks` | `rootDirs?`, `filters`, `includeDetails?` | Run a query |
| `explain_query` | `rootDirs?`, `filters` | Only check and explain a query, without reading the vault |
| `tasks_query_syntax` | — | Look up every available instruction, generated from the submodule's documentation |

Every response contains the explanation of the query and the vault settings in
force. A line that was not understood leads to an error response — **never** to
a silently reduced result.

There are **two ways to run it**, and they differ only in how the client
reaches the server — the same three tools, the same answers, the same vault:

| | stdio (default) | HTTP (`--http`) |
|---|---|---|
| Who starts the server | the client, as a subprocess | you, before the client connects |
| Configured with | a `command` line | a `url` |
| Lifetime | as long as the client runs | long-lived; several clients can share it |
| `rootDirs` from a call | only the `-root` directories | only the `-root` directories |
| Opening that up | `--allow-any-root` | not possible |

Use stdio unless something rules it out — it needs no process management and
nothing listening on a port. HTTP is for the cases where the client cannot
spawn a subprocess (a container, a remote or web-based client, anything that
only accepts a URL), or where several clients should share one server.

#### Over stdio

This is the default and needs no flag. The client starts the server itself,
so there is nothing to launch or keep alive:

```bash
node dist/server.js -root /path/to/vault -root /path/to/second-vault
node dist/server.js -root /path/to/vault -scope Subfolder/
```

Most clients are configured with a block like this:

```json
{
  "mcpServers": {
    "obsidian-tasks": {
      "command": "node",
      "args": ["/path/to/obsidian-tasks-engine-mcp/dist/server.js",
               "-root", "/path/to/vault"]
    }
  }
}
```

Call shape, tool names and parameters are deliberately those of the older
Obsidian Tasks MCP server written in Go: switching over means swapping the
`command` line in the MCP configuration and nothing else.

#### Over HTTP

`--http [port]` (default `3000`) serves Streamable HTTP on `POST /mcp`. Here
**the server is a long-lived process that you start yourself** and the client
only connects to it — so unlike stdio, running it is a step of its own.

```bash
node dist/server.js -root /path/to/vault --http 3000
```

It stays in the foreground and reports the endpoint on stderr:

```
MCP over Streamable HTTP on http://127.0.0.1:3000/mcp
```

Point the client at exactly that URL:

```json
{
  "mcpServers": {
    "obsidian-tasks": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

To check by hand that it is up, without involving a client — it answers
with its name, version and capabilities:

```bash
curl -sS http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
       "protocolVersion":"2025-06-18","capabilities":{},
       "clientInfo":{"name":"curl","version":"1"}}}'
```

##### Keeping it running

In a terminal the process ends with the terminal. For anything beyond trying
it out, run it under whatever supervises your other background processes. On
a systemd machine, a **user** service is the least intrusive way — no root,
and it stops when you log out unless you ask otherwise:

```ini
# ~/.config/systemd/user/obsidian-tasks-mcp.service
[Unit]
Description=Obsidian Tasks MCP server

[Service]
ExecStart=/usr/bin/node /path/to/obsidian-tasks-engine-mcp/dist/server.js \
          -root /path/to/vault --http 3000
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now obsidian-tasks-mcp
systemctl --user status obsidian-tasks-mcp     # is it up?
journalctl --user -u obsidian-tasks-mcp -f     # what is it saying?
```

> **`ExecStart` needs the absolute path to `node`, and systemd does not see
> your shell's `PATH`.** If you manage Node versions with `fnm`, `nvm`, `asdf`
> or `volta`, `/usr/bin/node` is either missing or a different version than
> the one you build with. `command -v node` names the one you are actually
> using — put that path in the unit.

`systemctl --user` services stop when your last session ends; `loginctl
enable-linger $USER` keeps them running across logouts and from boot.

##### What HTTP restricts

Two restrictions come with it, and neither can be switched off:

- **The server binds to `127.0.0.1` and nowhere else.** There is no `--host`.
  The vault is private, and exposing it to a network is a
  reverse-proxy-with-real-authentication problem that this server
  deliberately does not try to solve.
- **`-root` is required, and those roots become a boundary.** `rootDirs` may
  then only name directories passed at startup; anything else is refused. Over
  stdio the client started this process and could read those directories
  itself anyway, so letting it choose is no extra freedom — a port has no such
  relationship, and without the restriction anything able to reach it could
  name any directory on the machine and have it read out.

Three more limits apply to the port itself, none of them configurable:
a request body over **1 MB** is refused with `413`, a body that arrives
without a `Content-Length` with `411` (an MCP request is one JSON document
whose size is known before it is sent), and a client that opens a connection
and then dribbles is dropped after 30 seconds. None of this bounds how long a
*query* may take — see [docs/TODO.md](docs/TODO.md), where that is still open.

##### A shared secret, if the machine is shared

Loopback is the boundary, and it is a real one: nothing off this machine can
reach the port. What it does not separate is one local user or process from
another. On a shared machine, a devbox or a container where that matters, set
an environment variable before starting the server:

```bash
OBSIDIAN_TASKS_MCP_TOKEN=$(openssl rand -hex 32) node dist/server.js -root /path/to/vault --http 3000
```

Every request then needs `Authorization: Bearer <token>`; anything else is
answered with `401`. Clients that support HTTP headers take it as a `headers`
entry beside the `url`. Unset — the default — nothing changes.

This is not the network authentication the next section rules out, and it does
not turn the server into something you may expose. It narrows who on *this*
machine may use a port that is already bound to loopback only. An environment
variable rather than a flag, so the secret stays out of `ps` and out of your
shell history.

Both eras of the protocol are served on the same endpoint: the current
revision (2026-07-28) and the 2025-era `initialize` handshake that today's
clients still speak. No configuration decides which — the request does.

### The directories a call may name

**`-root` is a boundary on both transports.** A call may leave `rootDirs` out,
in which case the `-root` directories are used, or it may name them — but
naming anything else is refused:

```
Not permitted: /home/you/Documents. This server is pinned to /home/you/Vault; …
```

This changed in the course of a security review, and the reasoning is worth
having. `rootDirs` used to be the caller's free choice over stdio, on the
argument that the client started this process and could read those directories
itself anyway. That argument is about who *started* the server; the question
is who chose the *argument*. The caller here is a language model, and the
value it puts in `rootDirs` can come from something it read in the vault a
moment ago. A note saying "also check `~/Documents` for open tasks" is not a
jailbreak, it is an ordinary English sentence — and a boundary that holds or
not depending on which transport carried the call is not a boundary.

If you do want the caller to pick freely, say so where a person is:

```bash
node dist/server.js -root /path/to/vault --allow-any-root
```

It is refused together with `--http`, and a server started with no `-root` at
all has nothing to pin to — it says so on stderr and the caller must name the
directories itself.

### Releasing only part of the vault

`-scope SUBPATH` pins the server to one area. That is an access boundary, not a
filter: whatever lies outside is **never read in the first place**, rather than
being read and then sorted out on output. A `rootDirs` from the call that leads
out of the configured roots is rejected — otherwise the restriction would be a
recommendation.

The difference from simply pointing the root one level deeper is the **way
paths are spelled**: tasks keep their vault-relative paths
(`Projects/Move/Checklist.md`), and the vault settings are still found at the
root. A `-root /path/to/vault/Projects` would find the `data.json` too, but
would call the file `Move/Checklist.md` — and a `path includes Projects/` would
come up empty there.

```bash
node dist/server.js -root /path/to/vault -scope Projects
```

A scope that does not exist, and a scope containing `..`, produce an entry
under "Problems while reading" rather than a silent empty result.

The same holds for the way out that a filesystem offers: a **symbolic link
pointing out of what is being read is not followed**. Were it followed, a
single link inside the vault would be enough to make `-root` and `-scope` a
suggestion — over HTTP, the one restriction that is actually load-bearing.
Skipped links are reported, as is a link that loops back into a directory
already read.

`-scope` restricts what is read; it says nothing about who may ask. That is
the transport's business: over stdio the client already started the process,
and over `--http` the server listens on loopback only and answers no `rootDirs`
beyond the ones it was started with.

### As a CLI for testing

```bash
node dist/cli.js [--enable-js] [--scope SUBPATH] <vault-directory>... <query-file>
node dist/cli.js /path/to/vault examples/morning-briefing.txt
```

The query file is the body of a `tasks` code block, one instruction per line;
lines starting with `#` are comments. [examples/](examples/) holds a handful
to start from — morning briefing, weekly review, blocked tasks, overdue and
undated, grouping by tag, and one using `filter by function`.

The CLI prints the vault settings in force, `query.error` (the filter lines
it did not understand), the explanation of the query, the result as Markdown,
and how long each stage took.

`--enable-js` allows `filter by function` and relatives. The default is off, as
in the plugin: the setting lives in Obsidian's vault-local app storage and
cannot be read from outside.

### Checking your own vault

```bash
npm run check -- /path/to/vault
node dist/cli.js --check --scope Projects /path/to/vault
node dist/cli.js --check --summary /path/to/vault   # counts only, no task text
```

Instead of running a query, `--check` verifies properties that must hold for
**every** vault: that the line number of a task points at its line, that
equally indented siblings stay siblings, that the tree is a tree, that the
preceding heading is right, that no character is lost while parsing.

This needs no expected result and knows nothing about the content — so it runs
on a vault with thousands of files just as it does on a test collection. If you
want to know whether the engine reads your vault the way Obsidian displays it,
start here. Details and limits: **[docs/TESTS.md](docs/TESTS.md)**.

### Output that leaves the machine

A query result is task text throughout, and a finding quotes the line it
found and names the note it sits in. Since a vault is usually private,
anything destined for a bug report, a CI log or a terminal shared with a
language model should be produced with **`--summary`**, which prints counts,
rule names and timings and no task text, note names or quoted lines at all.
It works for `--check` and for ordinary queries alike.

```bash
node dist/cli.js --check --summary /path/to/vault
node dist/cli.js --summary /path/to/vault examples/morning-briefing.txt
```

That way discretion does not depend on somebody remembering to redact
afterwards — and `tests/selftest.ts` drives the real CLI to verify that
nothing slips through.

## How it works

The query part of `obsidian-tasks` is fully decoupled from Obsidian:
`src/Query/` contains 67 files and **not a single** import from `'obsidian'`.
Only five symbols with real meaning have to be replaced, plus a few dummies for
classes that merely come along through import chains. `src/obsidian-shim.ts`
takes care of that; at build time esbuild aliases the module `obsidian` to it
(`scripts/build.mjs`).

```
src/obsidian-shim.ts   replacement for the runtime symbols from 'obsidian'
src/metadata.ts        Markdown → Obsidian's CachedMetadata   ← the heart
src/settings.ts        adopt the vault settings
src/paths.ts           how a path is compared, and how a problem is said
src/vault.ts           read the vault → Task[], via the plugin's FileParser
src/engine.ts          build, run and shape the query
src/invariants.ts      checks that hold for every vault (--check)
src/cli.ts             test tool without the MCP layer
src/server.ts          MCP server: entry point, stdio and HTTP transport
src/mcp.ts             the three tools and the text they return
src/quick-reference.ts query language quick reference from vendor/…/docs
vendor/obsidian-tasks  submodule, unmodified
```

The second trick besides the alias: `src/vault.ts` parses nothing itself. It
builds, for every file, the cache Obsidian would hand the plugin, and passes it
to the plugin's **unmodified** `FileParser`. That is why the tasks carry line
number, section, preceding heading and their place in the list tree.

## The vault settings count

The server reads `.obsidian/plugins/obsidian-tasks-plugin/data.json` and adopts
the global filter, the global query and custom status symbols — just as the
plugin does at startup. That is not a detail: in a vault with a global filter,
three times as many lines are quickly a checkbox without being a task, and
`[-]` (cancelled) would count as open.

Why the project is built this way and not otherwise:
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Checks

```bash
npm test
```

Four layers: static checks (`tsc --noEmit` and ESLint over `src/`, `tests/`
and `scripts/`), which need neither a run nor a vault; a self-check against a
test vault with hand-written expectations; invariants that need no expected
result and therefore run on any vault; and the comparison of `src/metadata.ts`
with **real Obsidian data** from the submodule (89 notes at the time of
writing, each with the `CachedMetadata` Obsidian itself produced). Details:
**[docs/TESTS.md](docs/TESTS.md)**.

All four pass after a fresh clone — no existing vault required.

## Measurements

Vault with roughly 3000 files and 780 tasks: parsing about 200 ms, query about
30 ms. Measured against the response time of a language model triggering the
query, the engine is not a performance factor. Context:
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Acknowledgements

This server is a thin layer; the substance is other people's work.

- **[Obsidian](https://obsidian.md)**, made by a small independent team founded
  by Erica Xu and Shida Li, for keeping notes as plain Markdown files in a
  folder — which is the only reason a vault can be read without the app at all.
- **[Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)**,
  created by Martin Schenck and developed and maintained by Clare Macrae and
  Ilyas Landikov, together with its many contributors. The query engine this
  server runs is theirs, and so is much more that it relies on: the parser,
  the documentation that `tasks_query_syntax` is generated from, and the
  real Obsidian data the comparison tests check against. Their query code is
  cleanly enough separated from Obsidian to run outside it unmodified — which
  is what made this project possible in the first place.

If the Tasks plugin is useful to you, consider
[sponsoring its development](https://github.com/sponsors/claremacrae).

## Origin

Code, tests and documentation were written with
**[Claude Code](https://claude.com/claude-code)** — under human direction and
review. The guard rails followed while doing so are in [CLAUDE.md](CLAUDE.md);
a detailed map of the embedded engine sits as a skill in
[.claude/skills/obsidian-tasks-engine/](.claude/skills/obsidian-tasks-engine/).

## License

MIT, © Christoph Zwerschke — see [LICENSE](LICENSE).

This repository contains **no** obsidian-tasks code. `vendor/obsidian-tasks`
is a submodule: git stores a URL and a commit id, and `git clone
--recurse-submodules` fetches the code from upstream, under upstream's own
licence. The note here is for orientation, not an attribution — it tells you
what you are about to pull and on what terms.

[obsidian-tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) is
MIT as well (© 2021 Clare Macrae, Ilyas Landikov and Martin
Schenck), which is compatible in both directions. That matters at exactly one
point: `npm run build` bundles vendor code into `dist/`, so a **build
artefact** is a derived work and has to carry both copyright notices. As long
as `dist/` stays out of the repo and the package stays `private`, nothing is
being distributed and the question does not arise — but anyone publishing a
build has to ship both notices.

The name says what this server works with, not who stands behind it. This is
a third-party project: not affiliated with Obsidian or with the Obsidian Tasks
project, and endorsed by neither. The plugin is embedded unmodified, but
anything that goes wrong here is this repository's to answer for — bug reports
belong in this issue tracker, not upstream.

[query language]: https://publish.obsidian.md/tasks/Queries/About+Queries
