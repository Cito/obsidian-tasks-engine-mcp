/**
 * Replacement for the runtime symbols that the query/task part of
 * obsidian-tasks pulls from the module 'obsidian'.
 *
 * Across the whole reachable graph there are only five of them. Everything
 * else imported from 'obsidian' in src/Query/** and src/Task/** is
 * `import type` and disappears completely at compile time.
 *
 * At build time esbuild aliases 'obsidian' to this file, see
 * scripts/build.mjs.
 */

import type { CachedMetadata } from './metadata';

/*
 * The types the engine imports from 'obsidian', answered with the shapes
 * `src/metadata.ts` actually produces. Type-only: nothing reaches the bundle,
 * but `TasksFile` and `FileParser` are then checked against what we hand them.
 */
export type { CachedMetadata, ListItemCache, SectionCache } from './metadata';
export type FrontMatterCache = NonNullable<CachedMetadata['frontmatter']>;

/** Obsidian shows a popup with this. Outside Obsidian: to stderr. */
export class Notice {
    constructor(message: string) {
        console.error('[Notice]', message);
    }
}

/**
 * Collects every tag of a file — from the frontmatter and from the text.
 *
 * A reimplementation of Obsidian's `getAllTags`. `src/metadata.ts` now really
 * does populate `tags` and `frontmatter`, so nothing here is simplified any
 * more. `null` is returned only when there is no cache at all — that is how
 * `TasksFile` tells "no tags" from "nothing was read".
 */
export function getAllTags(cache: CachedMetadata | null | undefined): string[] | null {
    if (!cache) return null;

    const tags: string[] = [];
    for (const entry of cache.tags ?? []) {
        if (entry?.tag) tags.push(normaliseTag(entry.tag));
    }
    for (const tag of parseFrontMatterTags(cache.frontmatter) ?? []) {
        tags.push(tag);
    }
    return tags;
}

/**
 * Reads the tag declaration out of the frontmatter.
 *
 * A reimplementation of Obsidian's `parseFrontMatterTags`, calibrated against
 * its actual output in
 * `vendor/obsidian-tasks/tests/Obsidian/__test_data__/yaml_tags_*`:
 *
 *   tags: null            -> null    (field present, but empty)
 *   tags: []              -> []      (a list, but empty — not null!)
 *   tags: [a, b]          -> ['#a', '#b']
 *   tags: single          -> ['#single']
 *   tags: one, two        -> []      (one single, invalid tag)
 *
 * The last case is surprising, but that is exactly what was measured:
 * Obsidian does **not** split a string at commas. It is one tag, and a tag
 * containing a comma and a space is invalid and drops out.
 */
export function parseFrontMatterTags(frontmatter: FrontMatterCache | undefined): string[] | null {
    if (!frontmatter) return null;

    const raw = frontmatter.tags ?? frontmatter.tag;
    if (raw === undefined || raw === null) return null;

    const values = Array.isArray(raw) ? raw.flat(Infinity) : [raw];
    return values
        .filter((value) => value !== null && value !== undefined)
        .map((value) => normaliseTag(String(value)))
        .filter(isValidTag);
}

/**
 * A tag may contain letters, digits, `_`, `-`, `/` and emoji, and needs at
 * least one character that is not a digit — otherwise `#1` would be a tag.
 * Spaces and commas make it invalid.
 */
function isValidTag(tag: string): boolean {
    return /^#[\p{L}\p{Emoji_Presentation}\d_/-]+$/u.test(tag) && /[^#\d]/u.test(tag);
}

function normaliseTag(tag: string): string {
    return tag.startsWith('#') ? tag : '#' + tag;
}

/** Obsidian's UI language. Irrelevant for filters, but i18n needs it. */
export function getLanguage(): string {
    return 'en';
}

/** Only used by src/ui/DependencyHelpers.ts; a plain substring search will do. */
export function prepareSimpleSearch(query: string) {
    const q = query.toLowerCase();
    return (text: string) => {
        const i = text.toLowerCase().indexOf(q);
        return i === -1 ? null : { score: -i, matches: [[i, i + q.length]] as [number, number][] };
    };
}

/* ------------------------------------------------------------------------
 * Dummies.
 *
 * `src/Obsidian/Cache.ts` is pulled into the bundle because FileParser and the
 * static helpers `Cache.getSection` / `Cache.getPrecedingHeader` live there.
 * The Cache class itself is never instantiated — only its imports have to
 * resolve. Empty shells therefore suffice; they are never called. Drop a dummy
 * as soon as a symbol is genuinely needed.
 * ------------------------------------------------------------------------ */

/** Only used in Cache.ts, to debounce Obsidian events. */
export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
    return fn;
}

/** Obsidian's file handles. We work with paths directly. */
export class TAbstractFile {
    path = '';
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class Vault {}
export class MetadataCache {}
