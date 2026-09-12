/**
 * Invariant checking: properties that must hold for **every** vault.
 *
 * The difference from `tests/selftest.ts`: an ordinary test needs an expected
 * result that somebody wrote down beforehand. For a vault with a few thousand
 * files nobody writes that down — which left nothing but eyeballing.
 *
 * An invariant needs no expected result. It is a statement that is true in
 * itself, whatever the files contain ("if a task says it is on line 42, its
 * checkbox has to be there"). The same check therefore runs over the fixtures
 * in `npm test` **and** over an arbitrarily large, unknown vault.
 *
 * What it cannot do: prove that the result is *right* — only that it is
 * self-consistent. An engine that swallows every task violates no invariant
 * at all. So it replaces neither the self-check (which checks concrete
 * results) nor the comparison with Obsidian (which checks against outside
 * truth); it comes on top as a third layer: the only one that can work on
 * input nobody has read in advance.
 */
import { bootstrap } from './bootstrap';

import type { ListItem } from '../vendor/obsidian-tasks/src/Task/ListItem';
import type { Task } from '../vendor/obsidian-tasks/src/Task/Task';

import { applyVaultSettings, type AppliedSettings, type EngineOptions } from './settings';
import { readVault } from './vault';

export interface Finding {
    /** Short name of the violated invariant, see `RULES`. */
    rule: string;
    path: string;
    /** Line number as counted in Obsidian: 1-based. */
    line: number;
    detail: string;
}

export interface CheckReport {
    findings: Finding[];
    /** Files that could not be read or parsed. */
    problems: string[];
    counts: {
        files: number;
        tasks: number;
        /** Tasks **and** plain list items, which carry the tree. */
        listItems: number;
    };
    settings: AppliedSettings;
    millis: number;
}

/** The invariants that are checked, in the order they are checked. */
export const RULES: Record<string, string> = {
    LineNumber: 'The line number of a list item points at the line it came from.',
    Indentation:
        'Two consecutive list items with character-identical indentation, with nothing ' +
        'less deeply indented between them, are siblings.',
    Tree: 'Parents come before their children, in the same file, without cycles and linked both ways.',
    Heading: 'The preceding heading is the nearest heading above the line.',
    Tags: 'Every tag of a task also appears in the Markdown of its line.',
    RoundTrip: 'A task written back to Markdown still contains everything from its original line.',
};

/** Checks a vault without knowing anything about its contents. */
export async function checkVault(rootDirs: string[], options: EngineOptions = {}): Promise<CheckReport> {
    await bootstrap();
    const started = Date.now();

    const settings = applyVaultSettings(rootDirs, options);
    const vault = readVault(rootDirs, options.scope, { keepSources: true });
    const sources = vault.sources!;

    const findings: Finding[] = [];
    const items = allListItems(vault.tasks);

    for (const [path, inFile] of groupByFile(items)) {
        const content = sources.get(path);
        if (content === undefined) continue; // cannot happen, but do not fail over it
        const lines = content.split('\n');
        const ordered = [...inFile].sort((a, b) => a.lineNumber - b.lineNumber);

        checkLineNumbers(ordered, lines, path, findings);
        checkSiblingIndentation(ordered, lines, path, findings);
        checkTree(ordered, path, findings);
        checkHeadings(ordered, lines, path, findings);
    }

    for (const task of vault.tasks) {
        checkTags(task, findings);
        checkRoundTrip(task, findings);
    }

    return {
        findings,
        problems: vault.problems,
        counts: { files: vault.fileCount, tasks: vault.tasks.length, listItems: items.length },
        settings,
        millis: Date.now() - started,
    };
}

/**
 * Every list item, not just the tasks.
 *
 * `readVault` returns `Task[]`, but plain list items carry the tree as well
 * (`ListItemCache.task === undefined`). They are reachable through `root` and
 * `children`. Lists without a single task therefore stay unchecked — they
 * never reach the engine anyway.
 */
function allListItems(tasks: Task[]): ListItem[] {
    const seen = new Set<ListItem>();
    const collect = (item: ListItem) => {
        if (seen.has(item)) return;
        seen.add(item);
        for (const child of item.children) collect(child);
    };
    for (const task of tasks) collect(task.root);
    return [...seen];
}

function groupByFile(items: ListItem[]): Map<string, ListItem[]> {
    const byFile = new Map<string, ListItem[]>();
    for (const item of items) {
        const list = byFile.get(item.path);
        if (list) list.push(item);
        else byFile.set(item.path, [item]);
    }
    return byFile;
}

