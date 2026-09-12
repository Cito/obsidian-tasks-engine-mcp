import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The version the MCP server reports. Baked in here rather than read at run
// time: dist/ is a bundle and has no package.json beside it.
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

// The trick the whole project rests on: 'obsidian' is aliased to our shim.
// That makes it possible to bundle the real query engine outside Obsidian.
await build({
    // Set the output names explicitly: as soon as entry points come from
    // several directories, esbuild would otherwise produce dist/src/… and
    // dist/tests/… — and the MCP configuration points at dist/server.js.
    entryPoints: [
        { in: resolve(root, 'src/cli.ts'), out: 'cli' },
        { in: resolve(root, 'src/server.ts'), out: 'server' },
        { in: resolve(root, 'tests/selftest.ts'), out: 'selftest' },
        { in: resolve(root, 'tests/conformance.ts'), out: 'conformance' },
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outdir: resolve(root, 'dist'),
    alias: { obsidian: resolve(root, 'src/obsidian-shim.ts') },
    define: { __VERSION__: JSON.stringify(version) },
    // The query language quick reference goes into the bundle as text, so
    // that dist/server.js does not need the repo path to the submodule.
    loader: { '.md': 'text' },
    // A few dependencies (yaml, for instance) ship as CommonJS and call
    // `require('process')`. An ESM bundle has no require — supply one here,
    // otherwise startup fails.
    banner: {
        js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
    },
    logLevel: 'info',
});
