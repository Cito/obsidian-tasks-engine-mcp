/**
 * Markdown -> Obsidian's `CachedMetadata`.
 *
 * ==========================================================================
 *  The heart of the project
 * ==========================================================================
 *
 * The plugin does not build tasks line by line but out of the cache
 * structures Obsidian hands it, via `src/Obsidian/FileParser.ts`. Those hold
 * line numbers, parent/child relationships of list items, sections and
 * headings. Without them `show tree`, `is not blocked`, `id`/`dependsOn` and
 * `heading includes` do not work.
 *
 * Outside Obsidian that cache does not exist — so we build it here.
 * Afterwards the plugin's unmodified FileParser takes over again.
 *
 * This is also the place where lines are filtered out that Obsidian does
 * **not** count as list items: YAML frontmatter and code blocks. A
 * `- [ ] example` inside a code block is not a task.
 */
import { parse as parseYaml } from 'yaml';

/* Obsidian's cache types, as far as they are needed here. Deliberately
 * defined locally: at build time 'obsidian' is our shim and provides no
 * types. */

export interface Pos {
    line: number;
    col: number;
    offset: number;
}
export interface Loc {
    start: Pos;
    end: Pos;
}
export interface ListItemCache {
    position: Loc;
    /** Line number of the parent item; negative = root item (as Obsidian does it). */
    parent: number;
    /** The character between the square brackets. `undefined` = plain list item. */
    task?: string;
}
export interface SectionCache {
    position: Loc;
    type: string;
}
export interface HeadingCache {
    position: Loc;
    heading: string;
    level: number;
}
export interface TagCache {
    position: Loc;
    tag: string;
}
export interface LinkCache {
    position: Loc;
    link: string;
    original: string;
    displayText: string;
}
export interface CachedMetadata {
    listItems?: ListItemCache[];
    sections?: SectionCache[];
    headings?: HeadingCache[];
    tags?: TagCache[];
    links?: LinkCache[];
    frontmatter?: Record<string, unknown>;
    frontmatterPosition?: Loc;
    frontmatterLinks?: LinkCache[];
}

/** As in the plugin: indentation, list marker, then the checkbox. */
const LIST_ITEM = /^([\s\t>]*)([-*+]|[0-9]+[.)])(?:[ \t]+(.*))?$/u;
const CHECKBOX = /^\[(.)\]([ \t]|$)/u;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const FRONTMATTER_DELIMITER = /^---[ \t]*$/;
/** Obsidian comment `%%` and HTML comment, each as a block of its own. */
const COMMENT_OPEN = /^[ \t]*(%%|<!--)/;

/**
 * Hashtags. A `#` only counts at the start of a line or after a non-word
 * character, and the tag needs at least one non-numeric character —
 * otherwise `#1` and `https://x/#anchor` would be tags.
 */
