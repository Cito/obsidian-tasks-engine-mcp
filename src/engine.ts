/**
 * The shared middle: load settings, read the vault, run the query, shape the
 * result. CLI and MCP server use nothing but this file, so that both are
 * guaranteed to compute the same thing.
 *
 * The project's guiding idea: `error` and `explanation` are **not** an extra,
 * they are part of every result. A server that drops a filter it does not
 * understand and answers anyway returns a result that looks ordinary and is
 * wrong; that failure is what this file exists to make impossible.
 *
 * The query is built via `getQueryForQueryRenderer()` and explained via
 * `explainResults()` — that is, along exactly the path the plugin itself takes
 * when rendering a tasks code block, global query included.
 */
import { bootstrap } from './bootstrap';

import { Mutex } from 'async-mutex';

import { GlobalFilter } from '../vendor/obsidian-tasks/src/Config/GlobalFilter';
import { GlobalQuery } from '../vendor/obsidian-tasks/src/Config/GlobalQuery';
import { explainResults, getQueryForQueryRenderer } from '../vendor/obsidian-tasks/src/Query/QueryRendererHelper';
import type { Query } from '../vendor/obsidian-tasks/src/Query/Query';
import type { QueryResult } from '../vendor/obsidian-tasks/src/Query/QueryResult';
import { TasksFile } from '../vendor/obsidian-tasks/src/Scripting/TasksFile';
import { MarkdownQueryResultsRenderer } from '../vendor/obsidian-tasks/src/Renderer/MarkdownQueryResultsRenderer';
import { State } from '../vendor/obsidian-tasks/src/Obsidian/Cache';
import type { Task } from '../vendor/obsidian-tasks/src/Task/Task';

import { applyVaultSettings, type AppliedSettings, type EngineOptions } from './settings';
import { readVault } from './vault';

export interface QueryReport {
    /** The lines the engine did not understand — `null` if it understood all. */
    error: string | null;
    /** Plain text of what the query actually does. */
    explanation: string;
    /** Which vault settings were in force. */
    settings: AppliedSettings;
}

export interface TaskDetails {
    description: string;
    status: { symbol: string; name: string; type: string };
    priority: string;
    urgency: number;
    due: string | null;
    scheduled: string | null;
    start: string | null;
    created: string | null;
    done: string | null;
    cancelled: string | null;
    recurrence: string | null;
    onCompletion: string;
    id: string;
    dependsOn: string[];
    tags: string[];
    path: string;
    lineNumber: number;
    heading: string | null;
    markdown: string;
}

export interface QueryOutcome extends QueryReport {
    /** Matches after `limit`. */
    matched: number;
    /** Matches before `limit` — shows how much `limit` cut off. */
    matchedBeforeLimit: number;
    /** Total number of tasks in the vault. */
    total: number;
    /** Files that could not be read or parsed. Never conceal these. */
    problems: string[];
    /** Errors that only surface at run time (e.g. `filter by function`). */
    searchError: string | null;
    /** The result as Markdown, with tree and group headings. */
    markdown: string;
    tasks: TaskDetails[];
    stats: {
        rootDirs: string[];
        /** Subpath the scan was restricted to — `null` if there was none. */
        scope: string | null;
        fileCount: number;
        parseMillis: number;
        queryMillis: number;
    };
}

/** The file the query would live in. We have none — Obsidian does. */
const noQueryFile = new TasksFile('');

/**
 * One run at a time, for the whole process.
 *
 * `applyVaultSettings()` rewrites process-wide singletons (`GlobalFilter`,
 * `GlobalQuery`, `StatusRegistry`, `Settings`), and both functions below yield
 * after that — `runQuery` at `renderMarkdown()`, with `stripGlobalFilter()`
 * still to read `GlobalFilter` afterwards. Two overlapping calls against
 * vaults with different settings would therefore mix them and return a
 * plausible, wrong answer.
 *
 * Under stdio that never happened in practice; over HTTP the SDK builds a
 * server per request and concurrent calls are the normal case. One mutex for
 * both functions, not one each: they contend for the same singletons.
 *
 * This costs concurrency. The engine was never parallel — the alternative
 * would be a process per request, which is worse.
 */
const engineLock = new Mutex();

/**
 * Checks a query without reading the vault.
 *
 * The vault settings are still loaded: they are a small JSON file, but they
 * help determine what the explanation says (global filter, global query).
 */
export async function explainOnly(
    rootDirs: string[],
    source: string,
    options: EngineOptions = {},
): Promise<QueryReport> {
    return engineLock.runExclusive(() => explainOnlyExclusive(rootDirs, source, options));
}

