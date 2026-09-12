/**
 * Test tool without the MCP layer: read the vault, run the query, show the
 * result.
 *
 *   npm run build
 *   node dist/cli.js [--enable-js] [--scope SUBPATH] [--summary] <vault-directory>... <query-file>
 *   node dist/cli.js --check [--scope SUBPATH] [--summary] <vault-directory>...
 *
 * Example:
 *   node dist/cli.js /path/to/vault examples/morning-briefing.txt
 *
 * `--check` runs no query but checks the invariants from `src/invariants.ts`
 * against the vault — properties that must hold regardless of the content.
 * That makes it possible to check an arbitrarily large, unknown vault for
 * which nobody could write down an expected result.
 *
 * `--summary` prints **no task text at all**: no result lines, no file paths,
 * no quoted findings — only counts, rule names and timings. The normal output
 * quotes the notes it read, and a vault is usually private. Anything that
 * leaves the machine — a bug report, a CI log, a terminal shared with a
 * language model — should be produced with `--summary`, so that discretion
 * does not depend on somebody remembering to redact afterwards.
 */
import './bootstrap';

import { readFileSync } from 'node:fs';
import { runQuery } from './engine';
import { checkVault, RULES, type Finding } from './invariants';

const usage =
    'Usage: node dist/cli.js [--enable-js] [--scope SUBPATH] [--summary] <vault-directory>... <query-file>\n' +
    '       node dist/cli.js --check [--scope SUBPATH] [--summary] <vault-directory>...\n' +
    '\n' +
    '  --summary  print counts only, never task text, paths or quoted lines —\n' +
    '             for output that leaves the machine.';

const raw = process.argv.slice(2);
const args: string[] = [];
let enableJs = false;
let check = false;
let summary = false;
let scope: string | undefined;
let bad: string | null = null;

for (let index = 0; index < raw.length; index++) {
    const arg = raw[index];
    if (arg === '--enable-js') enableJs = true;
    else if (arg === '--check') check = true;
    else if (arg === '--summary') summary = true;
    else if (arg === '--scope' || arg === '-scope') {
        scope = raw[++index];
        if (scope === undefined) bad = '--scope needs a subpath.';
    } else if (arg.startsWith('-')) bad = `Unknown option: ${arg}`;
    else args.push(arg);
}

if (bad || args.length < (check ? 1 : 2)) {
    console.error(bad ?? usage);
    process.exit(2);
}

if (check) {
    await runCheck(args);
} else {
    await runQueryFile(args.slice(0, -1), args[args.length - 1]);
}

async function runQueryFile(rootDirs: string[], queryFile: string) {
    const outcome = await runQuery(rootDirs, readFileSync(queryFile, 'utf8'), { enableJs, scope });
    const { stats } = outcome;
    const timing =
        `Time: parsing ${stats.parseMillis} ms (${stats.fileCount} files, ` +
        `${outcome.total} tasks), query ${stats.queryMillis} ms`;

    console.log('=== Vault settings ===');
    console.log(outcome.settings.settingsFile ?? '(none found — defaults)');
    console.log(`global filter: ${outcome.settings.globalFilter || '(none)'}`);
    console.log(`statuses: ${outcome.settings.statusSymbols.join(' ')}`);
    console.log(`JavaScript in queries: ${outcome.settings.jsEnabled ? 'allowed' : 'off'}`);
    console.log(`scope: ${scope ?? '(whole vault)'}`);
    for (const warning of outcome.settings.warnings) console.log(`WARNING: ${warning}`);
    console.log();
    reportProblems(outcome.problems);
    console.log('=== query.error ===');
    console.log(outcome.error ?? '(none — every line understood)');
    console.log();
    console.log('=== explainQuery() ===');
    console.log(outcome.explanation);

    if (outcome.error) {
        console.log(timing);
        process.exit(1);
    }

    if (outcome.searchError) {
        console.log('=== Error while running ===');
        console.log(outcome.searchError);
    }

    const cut = outcome.matchedBeforeLimit - outcome.matched;
    const limitNote = cut > 0 ? ` (${outcome.matchedBeforeLimit} before \`limit\`, ${cut} cut off)` : '';

    console.log('=== Result ===');
    console.log(`Matches: ${outcome.matched} of ${outcome.total} tasks${limitNote}`);
    console.log();
    console.log(summary ? '(task lines suppressed by --summary)' : outcome.markdown);
    console.log(timing);
}

/**
 * Problem lines name the file and, for a parse error, quote the offending
 * line. Under `--summary` only the count is left.
 */
function reportProblems(problems: string[]) {
    if (problems.length === 0) return;
    console.log('=== Problems while reading ===');
    if (summary) {
        console.log(`${problems.length} file(s) — details suppressed by --summary`);
    } else {
        for (const problem of problems.slice(0, 20)) console.log(problem);
        if (problems.length > 20) console.log(`… and ${problems.length - 20} more`);
    }
    console.log();
}

/**
 * Findings are grouped by rule and capped per rule.
 *
 * A systematic error would otherwise produce a thousand identical lines, and
 * the one other rule underneath would be lost. Task text appears only in
 * `detail`, and note names only in `path` — `--summary` drops both and leaves
 * the counts, which is what a bug report needs anyway.
 */
async function runCheck(rootDirs: string[]) {
    const report = await checkVault(rootDirs, { scope });

    console.log('=== Vault settings ===');
    console.log(report.settings.settingsFile ?? '(none found — defaults)');
    console.log(`global filter: ${report.settings.globalFilter || '(none)'}`);
    console.log(`statuses: ${report.settings.statusSymbols.join(' ')}`);
    console.log(`scope: ${scope ?? '(whole vault)'}`);
    for (const warning of report.settings.warnings) console.log(`WARNING: ${warning}`);
    console.log();

    console.log('=== Checked ===');
    console.log(
        `${report.counts.files} files, ${report.counts.tasks} tasks, ` +
            `${report.counts.listItems} list items in ${report.millis} ms`,
    );
    for (const [rule, description] of Object.entries(RULES)) console.log(`  ${rule}: ${description}`);
    console.log();

    reportProblems(report.problems);

    console.log('=== Findings ===');
    if (report.findings.length === 0) {
        console.log('None. Every invariant holds.');
    } else {
        for (const [rule, found] of byRule(report.findings)) {
            console.log(`\n${rule} — ${found.length} finding(s): ${RULES[rule] ?? ''}`);
            if (summary) continue;
            for (const finding of found.slice(0, 10)) {
                console.log(`  ${finding.path}:${finding.line} — ${finding.detail}`);
            }
            if (found.length > 10) console.log(`  … and ${found.length - 10} more`);
        }
        if (summary) console.log('\nLocations and quoted lines suppressed by --summary.');
    }

    if (report.findings.length > 0 || report.problems.length > 0) process.exit(1);
}

function byRule(findings: Finding[]): Map<string, Finding[]> {
    const grouped = new Map<string, Finding[]>();
    for (const finding of findings) {
        const list = grouped.get(finding.rule);
        if (list) list.push(finding);
        else grouped.set(finding.rule, [finding]);
    }
    return grouped;
}