const TAG = /(?<![\w#/])#([\p{L}\p{Emoji_Presentation}\d_/-]*[\p{L}_/-][\p{L}\p{Emoji_Presentation}\d_/-]*)/gu;
// Inside a character class `[` needs no backslash, and ESLint says so. It is
// kept anyway: these patterns are mostly brackets, and writing one of the pair
// escaped and the other not makes them harder to read, not easier.
/* eslint-disable no-useless-escape */
const WIKILINK = /\[\[([^\[\]|]*)(?:\|([^\[\]]*))?\]\]/g;
const MARKDOWN_LINK = /\[([^\[\]]*)\]\(([^()\s]+)\)/g;
/* eslint-enable no-useless-escape */

export function parseFileMetadata(content: string): CachedMetadata {
    const lines = content.split('\n');
    const offsets = lineOffsets(lines);

    const listItems: ListItemCache[] = [];
    const sections: SectionCache[] = [];
    const headings: HeadingCache[] = [];
    const tags: TagCache[] = [];
    const links: LinkCache[] = [];
    const frontmatterLinks: LinkCache[] = [];

    const at = (line: number, col: number): Pos => ({ line, col, offset: offsets[line] + col });
    const span = (startLine: number, endLine: number): Loc => ({
        start: at(startLine, 0),
        end: at(endLine, lines[endLine]?.length ?? 0),
    });

    let index = 0;
    let frontmatter: Record<string, unknown> | undefined;
    let frontmatterPosition: Loc | undefined;

    // --- Frontmatter: only valid if the file starts with it. ---
    if (lines.length > 1 && FRONTMATTER_DELIMITER.test(lines[0])) {
        const close = lines.findIndex((line, i) => i > 0 && FRONTMATTER_DELIMITER.test(line));
        if (close > 0) {
            frontmatter = readFrontmatter(lines.slice(1, close).join('\n'));
            frontmatterPosition = span(0, close);
            sections.push({ position: frontmatterPosition, type: 'yaml' });
            collectLinks(lines.slice(1, close).join('\n'), 1, at, frontmatterLinks);
            index = close + 1;
        }
    }

    // --- Body ---
    while (index < lines.length) {
        const line = lines[index];

        if (line.trim() === '') {
            index++;
            continue;
        }

        const fence = FENCE.exec(line);
        if (fence) {
            const marker = fence[1][0];
            const length = fence[1].length;
            let end = index + 1;
            while (end < lines.length) {
                const closing = FENCE.exec(lines[end]);
                if (closing && closing[1][0] === marker && closing[1].length >= length && closing[2].trim() === '') {
                    break;
                }
                end++;
            }
            end = Math.min(end, lines.length - 1);
            sections.push({ position: span(index, end), type: 'code' });
            index = end + 1;
            continue;
        }

        const comment = COMMENT_OPEN.exec(line);
        if (comment && !closesOnSameLine(line, comment[1])) {
            // A list item inside a comment block is no list item to Obsidian —
            // neither in %% … %% nor in <!-- … -->.
            //
            // For tags Obsidian differs, and demonstrably so (see the
            // comparison files comments_markdown_style and
            // comments_html_style): tags in `%% … %%` still end up in the
            // cache, tags in `<!-- … -->` do not. That inconsistency is
            // reproduced here, because the goal is "the way Obsidian does it",
            // not "the way it ought to be".
            const isObsidianComment = comment[1] === '%%';
            const closer = isObsidianComment ? '%%' : '-->';
            let end = index + 1;
            while (end < lines.length && !lines[end].includes(closer)) end++;
            end = Math.min(end, lines.length - 1);
            if (isObsidianComment) {
                for (let i = index; i <= end; i++) {
                    collectTags(lines[i], i, at, tags);
                    collectLinks(lines[i], i, at, links);
                }
            }
            sections.push({ position: span(index, end), type: 'comment' });
            index = end + 1;
            continue;
        }

        const heading = HEADING.exec(line);
        if (heading) {
            const position = span(index, index);
            headings.push({ position, heading: heading[2], level: heading[1].length });
            sections.push({ position, type: 'heading' });
            collectTags(line, index, at, tags);
            collectLinks(line, index, at, links);
            index++;
            continue;
        }

        if (LIST_ITEM.test(line)) {
            index = readListBlock(lines, index, at, span, sections, listItems, tags, links);
            continue;
        }

        // Everything else: a paragraph up to the next blank line or block
        // boundary.
        let end = index;
        while (
            end + 1 < lines.length &&
            lines[end + 1].trim() !== '' &&
            !HEADING.test(lines[end + 1]) &&
            !FENCE.test(lines[end + 1]) &&
            !LIST_ITEM.test(lines[end + 1]) &&
            !COMMENT_OPEN.test(lines[end + 1])
        ) {
            end++;
        }
        for (let i = index; i <= end; i++) {
            collectTags(lines[i], i, at, tags);
            collectLinks(lines[i], i, at, links);
        }
        sections.push({ position: span(index, end), type: 'paragraph' });
        index = end + 1;
    }

    return {
        listItems,
        sections,
        headings,
        tags,
        links,
        ...(frontmatter !== undefined ? { frontmatter, frontmatterPosition, frontmatterLinks } : {}),
    };
}

/**
 * Reads one contiguous list block and works out the parent/child
 * relationships along the way.
 *
 * The parent is the nearest preceding list item with **strictly smaller**
 * indentation. If there is none, the item is a root; Obsidian then records a
 * negative number, and `FileParser` does not find it in its line table —
 * which is exactly what is meant.
 *
 * Returns the first line **after** the block.
 */
function readListBlock(
    lines: string[],
    start: number,
    at: (line: number, col: number) => Pos,
    span: (startLine: number, endLine: number) => Loc,
    sections: SectionCache[],
    listItems: ListItemCache[],
    tags: TagCache[],
    links: LinkCache[],
): number {
    // Per CommonMark an item is a child of the previous one if its indentation
    // reaches at least that item's **content column** — not already when it is
    // merely larger. `- [ ] a` has content column 2; an item indented by one
    // space is therefore a sibling, not a child.
    const stack: { contentCol: number; quote: number; line: number }[] = [];
    let index = start;
    let lastItemLine = start;

    while (index < lines.length) {
        const line = lines[index];

        if (line.trim() === '') {
            // A blank line only ends the block if nothing list-like follows.
            let next = index;
            while (next < lines.length && lines[next].trim() === '') next++;
            if (next >= lines.length) break;
            if (!LIST_ITEM.test(lines[next]) && !/^[ \t]/.test(lines[next])) break;
            index = next;
            continue;
        }

        const match = LIST_ITEM.exec(line);
        if (!match) {
            // An indented continuation line still belongs to the list item.
            if (/^[ \t]/.test(line)) {
                collectTags(line, index, at, tags);
                collectLinks(line, index, at, links);
                index++;
                continue;
            }
            break;
        }

        const prefix = match[1];
        const indent = indentWidth(prefix);
        const quote = (prefix.match(/>/g) ?? []).length;
        const rest = match[3] ?? '';
        // Measure in the same unit as `indent`: a tab counts as four columns.
        // Otherwise, in a tab-indented list every item counts as a child of
        // the previous one and the tree turns into a staircase.
        const contentCol = indentWidth(line.slice(0, line.length - rest.length));

        while (stack.length > 0) {
            const top = stack[stack.length - 1];
            if (top.quote === quote && top.contentCol <= indent) break;
            stack.pop();
        }

        const parent = stack.length > 0 ? stack[stack.length - 1].line : -1 - index;
        stack.push({ contentCol, quote, line: index });

        const checkbox = CHECKBOX.exec(rest);
        listItems.push({
            position: span(index, index),
            parent,
            ...(checkbox ? { task: checkbox[1] } : {}),
        });

        // Obsidian quirk (issue 3481): if the text after the checkbox itself
        // starts with a list marker, a second, embedded list item appears on
        // the same line.
        const afterCheckbox = checkbox ? rest.slice(checkbox[0].length) : rest;
        const nested = /^([-*+]|[0-9]+[.)])[ \t]/.exec(afterCheckbox);
        if (nested) {
            const column = line.length - afterCheckbox.length;
            listItems.push({
                position: { start: at(index, column), end: at(index, line.length) },
                parent: index,
            });
        }

        collectTags(line, index, at, tags);
        collectLinks(line, index, at, links);
        lastItemLine = index;
        index++;
    }

    sections.push({ position: span(start, lastItemLine), type: 'list' });
    return index;
}

/** A `%% comment %%` in the middle of a line does not open a comment block. */
function closesOnSameLine(line: string, opener: string): boolean {
    const closer = opener === '%%' ? '%%' : '-->';
    const start = line.indexOf(opener);
    return line.indexOf(closer, start + opener.length) !== -1;
}

/** Tabs count as four columns, as in the editor; `>` as one. */
function indentWidth(prefix: string): number {
    let width = 0;
    for (const character of prefix) {
        width += character === '\t' ? 4 : 1;
    }
    return width;
}

function lineOffsets(lines: string[]): number[] {
    const offsets: number[] = new Array(lines.length);
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
        offsets[i] = offset;
        offset += lines[i].length + 1; // +1 for the \n
    }
    return offsets;
}

