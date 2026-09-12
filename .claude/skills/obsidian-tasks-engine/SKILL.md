---
name: obsidian-tasks-engine
description: Map of the embedded Obsidian Tasks plugin (vendor/obsidian-tasks) — which vendor class is responsible for what, which runtime symbols the shim has to provide, how the plugin starts up, and which contracts (ListItemCache, CachedMetadata, settings singletons) have to be honoured. Invoke before working on src/vault.ts, src/obsidian-shim.ts, src/metadata.ts or src/settings.ts, or when a query does not return what Obsidian itself displays.
---

# The obsidian-tasks engine outside of Obsidian

Guiding principle: **look it up instead of reimplementing it.** Nearly
everything needed here already exists in the submodule. Reimplementing a
function that exists there reproduces exactly the mistake this project exists
because of. And `vendor/obsidian-tasks` is **never** modified.

## How cleanly the engine is decoupled

| Directory | Coupling to Obsidian |
|---|---|
| `src/Query/` (67 files, 40 filter classes) | **none** |
| `src/Task/` | only `import type` (`LinkCache`, `Reference`) |
| `src/Scripting/`, `src/DateTime/`, `src/Statuses/` | only `import type` |
| `src/Obsidian/` | genuinely coupled — but `FileParser` and the static helpers from `Cache` are usable |
| `src/ui/`, `src/Config/SettingsTab.ts`, `src/Renderer/Html*` | genuinely coupled, not needed |

## The shim (`src/obsidian-shim.ts`)

esbuild aliases `obsidian` to this file (`scripts/build.mjs`). Only symbols
needed at **run time** have to exist:

- Real semantics required: `getAllTags`, `parseFrontMatterTags`,
  `getLanguage`, `prepareSimpleSearch`, `Notice`.
- Inert dummies suffice: everything dragged in only through `import` chains
  but never called — for example `MetadataCache`, `Vault`, `TFile`,
  `TAbstractFile`, `debounce` (from `Obsidian/Cache.ts`).

If the build fails with "No matching export … 'obsidian'", a new vendor module
has found its way into the bundle. First check whether that module is really
needed; if it is, add a dummy.

## How the plugin starts up (`src/main.ts`)

This order has to be reproduced, otherwise the engine computes with defaults
rather than with the user's values:

1. Provide `window.moment` (Obsidian does this globally).
2. `await initializeI18n()` — otherwise `i18n.t()` throws.
3. `updateSettings(data)` with the content of
   `<vault>/.obsidian/plugins/obsidian-tasks-plugin/data.json`.
4. `GlobalFilter.getInstance().set(settings.globalFilter)` and
   `.setRemoveGlobalFilter(settings.removeGlobalFilter)`.
5. `GlobalQuery.getInstance().set(settings.globalQuery)`.
6. `StatusSettings.applyToStatusRegistry(settings.statusSettings, StatusRegistry.getInstance())`.

**Why this matters:** without step 4 every checkbox is a task (instead of only
lines carrying the global filter, e.g. `#task`). Without step 6 custom status
symbols such as `[-]` (Cancelled) or `[/]` (In Progress) are unknown and count
as TODO — `not done` then returns too much. All singletons, so process-wide;
in the server they have to be set afresh on every vault change.

## From Markdown to Task: `Obsidian/FileParser.ts`

Do not call `Task.fromLine()` line by line — that knows neither line number
nor hierarchy. Use `FileParser` instead:

```ts
new FileParser(tasksFile, fileContent, listItems, logger, errorReporter).parseFileContent()
```

Obsidian's cache structures have to be supplied:

- `listItems: ListItemCache[]` — per list item
  `{ position: { start: { line, col, offset }, end: {...} }, parent: number, task?: string }`.
  `parent` is the **line number** of the parent item; for root items a
  **negative** value (FileParser then does not find it and sets `null`).
  `task` is the character inside the square brackets; **`undefined` means
  "plain list item, not a task"** — such lines are created as `ListItem`s and
  carry the tree structure without being matches themselves.
