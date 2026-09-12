/**
 * Read a vault -> Task[].
 *
 * This file no longer parses anything itself. It builds, for every file, the
 * cache Obsidian would hand the plugin (see `src/metadata.ts`) and then passes
 * it to the plugin's **unmodified** `FileParser`.
 *
 * That way the tasks carry line number, section, preceding heading and their
 * place in the list tree — the prerequisite for `show tree`, `is not blocked`,
 * `id`/`dependsOn` and `heading includes`.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import { FileParser } from '../vendor/obsidian-tasks/src/Obsidian/FileParser';
import type { Task } from '../vendor/obsidian-tasks/src/Task/Task';
import { TasksFile } from '../vendor/obsidian-tasks/src/Scripting/TasksFile';

import { parseFileMetadata } from './metadata';
import { describeProblem, isInside, vaultRelative } from './paths';

export interface ReadVaultResult {
    tasks: Task[];
    fileCount: number;
    millis: number;
    /** Files that could not be read or parsed. */
    problems: string[];
    /**
     * Vault-relative path -> file contents, only with `keepSources`.
     *
     * Besides the tasks, the invariant check needs the lines they came from.
     * For ordinary queries this stays off, otherwise the whole vault would sit
     * in memory only to be discarded right away.
     */
    sources?: Map<string, string>;
}

export interface ReadVaultOptions {
    /** Keep file contents (for the invariant check). */
    keepSources?: boolean;
}

export interface WalkResult {
    /** The Markdown files found, as paths below the walk's root. */
    files: string[];
    /** Directories and links that had to be skipped, and why. */
    problems: string[];
}

/**
 * All Markdown files below `root` — without leaving it, and without giving up.
 *
 * Two properties the naive walk did not have:
 *
 * **It stays inside.** A symbolic link is followed only if its target still
 * lies below `root`; one pointing out of the vault is skipped and reported.
 * Otherwise the configured roots would not be the boundary the HTTP transport
 * and `-scope` claim they are: a link inside an allowed vault would be enough
 * to read any Markdown on the machine. Links that loop back into a directory
 * already visited are skipped as well — following them does not end.
 *
 * **It does not abort.** A directory that cannot be scanned — protected,
 * a stale mount, a permission that drifted — becomes an entry in `problems`.
 * A single unreadable folder must not take the whole query with it, and it
 * must not disappear either: silence is exactly what this project is against.
 *
 * `vaultRoot` is what the problems are *named* against, and it is not always
 * the same directory as `root`: with `-scope` the walk starts below the vault,
 * while a path in the answer is spelled from the vault root either way. It
 * never widens the walk — only `root` decides what is read.
 */
export function findMarkdownFiles(root: string, vaultRoot: string = root): WalkResult {
    const files: string[] = [];
    const problems: string[] = [];
    let boundary: string;
    try {
        boundary = realpathSync(root);
    } catch (error) {
        const where = vaultRelative(root, vaultRoot);
        return { files, problems: [`${where}: ${describeProblem(error)} — this directory was skipped.`] };
    }
    walk(root, { boundary, vaultRoot, visited: new Set([boundary]), files, problems });
    return { files, problems };
}

/** Everything the walk carries down with it, so the recursion stays readable. */
interface Walk {
    /** Resolved real path of the walk's root. Nothing above it is read. */
    boundary: string;
    /** Vault root the problems are named against. Reporting only. */
    vaultRoot: string;
    /** Real paths already read, against links that loop. */
    visited: Set<string>;
    files: string[];
    problems: string[];
}

function walk(dir: string, state: Walk): void {
    const { boundary, vaultRoot, visited, files, problems } = state;
    const report = (path: string, what: string) => problems.push(`${vaultRelative(path, vaultRoot)}: ${what}`);

    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        report(dir, `${describeProblem(error)} — this directory was skipped.`);
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // .obsidian, .trash, .git
        const path = join(dir, entry.name);
        const isLink = entry.isSymbolicLink();
        let target = path;
        if (isLink) {
            try {
                target = realpathSync(path);
            } catch (error) {
                // A broken link, or one whose target cannot be looked at.
                report(path, `${describeProblem(error)} — this link was skipped.`);
                continue;
            }
            if (!isInside(target, boundary)) {
                // Deliberately without the target: where the link pointed is
                // the one thing here that is not this vault's to report.
                report(path, 'symbolic link leads out of what this server may read — skipped.');
                continue;
            }
        }
        let isDirectory: boolean;
        try {
            isDirectory = isLink ? statSync(path).isDirectory() : entry.isDirectory();
        } catch (error) {
            report(path, `${describeProblem(error)} — this entry was skipped.`);
            continue;
        }
        if (isDirectory) {
            let real: string;
            try {
                real = isLink ? target : realpathSync(path);
            } catch (error) {
                report(path, `${describeProblem(error)} — this directory was skipped.`);
                continue;
            }
            if (visited.has(real)) {
                // Two links to the same directory would read every task in it
                // twice; a link to an ancestor would never end at all.
                report(path, `leads to ${vaultRelative(real, vaultRoot)}, which was read already — skipped.`);
                continue;
            }
            visited.add(real);
            walk(path, state);
        } else if (entry.name.endsWith('.md')) {
            files.push(path);
        }
    }
}