function readFrontmatter(yaml: string): Record<string, unknown> | undefined {
    if (yaml.trim() === '') return {};
    try {
        const parsed = parseYaml(yaml);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        // Obsidian reports invalid YAML as an error and provides no
        // frontmatter. Same here: better none than a wrong one.
        return undefined;
    }
}

/**
 * Masks out link and code parts in which a `#` is not a tag:
 * `[[Note#Heading]]`, `[text](target#anchor)` and `` `code` ``. Replaced with
 * spaces so that the column numbers stay correct.
 */
function maskNonTagText(line: string): string {
    const blank = (match: string) => ' '.repeat(match.length);
    return line
        // A `<!-- … -->` in the middle of a line hides its tag from Obsidian;
        // a `%% … %%` in the same place does not. That, too, is measured, not
        // guessed.
        .replace(/<!--.*?-->/g, blank)
        .replace(/`[^`]*`/g, blank)
        .replace(WIKILINK, blank)
        .replace(MARKDOWN_LINK, blank);
}

function collectTags(line: string, lineNumber: number, at: (line: number, col: number) => Pos, into: TagCache[]) {
    if (!line.includes('#')) return;
    for (const match of maskNonTagText(line).matchAll(TAG)) {
        const column = match.index ?? 0;
        into.push({
            position: { start: at(lineNumber, column), end: at(lineNumber, column + match[0].length) },
            tag: '#' + match[1],
        });
    }
}

/** Obsidian tolerates broken percent signs in the target; decodeURI throws. */
function decodeUri(target: string): string {
    try {
        return decodeURI(target);
    } catch {
        return target;
    }
}

function collectLinks(text: string, firstLine: number, at: (line: number, col: number) => Pos, into: LinkCache[]) {
    text.split('\n').forEach((line, offsetLine) => {
        const lineNumber = firstLine + offsetLine;
        for (const match of line.matchAll(WIKILINK)) {
            const column = match.index ?? 0;
            into.push({
                position: { start: at(lineNumber, column), end: at(lineNumber, column + match[0].length) },
                link: match[1].trim(),
                original: match[0],
                displayText: (match[2] ?? match[1]).trim(),
            });
        }
        for (const match of line.matchAll(MARKDOWN_LINK)) {
            const column = match.index ?? 0;
            into.push({
                position: { start: at(lineNumber, column), end: at(lineNumber, column + match[0].length) },
                link: decodeUri(match[2]),
                original: match[0],
                displayText: match[1],
            });
        }
    });
}
