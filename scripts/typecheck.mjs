/**
 * Type checking, with the vendor tree reported but not enforced.
 *
 * esbuild strips types without looking at them, so `tsc --noEmit` is the only
 * thing in this project that ever asks TypeScript whether the code is right.
 * The complication is that the checker follows imports into
 * `vendor/obsidian-tasks`, which is compiled upstream under its own tsconfig
 * and against the real `obsidian` type definitions. Our shim supplies the
 * runtime symbols the engine needs, not the types — so vendor diagnostics say
 * something about the shim's type surface, not about a mistake anybody here
 * made.
 *
 * Hence two levels:
 *
 *   - Errors in `src/` and `tests/` fail the check. That is the gate.
 *   - Errors under `vendor/` are counted and summarised, never fatal. The
 *     count is a tripwire: if it jumps after a submodule bump, upstream has
 *     started using something the shim does not describe. Run with
 *     `--vendor` to see them in full.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const showVendor = process.argv.includes('--vendor');

const tsc = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
});

if (tsc.error) {
    process.stderr.write(`Could not run tsc: ${tsc.error.message}\n`);
    process.exit(2);
}

const lines = `${tsc.stdout}${tsc.stderr}`.split('\n').filter((line) => line.trim() !== '');

// A diagnostic starts at the left margin; its explanation may run on over
// indented lines. Keep those attached, so a multi-line message is not halved.
const isHeader = (line) => /^\S.* error TS\d+: /.test(line);

const vendor = [];
const own = [];
let target = own;
for (const line of lines) {
    if (isHeader(line)) target = line.startsWith('vendor/') ? vendor : own;
    target.push(line);
}

const ownCount = own.filter(isHeader).length;
const vendorCount = vendor.filter(isHeader).length;

if (showVendor && vendor.length > 0) {
    process.stdout.write(`${vendor.join('\n')}\n\n`);
}

if (own.length > 0) {
    process.stdout.write(`${own.join('\n')}\n`);
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const note =
    vendorCount === 0
        ? 'vendor/: no type errors'
        : `vendor/: ${plural(vendorCount, 'type error')}, not enforced` +
          `${showVendor ? '' : ' — see them with `npm run typecheck -- --vendor`'}`;

if (ownCount > 0) {
    process.stdout.write(`\nsrc/ and tests/: ${plural(ownCount, 'type error')}. ${note}\n`);
    process.exit(1);
}

process.stdout.write(`src/ and tests/: no type errors. ${note}\n`);
