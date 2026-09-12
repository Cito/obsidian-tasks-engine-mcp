/**
 * How a path is compared, and how a problem is said.
 *
 * Two questions that look unrelated and are not. Both decide what leaves the
 * vault, and both are answered here so that a later `problems.push()` in a new
 * place cannot answer them differently by accident.
 *
 * **Comparison.** `isInside()` is the predicate the directory walk and the
 * scope check are built on. It compares *resolved* paths, so `..` is refused
 * rather than joined, and it is deliberately the only implementation: a
 * security predicate that exists twice is a security predicate that is wrong
 * in one of the two places.
 *
 * **Reporting.** The result of a query names files the way Obsidian does —
 * relative to the vault root. Everything beside the result used to name them
 * the way the file system does, absolutely, which handed a caller that knows
 * only a port the user's home directory, where each vault sits and, through
 * the settings warnings, the existence of vaults it was never given. The facts
 * are worth reporting; the paths are not the fact. `vaultRelative()` and
 * `describeProblem()` say the same thing in the vault's own terms.
 *
 * Reporting *less* is not the fix and never was — concealing a problem is the
 * failure this project is named for. Nothing below drops a problem; they only
 * change the words it is said in.
 */
import { relative, resolve, sep } from 'node:path';

/** Does `path` lie inside `base`? Guards against `..` in a scope. */
export function isInside(path: string, base: string): boolean {
    const from = resolve(base);
    const to = resolve(path);
    return to === from || to.startsWith(from + sep);
}

/**
 * A path as the answer spells it: relative to the vault root, '/' separated —
 * exactly like the `path` of a task.
 *
 * Anything that does not lie inside the root is named by that fact alone. It
 * is the one case where the path itself is what must not be said: a symbolic
 * link's target outside the vault is somebody's directory layout, and the
 * report exists to say that the link was skipped, not where it pointed.
 */
export function vaultRelative(path: string, vaultRoot: string): string {
    if (!isInside(path, vaultRoot)) return '(outside the vault)';
    const rel = relative(resolve(vaultRoot), resolve(path)).split(sep).join('/');
    return rel === '' ? '(the vault root)' : rel;
}

/**
 * What went wrong, without where.
 *
 * A Node file-system error carries the fact twice: once as `code`/`syscall`,
 * once as a message with the absolute path quoted into it
 * (`EACCES: permission denied, scandir '/home/…/vault/Sub'`). The path is
 * already in the report, relative, put there by the caller — so the message is
 * cut at the syscall and only the diagnosis is kept.
 *
 * Anything that is not an `errno` error falls back to its message with the
 * configured roots and any remaining absolute path taken out of it.
 */
export function describeProblem(error: unknown, roots: string[] = []): string {
    const errno = error as NodeJS.ErrnoException | null;
    if (errno && typeof errno.code === 'string' && typeof errno.syscall === 'string') {
        const cut = (errno.message ?? '').indexOf(`, ${errno.syscall}`);
        if (cut > 0) return errno.message.slice(0, cut);
        return `${errno.code} (${errno.syscall})`;
    }
    return redactPaths(error instanceof Error ? error.message : String(error), roots);
}

/**
 * Free text with the file system taken out of it: the configured roots become
 * `<vault>`, anything else that still looks like an absolute path becomes
 * `<path>`.
 *
 * This is the last line rather than the first: the paths that reach a report
 * on purpose go through `vaultRelative()`, and `describeProblem()` reads the
 * diagnosis off `code`/`syscall` instead of the message. What is left for this
 * function is the text nobody anticipated — an unexpected `Error.message` on
 * its way to the caller — which is exactly the text that gets no review.
 *
 * A URL is not touched: the `//` in `https://…` is preceded by a colon, which
 * the pattern refuses to start after.
 */
export function redactPaths(text: string, roots: string[]): string {
    const resolved = [...new Set(roots.map((root) => resolve(root)))].sort((a, b) => b.length - a.length);
    const withoutRoots = resolved.reduce((acc, root) => acc.split(root).join('<vault>'), text);
    return withoutRoots.replace(/(^|[\s'"`(<])((?:[A-Za-z]:)?[\\/][^\s'"`)>]+)/g, '$1<path>');
}
