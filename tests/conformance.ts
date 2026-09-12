/**
 * Comparison of `src/metadata.ts` with real Obsidian data.
 *
 *   npm run conformance
 *
 * Under `tests/Obsidian/__test_data__/` the submodule carries some 90 JSON
 * files, each holding the content of a note **and** the `CachedMetadata` that
 * Obsidian itself produced for it. That makes it possible to check exactly
 * what this project reimplements — against the truth, not against an opinion.
 *
 * Compared is what `FileParser` actually uses:
 *   - which lines are list items,
 *   - which character sits in the checkbox (or that there is none),
 *   - which list item is the parent of which other,
 *   - headings (for `heading includes`),
 * plus the two shim functions `getAllTags` and `parseFrontMatterTags`, for
 * which the files ship Obsidian's result.
 *
 * Not compared are columns and byte offsets: FileParser does not evaluate
 * them.
 */
import '../src/bootstrap';

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFileMetadata, type CachedMetadata, type ListItemCache } from '../src/metadata';
import { getAllTags, parseFrontMatterTags } from '../src/obsidian-shim';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '..', 'vendor', 'obsidian-tasks', 'tests', 'Obsidian', '__test_data__');

interface SimulatedFile {
    cachedMetadata: CachedMetadata;
    filePath: string;
    fileContents: string;
    getAllTags: string[];
    parseFrontMatterTags: string[] | null;
}

/**
 * For root items Obsidian records a negative number whose exact value is
 * never evaluated anywhere. What is compared is therefore the *resolved*
 * relationship: line number of the parent, or `null` for a root.
 */
function resolveParents(listItems: ListItemCache[]): (number | null)[] {
    const lines = new Set(listItems.map((item) => item.position.start.line));
    return listItems.map((item) => (item.parent >= 0 && lines.has(item.parent) ? item.parent : null));
}

const summary = (items: ListItemCache[]) =>
    items.map((item, index) => ({
        line: item.position.start.line,
        task: item.task,
        parent: resolveParents(items)[index],
    }));

const files = readdirSync(dataDir).filter((name) => name.endsWith('.json')).sort();

let checked = 0;
const failures: string[] = [];

for (const name of files) {
    const data = JSON.parse(readFileSync(join(dataDir, name), 'utf8')) as SimulatedFile;
    const expected = data.cachedMetadata;
    const actual = parseFileMetadata(data.fileContents);
    const problems: string[] = [];

    const wantItems = summary(expected.listItems ?? []);
    const gotItems = summary(actual.listItems ?? []);
    if (JSON.stringify(wantItems) !== JSON.stringify(gotItems)) {
        problems.push(`list items\n    Obsidian: ${JSON.stringify(wantItems)}\n    ours:     ${JSON.stringify(gotItems)}`);
    }

    const heads = (cache: CachedMetadata) =>
        (cache.headings ?? []).map((h) => `${h.position.start.line}:${h.level}:${h.heading}`);
    if (JSON.stringify(heads(expected)) !== JSON.stringify(heads(actual))) {
        problems.push(`headings\n    Obsidian: ${JSON.stringify(heads(expected))}\n    ours:     ${JSON.stringify(heads(actual))}`);
    }

    // Every list item has to lie within a section — otherwise FileParser
    // skips it silently.
    const uncovered = (actual.listItems ?? [])
        .map((item) => item.position.start.line)
        .filter((line) => !(actual.sections ?? []).some((s) => s.position.start.line <= line && s.position.end.line >= line));
    if (uncovered.length > 0) {
        problems.push(`lines without a section: ${uncovered.join(', ')} — FileParser would discard them`);
    }

    const wantTags = [...(data.getAllTags ?? [])].sort();
    const gotTags = [...(getAllTags(actual) ?? [])].sort();
    if (JSON.stringify(wantTags) !== JSON.stringify(gotTags)) {
        problems.push(`getAllTags\n    Obsidian: ${JSON.stringify(wantTags)}\n    ours:     ${JSON.stringify(gotTags)}`);
    }

    const wantFm = data.parseFrontMatterTags;
    const gotFm = parseFrontMatterTags(actual.frontmatter);
    if (JSON.stringify(wantFm) !== JSON.stringify(gotFm)) {
        problems.push(`parseFrontMatterTags\n    Obsidian: ${JSON.stringify(wantFm)}\n    ours:     ${JSON.stringify(gotFm)}`);
    }

    checked++;
    if (problems.length > 0) {
        failures.push(`\n${name}\n  ${problems.join('\n  ')}`);
    }
}

for (const failure of failures) console.log(failure);
console.log(`\n${checked - failures.length} of ${checked} Obsidian comparison files match.\n`);
process.exit(failures.length === 0 ? 0 : 1);