/**
 * Read a vault, optionally restricted to a subpath.
 *
 * `scope` restricts the **directory walk**, not the query: whatever lies
 * outside is never read in the first place. A filter applied afterwards would
 * not do that — it would pull the whole vault into the process and only sift
 * it out when producing output.
 *
 * The task paths nevertheless stay **relative to the vault root**, so they
 * read exactly as they do in Obsidian. That is precisely the difference from
 * simply pointing `rootDir` one level deeper.
 */
export function readVault(
    rootDirs: string[],
    scope?: string,
    options: ReadVaultOptions = {},
): ReadVaultResult {
    const started = Date.now();
    const tasks: Task[] = [];
    const problems: string[] = [];
    const sources = options.keepSources ? new Map<string, string>() : undefined;
    let fileCount = 0;
    const parseError = reportParseError(problems);

    for (const vaultRoot of rootDirs) {
        const start = scope ? join(vaultRoot, scope) : vaultRoot;
        if (scope && !isInside(start, vaultRoot)) {
            problems.push(`scope '${scope}' leads outside the vault — skipped.`);
            continue;
        }
        if (!isDirectory(start)) {
            // Do not silently return nothing: a misspelled scope would
            // otherwise look like a vault without tasks.
            problems.push(`${vaultRelative(start, vaultRoot)}: not a directory — this scope was skipped.`);
            continue;
        }
        const walked = findMarkdownFiles(start, vaultRoot);
        problems.push(...walked.problems);
        for (const file of walked.files) {
            fileCount++;
            // Obsidian paths are relative to the vault root and use '/'. The
            // reports below are named with the same path, not with `file`.
            const path = vaultRelative(file, vaultRoot);
            try {
                const content = normalizeLineEndings(readFileSync(file, 'utf8'));
                const cachedMetadata = parseFileMetadata(content);
                const tasksFile = new TasksFile(path, cachedMetadata as any);
                sources?.set(path, content);

                const parser = new FileParser(
                    tasksFile,
                    content,
                    cachedMetadata.listItems ?? [],
                    loggerFor(path, problems),
                    parseError,
                );
                tasks.push(...parser.parseFileContent());
            } catch (error) {
                problems.push(`${path}: ${describeProblem(error)}`);
            }
        }
    }

    return { tasks, fileCount, millis: Date.now() - started, problems, sources };
}

/**
 * CRLF -> LF, once while reading.
 *
 * Obsidian vaults from Windows have carriage-return line endings. Without this
 * step the line analysis in `src/metadata.ts` recognises neither headings nor
 * list items — such a file yields **zero** tasks without anything being
 * reported. Exactly the kind of silent loss this project was built against.
 *
 * The conversion has to happen here and not in `parseFileMetadata`: the same
 * text also goes to the `FileParser` and becomes `originalMarkdown`. Two
 * different versions of the same content would produce task descriptions with
 * a trailing carriage return — and thus filters that fail for no visible
 * reason.
 *
 * Nothing is ever written, so this has no consequences: the files on disk keep
 * their line endings.
 */
function normalizeLineEndings(content: string): string {
    return content.includes('\r') ? content.replace(/\r\n?/g, '\n') : content;
}

/**
 * The parser's two report channels, and why neither passes its text through.
 *
 * `FileParser` hands both of them the **line it failed on, verbatim** — and
 * that line is precisely one the engine did *not* accept as a task, so it has
 * passed neither the global filter nor the query. It is the single category of
 * vault content the result is otherwise built never to contain, arriving
 * through the one channel nobody reviews. The fact is reported; the text is
 * not, and the line number says where to look.
 *
 * `logger.warn` is the vendor's own wording (`'… from line: ' + line + ' in
 * file: ' + this.filePath`), so it cannot be forwarded at all — there is no
 * part of it to keep. Its one call site calls itself unreachable.
 */
function reportParseError(problems: string[]) {
    return (error: unknown, filePath: string, item: unknown, _line: string) => {
        // `filePath` is `TasksFile.path` — vault-relative already.
        problems.push(`${filePath}:${lineOf(item)} — this line could not be parsed ` +
            `(${describeProblem(error)}); its text is not quoted here.`);
    };
}

function loggerFor(path: string, problems: string[]) {
    return {
        debug: () => {},
        warn: () =>
            problems.push(
                `${path}: the parser reported a problem in this file; ` +
                    'its message is not quoted here, because it carries the line itself.',
            ),
    } as any;
}

/** 1-based, as an editor counts — or `?` if the cache had no position. */
function lineOf(item: unknown): string {
    const line = (item as { position?: { start?: { line?: number } } } | null)?.position?.start?.line;
    return typeof line === 'number' ? String(line + 1) : '?';
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}
