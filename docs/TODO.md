# TODO

What is still open. Written in the **Obsidian Tasks format**, so the list is
at the same time a worked example of what the server reads: priorities, tags,
dependencies, recurrence, created and done dates, cancelled tasks. How to
query it is at the bottom.

Priorities, highest to lowest: 🔺 ⏫ 🔼 (nothing) 🔽 ⏬.

## The project

- [ ] Watch the first real CI run. The workflow is written (`.github/workflows/ci.yml`: a `--recurse-submodules` checkout, `npm test` on Node 22 and 24), but it has never run — there is no remote yet. The submodule is the most common way a fresh clone fails, and it fails for the newcomer rather than for anyone who already has it checked out, so the run itself is the point, not the file #tests ⏫ ➕ 2026-09-12
- [ ] Decide about npm, if the project is ever well received enough for the question to arise. An MCP server is configured with a command line, and `git clone && npm install && npm run build` obtains one perfectly well, so nothing is waiting on this — but a package is a second distribution channel, and the shape it would take (source, a curated `dist/`, or nothing at all) should be chosen deliberately rather than arrived at. The bundle inlines the engine and would have to carry both copyright notices; that is the part that is an obligation rather than a chore #maintenance ⏬ ➕ 2026-09-12

## The server

- [ ] A result budget for `query_tasks`: a `limit` parameter and an explicit "N further tasks not shown" line. A broad query over a large vault returns an enormous block of Markdown into the model's context. Truncating silently would be the very failure this project exists against, so the notice is the point, not the limit #mcp ⏫ ➕ 2026-09-12
- [ ] A `vault_info` tool, so an assistant can see the configured roots, the global filter and the custom statuses without first running a query — today that information only arrives attached to a result #mcp 🆔 vault-info 🔼 ➕ 2026-09-12
- [ ] Count the request body rather than believe it. A body without a `Content-Length` is refused outright today (`411`), which closes the chunked-request hole at the cost of a client that would have been legitimate — no MCP client sends one, but no rule says none ever will. A byte counter ahead of the SDK's own reader would accept it and still stop at the limit; the awkward part is counting without consuming what the SDK is about to read #mcp 🔽 ➕ 2026-09-12
- [ ] Offer the quick reference as an MCP resource as well as a tool, for clients that pre-load resources and would then have the syntax in context without spending a call #mcp 🔽 ➕ 2026-09-12
- [ ] Named roots (`-root work=/path/to/vault`), so answers spanning several vaults can say which one a task came from. The names have to be reported somewhere before they are worth giving #mcp ⛔ vault-info ⏬ ➕ 2026-09-12
- [ ] Semantic search over task descriptions, for what `description includes` and `regex matches` cannot find: "anything about the backup", when the task says "test restoring the NAS snapshot". An idea, not a plan — it runs into four of the boundaries in [ARCHITECTURE.md](ARCHITECTURE.md), and those have to be settled before any code #mcp #engine 🔽 ➕ 2026-09-12
    - **Not as a new instruction in the query language.** A `description similar to …` line would be the first instruction Obsidian does not understand, so a query could no longer be pasted into a note — and it would have to live in the engine, which is never patched. The shape that keeps both: a separate, optional parameter of `query_tasks` (say `similarTo: string`, with `limit`), applied *after* the Tasks query has run. The query still decides which tasks are eligible; the similarity only orders them and cuts the list. It depends on the result budget above, which it would share.
    - **Ranking rather than a threshold.** A cosine cut-off that works for one embedding model and one language fails for the next, and a silently empty result is the failure this project exists against. Order by similarity and show the top N with their scores; a threshold, if ever, as an explicit second parameter.
    - **Where the vectors come from: pluggable, and off by default.** (a) An OpenAI-compatible `/v1/embeddings` endpoint — llama.cpp's `llama-server`, Ollama, LM Studio or a hosted API — configured by URL and model on the command line, never per request. (b) A small local model in-process via `node-llama-cpp`, e.g. EmbeddingGemma-300M, which is fast enough on a CPU for task-length strings. (a) adds no dependency but is a network call, which "no network calls" in the risk section rules out today; (b) keeps everything in the process but adds a heavy optional dependency. Either way the section on risks has to be changed in the same patch, and a remote endpoint means task text leaves the machine a second time, to a second party.
    - **Embed tasks, not files.** Vectors per task line, cached by a hash of the description and the model name, computed only for the tasks the query already let through — so `-scope` and the filters bound the cost as well as the disclosure. Compute them before the engine lock is taken, so a cold cache does not stall other callers; the query time budget has to count this time too. Mind the model's prompt conventions: EmbeddingGemma expects different prefixes for queries and documents, and results degrade noticeably without them.
    - **Reusing an existing search index such as [qmd](https://github.com/tobi/qmd).** Tempting, since a vault indexed by qmd already has embeddings, but a poor fit: its vectors belong to chunks of whole notes, so every task in a chunk would get the same score; its SQLite schema is internal and changes with its releases; and it indexes the entire vault, so reading it would bypass `-scope`. What can reasonably be shared is the model — the same GGUF file for (b), or the same local endpoint for (a) — not the index. Pre-selecting files with qmd's own MCP server and then running a Tasks query over them is possible as well, but that is two tools an assistant can already combine, not a feature of this one.

## The engine and the vault

- [ ] Cache parsed files, keyed on modification time and size. Every query re-reads the whole vault (about 200 ms for 3000 files); under `--http` the process is long-lived and the same query repeats. Invalidation has to be a `stat` per file, never a timer — a cache that quietly serves a stale task is the silent-loss failure again, one layer down #engine ⏫ ➕ 2026-09-12
- [ ] A time budget for a single query, reported rather than silent. A pathological `regex matches` over a large vault burns CPU, and the engine lock means the next caller waits for it; under `--http` nobody owns the process the way a stdio client does. The transport now bounds what it can bound — body size and socket timeouts — but that is the cost of *arriving*, not the cost of running. The answer has to say that the query was stopped, not return a short result #engine #security ⏫ ➕ 2026-09-12
- [ ] Admission control for `--http`, beside that budget. Every query runs under the engine lock, one at a time, because the plugin's settings are process-wide singletons — so a slow query does not only cost its own caller, it stalls every later one, and an HTTP client can queue without limit. A request that waits too long for the lock has to be refused while it is still waiting, with a reason. The budget above bounds one query; this bounds the queue behind it #engine #mcp 🔼 ➕ 2026-09-12
- [ ] Exclusions: skip `.trash/`, template folders, or whatever an ignore file names. Today everything under the root is parsed #engine 🔼 ➕ 2026-09-12
- [ ] Grow `examples/` until every family of filters appears at least once. The self-check parses them, so an instruction that upstream renames or drops is reported — the wider the corpus, the sharper that tripwire on a submodule bump #tests 🔼 ➕ 2026-09-12

## Standing duties

Recurring, and both are reports rather than automation: nothing here moves by
itself.

- [ ] Check whether the submodule pin is behind upstream, and whether the version named in the README still matches #maintenance 🔁 every 3 months 📅 2026-12-12
- [ ] Check whether the MCP specification has a new revision, and whether the SDK has followed it #maintenance 🔁 every 6 months 📅 2027-03-12

## Decided against

Cancelled rather than deleted, so that nobody proposes them a second time. The
reasons are in [ARCHITECTURE.md](ARCHITECTURE.md) under "Non-goals".

- [-] Write to the vault — complete tasks, add tasks, edit them #engine ❌ 2026-09-12
- [-] Translate natural language into Tasks queries inside the server #mcp ❌ 2026-09-12
- [-] Port the engine to a compiled language — Go, Rust or otherwise #engine ❌ 2026-09-12
- [-] Swap the runtime from Node to Bun. It runs there already and about 15% faster; requiring it would cost every user who has Node and not Bun #engine ❌ 2026-09-12

## Done

- [x] Pin `rootDirs` to the `-root` directories on every transport, not only under `--http`, with `--allow-any-root` as the human opt-out #mcp #security ✅ 2026-09-12
- [x] Say problems in the vault's own terms: relative paths, line numbers instead of lines, `src/paths.ts` as the one place that decides #security #engine 🆔 relative-problems ✅ 2026-09-12
- [x] Lock that down with a test, where a path is built and not only where one is printed #tests #security ⛔ relative-problems ✅ 2026-09-12
- [x] Close the last two gaps in the walk test — a broken link, and a file that cannot be read once the walk has listed it #tests #engine ✅ 2026-09-12
- [x] Mark what came out of the vault as read data rather than as instructions, and escape a task line that spells the fence #mcp #security ✅ 2026-09-12
- [x] Bound what a request may cost to arrive: a body size limit, and socket timeouts for a client that dribbles #mcp #security ✅ 2026-09-12
- [x] An optional shared secret for `--http`, for a machine with more than one user on it #mcp #security ✅ 2026-09-12
- [x] Serve Streamable HTTP alongside stdio, on MCP SDK v2 #mcp ✅ 2026-09-12
- [x] `--summary`: run against a real vault without printing its contents #engine ✅ 2026-09-12
- [x] Restrict reading to a subpath with `-scope` #engine ✅ 2026-09-06
- [x] Compare `src/metadata.ts` against real Obsidian cache data #tests ✅ 2026-09-01

## Querying this file

Point the server at `docs/` and this file is the vault. From the repository
root:

```bash
node dist/cli.js docs examples/todo.txt
```

That is a smoke test, not a test vault: it needs nothing of your own, so it
shows in one command that the build reads tasks at all — but it is a single
short file, and it gets shorter as items are ticked off. What the engine can
do is measured against `tests/fixture-vault/` and a real vault, see
[TESTS.md](TESTS.md).

`examples/todo.txt` holds the query below — what is open, hardest first, and
nothing that is waiting on something else:

```tasks
not done
is not blocked
sort by priority
group by heading
```

Everything the format offers here is queryable in the same way: `priority is
above medium`, `tag includes #mcp`, `is blocked`, `due before tomorrow`,
`done after 2026-09-01`, `status.type is CANCELLED`. The full list of
instructions is what the `tasks_query_syntax` tool returns.