- `tasksFile.cachedMetadata.sections` — `FileParser` **skips every line
  without a section** (`Cache.getSection` returns `null` otherwise). A list
  block without a matching section therefore vanishes without a trace.
- `tasksFile.cachedMetadata.headings` — feeds `precedingHeader` and thereby
  the filter `heading includes …`.
- `tasksFile.cachedMetadata.frontmatter` / `.tags` / `.links` /
  `.frontmatterLinks` — feed `TasksFile.tags`, `.frontmatter` and `.outlinks`
  and thereby the frontmatter and link filters.

`Cache.getSection(line, sections)` and `Cache.getPrecedingHeader(line,
headings)` are static and directly usable. Importing them pulls
`Obsidian/Cache.ts` into the bundle — hence the dummies in the shim and the
dependency on `async-mutex`.

Lines that Obsidian does **not** count as list items must never end up in
`listItems` in the first place: YAML frontmatter, fenced code blocks (``` and
~~~), indented code blocks.

## Running and rendering a query

```ts
const query = new Query(source, tasksFile?);
query.error          // string | undefined — lines not understood. ALWAYS deliver this.
query.explainQuery() // plain text of what the query does. ALWAYS deliver this.
const result = query.applyQueryToTasks(tasks); // QueryResult
result.searchErrorMessage // errors only at run time, e.g. in 'filter by function'
result.totalTasksCount / result.totalTasksCountBeforeLimit / result.groups
```

`QueryResult.asMarkdown()` is deliberately plain and **cannot do trees** — for
`show tree` and nested list items use
`Renderer/MarkdownQueryResultsRenderer.ts` instead:

```ts
const renderer = new MarkdownQueryResultsRenderer(source, tasksFile, query);
await renderer.renderQuery(State.Warm, result);
renderer.markdown;
```

## JavaScript in queries

`filter by function`, `sort by function` and placeholders only run if
`EnableJsInTasksQueries` is initialised **and** switched on. Without
initialisation even parsing throws. The value lives in Obsidian's vault-local
app storage, **not** in data.json — so it cannot be read from outside. Hence a
switch of its own here (`--enable-js`), off by default as in the plugin. It is
initialised with `InMemoryLocalStorageProvider`.

## The treasure: real Obsidian data in the submodule

`vendor/obsidian-tasks/tests/Obsidian/__test_data__/` contains 89 JSON files,
each with the content of a note **and** the `CachedMetadata` Obsidian itself
produced, plus Obsidian's results for `getAllTags()` and
`parseFrontMatterTags()`. That is the basis for checking `src/metadata.ts` —
`npm run conformance` compares against it (status: 89/89).

**Before every change to `src/metadata.ts`, look there instead of guessing.**
Rules that came out of it and that nobody would invent:

- A list item is a child only once its indentation reaches the **content
  column** of the previous one (CommonMark) — measure both in the same unit,
  tab = 4 columns.
- `tags: one, two` in the frontmatter yields `[]`, not two tags: Obsidian does
  not split strings, and a tag containing a comma is invalid. Empty list `[]`,
  empty field `null`.
- List items in `%% … %%` and `<!-- … -->` do not count — tags in `%% … %%`
  do, those in `<!-- … -->` do not.
- `- [ ] 1. Text` creates a second, embedded list item on the same line
  (Obsidian issue 3481).

The comparison files contain **no tabs** and **no CRLF** — reading has already
failed on both (CRLF silently yielded zero tasks; `src/vault.ts` normalises
since). So always check against a real, large vault in addition:

```sh
npm run check -- /path/to/vault
```

`src/invariants.ts` checks properties that need no expected result and
therefore runs on any vault. Details: `docs/TESTS.md`.

## Tests in the submodule

`vendor/obsidian-tasks/tests/` contains a good 700 test files; those under
`Query/`, `Task/`, `Scripting/` and `DateTime/` run without an Obsidian
runtime. They check the engine, which we do not change — the benefit would be
small, the effort (`yarn install` in the submodule, a Jest configuration of
its own with the shim alias) high. What is valuable is their **data**, see
above. `jest.setup.ts` shows which globals a test expects (`window.moment`,
i18n).