/**
 * Invariant "LineNumber".
 *
 * `endsWith` rather than equality because of Obsidian issue 3481:
 * `- [ ] 1. Text` creates a second, embedded list item on the same line whose
 * `originalMarkdown` is only the trailing part of the line.
 */
function checkLineNumbers(items: ListItem[], lines: string[], path: string, findings: Finding[]) {
    for (const item of items) {
        const line = lines[item.lineNumber];
        if (line === undefined) {
            findings.push({
                rule: 'LineNumber',
                path,
                line: item.lineNumber + 1,
                detail: `line ${item.lineNumber + 1} does not exist; the file has ${lines.length} lines.`,
            });
        } else if (line !== item.originalMarkdown && !line.endsWith(item.originalMarkdown)) {
            findings.push({
                rule: 'LineNumber',
                path,
                line: item.lineNumber + 1,
                detail: `there stands ${JSON.stringify(line)}, the list item is ${JSON.stringify(item.originalMarkdown)}.`,
            });
        }
    }
}

/**
 * Invariant "Indentation" — the one that would have caught the tab bug.
 *
 * Two list items with **character-identical** indentation are siblings, as
 * long as nothing less deeply indented stands between them. That holds no
 * matter how wide a tab counts — and that is exactly what the bug hung on,
 * where tab-indented siblings turned into a staircase.
 *
 * The restriction is necessary, otherwise there would be false alarms. In
 *
 *     - a
 *       - b
 *         - c        ← "        " at level 2
 *     - d
 *         - e        ← "        " at level 1
 *
 * the same indentation is twice at a different depth — which is allowed,
 * because `- d` in between is shallower and thereby closes the inner list.
 * Hence everything deeper is forgotten as soon as a shallower item appears.
 *
 * Skipped is anything sharing a line with another list item: with Obsidian
 * issue 3481 (`- [ ] 1. Text`) a second, embedded item appears whose
 * indentation is not one at all. The rule speaks about items stacked above
 * each other.
 */
function checkSiblingIndentation(items: ListItem[], lines: string[], path: string, findings: Finding[]) {
    /** Last item seen per indentation, keyed by the string itself. */
    let lastByIndent = new Map<string, ListItem>();
    let previousLine = -1;

    for (const item of items) {
        if (item.lineNumber === previousLine) continue; // issue 3481, see above
        // A paragraph or heading at column 0 ends the list block.
        if (endsBlock(lines, previousLine, item.lineNumber)) lastByIndent = new Map();
        previousLine = item.lineNumber;

        const width = indentWidth(item.indentation);
        for (const [indent] of lastByIndent) {
            if (indentWidth(indent) > width) lastByIndent.delete(indent);
        }

        const previous = lastByIndent.get(item.indentation);
        if (previous && previous !== item && previous.parent !== item.parent) {
            findings.push({
                rule: 'Indentation',
                path,
                line: item.lineNumber + 1,
                detail:
                    `indented identically to line ${previous.lineNumber + 1} ` +
                    `(${JSON.stringify(item.indentation)}), but a different parent: ` +
                    `${describeParent(previous)} versus ${describeParent(item)}.`,
            });
        }
        lastByIndent.set(item.indentation, item);
    }
}

/** Is there anything between two list lines that ends the block? */
function endsBlock(lines: string[], from: number, to: number): boolean {
    for (let index = from + 1; index < to; index++) {
        const line = lines[index] ?? '';
        if (line.trim() === '') continue; // a blank line alone ends no list
        if (/^\s/.test(line)) continue; // indented: continuation of the list item
        if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) continue; // a list item itself
        return true;
    }
    return false;
}

/** Tab = 4 columns, as in Obsidian. Only for "shallower than", never for the verdict. */
function indentWidth(indentation: string): number {
    let width = 0;
    for (const character of indentation) width = character === '\t' ? width + 4 - (width % 4) : width + 1;
    return width;
}

function describeParent(item: ListItem): string {
    return item.parent ? `line ${item.parent.lineNumber + 1}` : 'no parent';
}