async function explainOnlyExclusive(
    rootDirs: string[],
    source: string,
    options: EngineOptions,
): Promise<QueryReport> {
    await bootstrap();
    const settings = applyVaultSettings(rootDirs, options);
    const query = buildQuery(source);
    return { error: query.error ?? null, explanation: explain(source), settings };
}

export async function runQuery(
    rootDirs: string[],
    source: string,
    options: EngineOptions = {},
): Promise<QueryOutcome> {
    return engineLock.runExclusive(() => runQueryExclusive(rootDirs, source, options));
}

async function runQueryExclusive(
    rootDirs: string[],
    source: string,
    options: EngineOptions,
): Promise<QueryOutcome> {
    await bootstrap();

    const settings = applyVaultSettings(rootDirs, options);
    const vault = readVault(rootDirs, options.scope);

    const queryStarted = Date.now();
    const query = buildQuery(source);
    const explanation = explain(source);

    const base = {
        explanation,
        settings,
        total: vault.tasks.length,
        problems: vault.problems,
        stats: {
            rootDirs,
            scope: options.scope ?? null,
            fileCount: vault.fileCount,
            parseMillis: vault.millis,
            queryMillis: 0,
        },
    };

    if (query.error !== undefined) {
        return {
            ...base,
            error: query.error,
            matched: 0,
            matchedBeforeLimit: 0,
            searchError: null,
            markdown: '',
            tasks: [],
            stats: { ...base.stats, queryMillis: Date.now() - queryStarted },
        };
    }

    const result = query.applyQueryToTasks(vault.tasks);
    const markdown = stripGlobalFilter(await renderMarkdown(source, query, result));

    return {
        ...base,
        error: null,
        matched: result.totalTasksCount,
        matchedBeforeLimit: result.totalTasksCountBeforeLimit,
        searchError: result.searchErrorMessage ?? null,
        markdown: markdown.trim(),
        tasks: result.groups.flatMap((group) => group.tasks).map(describeTask),
        stats: { ...base.stats, queryMillis: Date.now() - queryStarted },
    };
}

/** Exactly the path QueryRenderer takes — global query included. */
function buildQuery(source: string): Query {
    return getQueryForQueryRenderer(source, GlobalQuery.getInstance(), noQueryFile);
}

/** Also explains the global filter and the global query. */
function explain(source: string): string {
    return explainResults(source, GlobalFilter.getInstance(), GlobalQuery.getInstance(), noQueryFile);
}

/**
 * By its own comment, `QueryResult.asMarkdown()` cannot do nested results —
 * `show tree` would have no effect with it. The plugin's renderer can, and it
 * is free of Obsidian dependencies.
 */
async function renderMarkdown(source: string, query: Query, result: QueryResult): Promise<string> {
    const renderer = new MarkdownQueryResultsRenderer(source, noQueryFile, query);
    await renderer.renderQuery(State.Warm, result);
    return renderer.markdown;
}

/**
 * Removes the global filter from the task lines if the vault is configured
 * that way (`removeGlobalFilter`) — just as Obsidian displays it. That these
 * are tasks is already clear from the answer; a `#task` on every line is only
 * noise.
 *
 * Removal goes through the plugin's `removeAsWordFromDependingOnSettings()`,
 * so that nested tags such as `#task/subitem` stay untouched. It is applied
 * only to the part after the list marker: the method trims, and the leading
 * spaces are what carry the nesting in the tree.
 */
function stripGlobalFilter(markdown: string): string {
    const filter = GlobalFilter.getInstance();
    if (filter.isEmpty() || !filter.getRemoveGlobalFilter()) return markdown;

    return markdown
        .split('\n')
        .map((line) => {
            const parts = /^(\s*- (?:\[.\] )?)(.*)$/.exec(line);
            return parts ? parts[1] + filter.removeAsWordFromDependingOnSettings(parts[2]) : line;
        })
        .join('\n');
}

function describeTask(task: Task): TaskDetails {
    const date = (value: { format(pattern: string): string } | null) =>
        value ? value.format('YYYY-MM-DD') : null;

    return {
        description: task.descriptionWithoutTags,
        status: { symbol: task.status.symbol, name: task.status.name, type: task.status.type },
        priority: task.priorityName,
        urgency: Math.round(task.urgency * 100) / 100,
        due: date(task.dueDate),
        scheduled: date(task.scheduledDate),
        start: date(task.startDate),
        created: date(task.createdDate),
        done: date(task.doneDate),
        cancelled: date(task.cancelledDate),
        recurrence: task.recurrence ? task.recurrenceRule : null,
        onCompletion: task.onCompletion,
        id: task.id,
        dependsOn: task.dependsOn,
        tags: task.tags,
        path: task.path,
        lineNumber: task.lineNumber,
        heading: task.heading,
        markdown: task.originalMarkdown,
    };
}
