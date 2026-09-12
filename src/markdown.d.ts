/**
 * Markdown files are inlined as text by esbuild (loader in
 * scripts/build.mjs). Needed to pull the query language quick reference out of
 * the submodule and into the bundle instead of reading it from the file system
 * at runtime — the server runs from dist/ and must not assume a repo path.
 */
declare module '*.md' {
    const content: string;
    export default content;
}