/** Invariant "Tree". */
function checkTree(items: ListItem[], path: string, findings: Finding[]) {
    for (const item of items) {
        const parent = item.parent;
        if (!parent) continue;
        const report = (detail: string) =>
            findings.push({ rule: 'Tree', path, line: item.lineNumber + 1, detail });

        if (parent.path !== item.path) {
            report(`the parent lies in another file (${parent.path}).`);
            continue;
        }
        // `<=`, not `<`: with Obsidian issue 3481 parent and child stand on
        // the same line.
        if (parent.lineNumber > item.lineNumber) {
            report(`the parent stands further down (line ${parent.lineNumber + 1}).`);
        }
        if (!parent.children.includes(item)) {
            report(`the parent on line ${parent.lineNumber + 1} does not know this child.`);
        }

        let hops = 0;
        for (let up: ListItem | null = parent; up; up = up.parent) {
            if (up === item) {
                report('cycle in the parent chain.');
                break;
            }
            if (++hops > 1000) {
                report('the parent chain never gets shorter — probably a cycle.');
                break;
            }
        }
    }
}

/**
 * Invariant "Heading".
 *
 * The headings are deliberately looked up **independently** of
 * `src/metadata.ts`: a check that uses the same code as the thing it checks
 * only confirms itself.
 */
function checkHeadings(items: ListItem[], lines: string[], path: string, findings: Finding[]) {
    const headings = findHeadings(lines);

    for (const item of items) {
        let expected: string | null = null;
        for (const heading of headings) {
            if (heading.line < item.lineNumber) expected = heading.text;
            else break;
        }
        if ((item.precedingHeader ?? null) !== expected) {
            findings.push({
                rule: 'Heading',
                path,
                line: item.lineNumber + 1,
                detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(item.precedingHeader ?? null)}.`,
            });
        }
    }
}

function findHeadings(lines: string[]): { line: number; text: string }[] {
    const headings: { line: number; text: string }[] = [];
    let fence: string | null = null;
    let inFrontmatter = lines[0]?.trim() === '---';

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (inFrontmatter) {
            if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) inFrontmatter = false;
            continue;
        }
        const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fenceMatch) {
            if (fence === null) fence = fenceMatch[1][0];
            else if (fenceMatch[1][0] === fence) fence = null;
            continue;
        }
        if (fence !== null) continue;
        const headingMatch = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
        if (headingMatch) headings.push({ line: index, text: headingMatch[1] });
    }
    return headings;
}

/** Invariant "Tags". */
function checkTags(task: Task, findings: Finding[]) {
    for (const tag of task.tags) {
        if (!task.originalMarkdown.includes(tag)) {
            findings.push({
                rule: 'Tags',
                path: task.path,
                line: task.lineNumber + 1,
                detail: `tag ${tag} does not appear in the line ${JSON.stringify(task.originalMarkdown)}.`,
            });
        }
    }
}

/**
 * Invariant "RoundTrip": nothing may be lost while parsing.
 *
 * Character-for-character equality would be **wrong** here — against a real
 * vault it produced nine false alarms, all harmless: `toFileLineString()`
 * rewrites the line from the parsed fields and deliberately normalises while
 * doing so. Double spaces disappear, a missing one before `⏳` is added, and
 * the emoji fields end up in the plugin's order rather than the user's. That
 * is intended and none of our business.
 *
 * What remains is the core that really must always hold: **the same
 * characters**. A swallowed date, a lost tag, an eaten priority change the
 * multiset of characters; reordering and whitespace do not.
 */
function checkRoundTrip(task: Task, findings: Finding[]) {
    const rebuilt = characters(task.toFileLineString());
    const original = characters(task.originalMarkdown);
    const lost = difference(original, rebuilt);
    const gained = difference(rebuilt, original);
    if (lost.length > 0 || gained.length > 0) {
        findings.push({
            rule: 'RoundTrip',
            path: task.path,
            line: task.lineNumber + 1,
            detail:
                (lost.length > 0 ? `lost: ${JSON.stringify(lost.join(''))} ` : '') +
                (gained.length > 0 ? `gained: ${JSON.stringify(gained.join(''))} ` : '') +
                `— ${JSON.stringify(task.originalMarkdown)} became ${JSON.stringify(task.toFileLineString())}.`,
        });
    }
}

/** Characters without whitespace, as a frequency table. */
function characters(line: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const character of line) {
        if (/\s/.test(character)) continue;
        counts.set(character, (counts.get(character) ?? 0) + 1);
    }
    return counts;
}

function difference(from: Map<string, number>, minus: Map<string, number>): string[] {
    const missing: string[] = [];
    for (const [character, count] of from) {
        const left = count - (minus.get(character) ?? 0);
        for (let index = 0; index < left; index++) missing.push(character);
    }
    return missing;
}
