/**
 * Self-check against tests/fixture-vault.
 *
 *   npm test
 *
 * Only what **this** project contributes is checked: the cache built from
 * Markdown (`src/metadata.ts`), adopting the vault settings (`src/settings.ts`)
 * and the path through `src/engine.ts`. The query language itself belongs to
 * the submodule and is tested there — see `docs/TESTS.md`.
 */
import '../src/bootstrap';

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runQuery, type QueryOutcome } from '../src/engine';
import { checkVault, RULES } from '../src/invariants';

// The build output lives in dist/, so go one level up from the bundle.
const vault = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixture-vault');
const vaultWithFilter = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixture-vault-filter');
const examplesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

let failures = 0;

function check(label: string, condition: boolean, detail = '') {
    if (condition) {
        console.log(`  ok      ${label}`);
    } else {
        failures++;
        console.log(`  FAILED  ${label}${detail ? '\n          ' + detail.split('\n').join('\n          ') : ''}`);
    }
}

async function ask(filters: string): Promise<QueryOutcome> {
    const outcome = await runQuery([vault], filters, { enableJs: true });
    if (outcome.error) throw new Error(`Query not understood:\n${filters}\n${outcome.error}`);
    return outcome;
}

const descriptions = (outcome: QueryOutcome) => outcome.tasks.map((task) => task.description);

console.log('\nSettings taken from the vault');
{
    const outcome = await ask('not done');
    check("the vault's data.json was found", outcome.settings.settingsFile !== null);
    check(
        'the custom status [-] is registered',
        outcome.settings.statusSymbols.includes('[-]'),
        outcome.settings.statusSymbols.join(' '),
    );
    check(
        '[-] counts as cancelled, not as open',
        !descriptions(outcome).includes('Cancelled task'),
        descriptions(outcome).join(' | '),
    );
}

console.log('\nCode blocks and frontmatter are not task sources');
{
    const outcome = await ask('description includes code block');
    check('nothing out of ``` blocks', outcome.matched === 0, descriptions(outcome).join(' | '));

    const tildes = await ask('description includes tilde block');
    check('nothing out of ~~~ blocks', tildes.matched === 0, descriptions(tildes).join(' | '));

    const real = await ask('description includes Real task');
    check('the real task next to them is found', real.matched === 1);
}

console.log('\nLine numbers and headings');
{
    const outcome = await ask('path includes Headings\nsort by function task.lineNumber');
    check('line numbers are real, not 0', outcome.tasks.every((task) => task.lineNumber > 0));
    check(
        'each task has a distinct line number',
        new Set(outcome.tasks.map((task) => task.lineNumber)).size === outcome.tasks.length,
        outcome.tasks.map((task) => `${task.lineNumber}: ${task.description}`).join(' | '),
    );

    const underSecond = await ask('heading includes Second');
    check(
        'heading includes filters correctly',
        underSecond.matched === 1 && descriptions(underSecond)[0].includes('second heading'),
        descriptions(underSecond).join(' | '),
    );
}

console.log('\nList tree');
{
    const outcome = await ask('path includes Tree\nnot done\nshow tree');
    check(
        'child tasks appear indented under the parent task',
        /- \[ \] Take over the world\n {4}- \[ \] Draft the world domination plan\n {8}- \[ \] Pick a suitably ominous font/.test(
            outcome.markdown,
        ),
        outcome.markdown,
    );
    check(
        'a list item without a checkbox appears as a child too',
        outcome.markdown.includes('An ordinary list item'),
        outcome.markdown,
    );

    const flat = await ask('path includes Tree\nnot done');
    check('without show tree the list stays flat', !/\n {4}- /.test(flat.markdown), flat.markdown);
}

console.log('\nTab indentation');
{
    // Regression: indentation was measured in columns (tab = 4), the content
    // column in characters. Tab-indented siblings were nested into a staircase.
    const outcome = await ask('path includes Tabs\nnot done\nshow tree');
    check(
        'tab-indented siblings stay siblings',
        /- \[ \] First child\n {4}- \[ \] Second child\n {8}- \[ \] Grandchild/.test(outcome.markdown),
        outcome.markdown,
    );
    check(
        'a child after a space and a tab hangs off the second parent task',
        /- \[ \] Second parent task\n {4}- \[ \] Child after a space and a tab/.test(outcome.markdown),
        outcome.markdown,
    );
}

console.log('\nDependencies');
{
    const blocked = await ask('path includes Dependencies\nis blocked');
    check(
        'is blocked finds exactly the dependent task',
        blocked.matched === 1 && descriptions(blocked)[0].includes('only afterwards'),
        descriptions(blocked).join(' | '),
    );

    const free = await ask('path includes Dependencies\nis not blocked');
    check('is not blocked leaves the other two', free.matched === 2, descriptions(free).join(' | '));
}

console.log('\nFrontmatter');
{
    // TasksFile replaces `frontmatter.tags` with parseFrontMatterTags(), so the
    // result carries the '#' — exactly as in the plugin.
    const list = await ask("filter by function task.file.property('tags').includes('#project')");
    check('the frontmatter list [project, important] is read', list.matched === 2, descriptions(list).join(' | '));

    const property = await ask("filter by function task.file.property('status') === 'active'");
    check('any other frontmatter property is read as YAML', property.matched === 2, descriptions(property).join(' | '));

    const multiline = await ask("filter by function task.file.tags.includes('#multiline')");
    check('multi-line frontmatter tags are read', multiline.matched === 1, descriptions(multiline).join(' | '));

    const scalar = await ask("filter by function task.file.tags.includes('#scalar')");
    check('a single frontmatter tag (key `tag`) is read', scalar.matched === 1, descriptions(scalar).join(' | '));

    const inline = await ask('tags include #inline');
    check('an inline tag on the task still works', inline.matched === 1, descriptions(inline).join(' | '));
}

console.log('\nGlobal filter');
{
    // At the same time the proof that the process-wide singletons are reset
    // when the vault changes: the vault above has no global filter.
    const outcome = await runQuery([vaultWithFilter], 'not done', { enableJs: true });
    check(
        'a line without the global filter is not a task',
        outcome.total === 1,
        `${outcome.total} tasks: ` + outcome.tasks.map((task) => task.description).join(' | '),
    );
    check(
        'the global filter is removed from the output',
        !/(^|\s)#task(\s|$)/m.test(outcome.markdown),
        outcome.markdown,
    );
    check(
        'the nested tag #task/subitem is left alone',
        outcome.markdown.includes('#task/subitem'),
        outcome.markdown,
    );
    check('other tags are left alone', outcome.markdown.includes('#project'), outcome.markdown);

    const withoutFilter = await runQuery([vault], 'not done', { enableJs: true });
    check(
        'afterwards the vault without a global filter has none again',
        withoutFilter.settings.globalFilter === '',
        `globalFilter=${JSON.stringify(withoutFilter.settings.globalFilter)}`,
    );
}

console.log('\nScope');
{
    const whole = await runQuery([vault], 'not done', { enableJs: true });
    const narrow = await runQuery([vault], 'not done', { enableJs: true, scope: 'Subfolder' });

    check(
        'the scope reads fewer files',
        narrow.stats.fileCount < whole.stats.fileCount,
        `${narrow.stats.fileCount} of ${whole.stats.fileCount}`,
    );
    check('there are tasks inside the scope', narrow.total > 0);
    check(
        'only tasks from inside the scope',
        narrow.tasks.every((task) => task.path.startsWith('Subfolder/')),
        narrow.tasks.map((task) => task.path).join(' | '),
    );
    check(
        'paths stay relative to the vault root, not to the scope',
        narrow.tasks.every((task) => !task.path.startsWith('Frontmatter')),
        narrow.tasks.map((task) => task.path).join(' | '),
    );
    check('the scope shows up in the result', narrow.stats.scope === 'Subfolder', String(narrow.stats.scope));
    check('without a scope it stays null', whole.stats.scope === null, String(whole.stats.scope));

    // A mistyped scope would otherwise look like a vault without tasks.
    const missing = await runQuery([vault], 'not done', { enableJs: true, scope: 'DoesNotExist' });
    check(
        'a scope that does not exist is reported',
        missing.problems.length === 1 && missing.total === 0,
        missing.problems.join('\n'),
    );

    const outside = await runQuery([vault], 'not done', { enableJs: true, scope: '../fixture-vault-filter' });
    check(
        'a scope containing .. does not lead out of the vault',
        outside.total === 0 && outside.problems.some((problem) => problem.includes('outside')),
        outside.problems.join('\n'),
    );
}

/**
 * The directory walk is a boundary, and it is not a cliff.
 *
 * Both are regressions. A symbolic link inside the vault used to be followed
 * wherever it pointed, which made `-root` and `-scope` no boundary at all —
 * over HTTP the one that matters. And a directory that could not be scanned
 * threw out of the walk, so one protected folder failed the whole query
 * instead of showing up under "Problems while reading".
 *
 * The fixtures cannot carry either case: an absolute link out of the vault is
 * not portable, and git stores no permissions beyond the execute bit. Hence a
 * throwaway vault built here.
 */
console.log('\nLinks and unreadable directories');
{
    const temporary = mkdtempSync(join(tmpdir(), 'tasks-walk-'));
    const walkVault = join(temporary, 'vault');
    try {
        mkdirSync(join(walkVault, 'Sub'), { recursive: true });
        mkdirSync(join(temporary, 'outside'));
        writeFileSync(join(walkVault, 'Inside.md'), '- [ ] Task inside the vault\n');
        writeFileSync(join(temporary, 'outside', 'Outside.md'), '- [ ] Task outside the vault\n');
        symlinkSync(join(temporary, 'outside'), join(walkVault, 'Escape'));
        symlinkSync(join(temporary, 'outside', 'Outside.md'), join(walkVault, 'EscapingFile.md'));
        symlinkSync(walkVault, join(walkVault, 'Sub', 'Loop'));

        const outcome = await runQuery([walkVault], 'not done');
        check(
            'a link out of the vault is not followed',
            outcome.tasks.every((task) => task.description !== 'Task outside the vault'),
            descriptions(outcome).join(' | '),
        );
        check(
            'the task inside is still found, exactly once',
            descriptions(outcome).filter((text) => text === 'Task inside the vault').length === 1,
            descriptions(outcome).join(' | '),
        );
        check(
            'both escaping links are reported, not passed over in silence',
            outcome.problems.filter((problem) => /^(Escape|EscapingFile\.md): symbolic link leads out/.test(problem))
                .length === 2,
            outcome.problems.join('\n'),
        );
        check(
            'and neither report says where the link pointed',
            outcome.problems.every((problem) => !problem.includes(temporary)),
            outcome.problems.join('\n'),
        );
        check(
            'a link looping back into the vault ends the walk',
            outcome.problems.some((problem) => problem.includes('read already')),
            outcome.problems.join('\n'),
        );

        // Running as root ignores the permission — then there is nothing to test.
        chmodSync(join(walkVault, 'Sub'), 0o000);
        let unreadable = true;
        try {
            readdirSync(join(walkVault, 'Sub'));
            unreadable = false;
        } catch {
            /* as intended: the directory cannot be scanned */
        }
        if (unreadable) {
            const blocked = await runQuery([walkVault], 'not done');
            check(
                'an unreadable directory does not fail the query',
                blocked.tasks.length === 1,
                descriptions(blocked).join(' | '),
            );
            check(
                'an unreadable directory is reported',
                blocked.problems.some((problem) => problem.includes('Sub') && problem.includes('skipped')),
                blocked.problems.join('\n'),
            );
        } else {
            console.log('  skipped an unreadable directory (running with rights that ignore the mode)');
        }
        chmodSync(join(walkVault, 'Sub'), 0o755);
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}

/**
 * An error message is a disclosure path — the one built from whatever went
 * wrong rather than from the result, and therefore the one nobody reviews.
 *
 * Every entry in `problems` used to name an **absolute** path while the result
 * named vault-relative ones, and `errorReporter` quoted the line that failed
 * to parse **verbatim** — a line that passed neither the global filter nor the
 * query, arriving through the back door. Reporting less was never the fix; the
 * facts below are all still reported, in the vault's own terms.
 *
 * The check belongs here and not only where a report is printed, so that a
 * later `problems.push()` somewhere new fails this rather than passing
 * unnoticed. It also covers the two walk paths that nothing else reaches: a
 * broken link, and a file that cannot be read once the walk has listed it.
 */
console.log("\nProblems are said in the vault's own terms");
{
    const temporary = mkdtempSync(join(tmpdir(), 'tasks-reports-'));
    const reportVault = join(temporary, 'Vault');
    const secret = 'A line nobody outside this vault may read';
    try {
        mkdirSync(reportVault, { recursive: true });
        writeFileSync(join(reportVault, 'Readable.md'), '- [ ] A task that can be read\n');
        writeFileSync(join(reportVault, 'Locked.md'), `- [ ] ${secret}\n`);
        symlinkSync(join(temporary, 'nothing-is-here'), join(reportVault, 'Broken.md'));

        chmodSync(join(reportVault, 'Locked.md'), 0o000);
        let unreadable = true;
        try {
            readFileSync(join(reportVault, 'Locked.md'), 'utf8');
            unreadable = false;
        } catch {
            /* as intended: the file cannot be read */
        }

        const outcome = await runQuery([reportVault], 'not done');
        const problems = outcome.problems.join('\n');

        check(
            'a broken link is reported, not thrown',
            outcome.problems.some((problem) => problem.startsWith('Broken.md: ENOENT')),
            problems,
        );
        if (unreadable) {
            check(
                'a file that cannot be read is reported, and the rest is still read',
                outcome.problems.some((problem) => problem.startsWith('Locked.md: EACCES')) &&
                    descriptions(outcome).join() === 'A task that can be read',
                `${problems}\n${descriptions(outcome).join(' | ')}`,
            );
            check('and its content does not come out with the report', !problems.includes(secret), problems);
        } else {
            console.log('  skipped an unreadable file (running with rights that ignore the mode)');
        }
        check(
            'no problem names an absolute path',
            !outcome.problems.some(namesAnAbsolutePath),
            problems,
        );
        check(
            'no problem names the directory the vault sits in',
            !problems.includes(temporary),
            problems,
        );
        check(
            'no settings warning names an absolute path',
            !outcome.settings.warnings.some(namesAnAbsolutePath),
            outcome.settings.warnings.join('\n'),
        );
        check(
            'the settings file, where there is one, is named relative to the root',
            (await runQuery([vault], 'not done')).settings.settingsFile ===
                '.obsidian/plugins/obsidian-tasks-plugin/data.json',
            String((await runQuery([vault], 'not done')).settings.settingsFile),
        );
    } finally {
        chmodSync(join(reportVault, 'Locked.md'), 0o644);
        rmSync(temporary, { recursive: true, force: true });
    }
}

/**
 * A path is absolute if a `/` (or `C:\`) starts a word. Vault-relative paths
 * such as `Sub/Loop` have their slashes inside one.
 */
function namesAnAbsolutePath(text: string): boolean {
    return /(^|[\s'"(])([A-Za-z]:)?[\\/][^\s'"`)]/.test(text);
}

console.log('\nCarriage-return line endings (CRLF)');
{
    // Regression: without CRLF normalisation the line analysis recognised
    // neither headings nor list items. A file from Windows then yielded
    // **zero** tasks — silently, without a message.
    const outcome = await ask('path includes Line-Endings\nshow tree');
    check('tasks from a CRLF file are found', outcome.total > 0 && outcome.matched === 4, String(outcome.matched));
    check(
        'no carriage return in the description',
        outcome.tasks.every((task) => !task.description.includes('\r')),
        JSON.stringify(descriptions(outcome)),
    );
    check(
        'the tree is right in a CRLF file as well',
        /- \[ \] Task with a carriage return\n {4}- \[ \] Child with a carriage return\n {4}- \[ \] Sibling with a carriage return/.test(
            outcome.markdown,
        ),
        outcome.markdown,
    );

    const heading = await ask('path includes Line-Endings\nheading includes CRLF');
    check('the heading of a CRLF file counts as a heading', heading.matched === 4, String(heading.matched));
}

console.log('\nBlock quotes and callouts');
{
    const outcome = await ask('path includes Quotes\nnot done\nshow tree');
    check('tasks inside a callout are found', outcome.markdown.includes('Task in the callout'), outcome.markdown);
    check('tasks inside a block quote are found', outcome.markdown.includes('Task in the quote'), outcome.markdown);
    check(
        'the tree inside the callout is right',
        /- \[ \] Task in the callout\n {4}- \[ \] Child in the callout\n {4}- \[ \] Sibling in the callout/.test(
            outcome.markdown,
        ),
        outcome.markdown,
    );
}

console.log('\nNumbered lists as parents');
{
    // The content column depends on the width of the list marker: `10.` is
    // three characters wide, `-` is one. Comparing indentation alone turns
    // siblings into a staircase.
    const outcome = await ask('path includes Numbered\nnot done\nshow tree');
    check(
        'children under a single digit stay siblings',
        /- \[ \] Child under a single digit\n- \[ \] Sibling under a single digit/.test(outcome.markdown),
        outcome.markdown,
    );
    check(
        'the same under a two-digit number',
        outcome.markdown.includes('Child under a two-digit number'),
        outcome.markdown,
    );
}

console.log('\nDeep nesting and mixed list markers');
{
    const outcome = await ask('path includes Nesting\nnot done\nshow tree');
    check('six levels stay six levels', /\n {20}- \[ \] Level six/.test(outcome.markdown), outcome.markdown);
    check(
        'asterisks and plus signs carry the tree just as well',
        /- \[ \] Asterisk as the list marker\n {4}- \[ \] Plus sign as a child\n {4}- \[ \] Plus sign as a sibling/.test(
            outcome.markdown,
        ),
        outcome.markdown,
    );
}

console.log('\nEmoji, combining marks and tags mid-line');
{
    const outcome = await ask('path includes Special-Characters\nnot done');
    check(
        'combining marks survive',
        descriptions(outcome).some((text) => text.includes('égalité')),
        JSON.stringify(descriptions(outcome)),
    );
    check(
        'typographic punctuation survives',
        descriptions(outcome).some((text) => text.includes('…') && text.includes('—')),
        JSON.stringify(descriptions(outcome)),
    );
    const tag = await ask('path includes Special-Characters\ntag includes #ontheroad');
    check('a tag in the middle of the text is found', tag.matched === 1, String(tag.matched));
}

/**
 * Non-Latin scripts, in file names as well as in task text and tags.
 *
 * Everything downstream — reading the file, the tag regex in
 * `src/metadata.ts`, the description, the round trip back to Markdown —
 * works per code point, not per byte. These fixtures are what says so.
 *
 * The scripts are picked for what they stress, not for reach: combining
 * marks (Hebrew niqqud), an invisible format character (the Persian
 * zero-width non-joiner), right-to-left writing, and scripts without
 * letter case or word spaces.
 */
console.log('\nWriting systems');
{
    const cases: { file: string; text: string; tag: string; open?: number }[] = [
        { file: 'Deutsch', text: 'Größenwahn in angemessener Größe üben', tag: '#größenwahn' },
        { file: 'Français', text: "Conquérir le monde avant l'apéro", tag: '#mégalomanie' },
        { file: 'Português', text: 'ênfase, âmbito global e um mínimo de modéstia', tag: '#ambição' },
        // One task more than the others: the extra line is deliberate, and
        // the count below is what keeps it from being lost unnoticed.
        { file: 'Українська', text: 'Відновити територіальну цілісність у повному обсязі', tag: '#мегаломанія', open: 6 },
        { file: '日本語', text: '世界征服をする', tag: '#野望' },
        { file: '中文', text: '征服世界，最好在周末之前', tag: '#雄心壮志' },
        // Right-to-left, with a zero-width non-joiner inside the word.
        { file: 'فارسی', text: 'نوشتن بیانیه با نیم\u200cفاصله و خط خوش', tag: '#بلندپروازی' },
        // Right-to-left, with combining niqqud on the letters.
        { file: 'עברית', text: 'לכתוב מניפסט מְנֻקָּד כהלכה', tag: '#שאפתנות' },
        { file: '한국어', text: '주말까지 세계를 정복하기', tag: '#야망' },
        // Dotless ı and dotted İ: the classic case-folding trap, and
        // `includes` matches case-insensitively.
        { file: 'Türkçe', text: 'Rahat bir taht ısmarlamak', tag: '#hırs' },
        // Written without spaces between words, with vowels and tone marks
        // stacked above and below the consonants.
        { file: 'ภาษาไทย', text: 'เขียนแถลงการณ์ให้ยิ่งใหญ่', tag: '#ความทะเยอทะยาน' },
    ];

    for (const { file, text, tag, open: expectedOpen = 5 } of cases) {
        const outcome = await ask(`path includes Languages/${file}\nnot done`);
        check(
            `${file}: the file is found under its own name and holds tasks`,
            outcome.matched === expectedOpen,
            `${outcome.matched} tasks: ` + descriptions(outcome).join(' | '),
        );
        check(
            `${file}: the task text comes through unharmed`,
            descriptions(outcome).some((description) => description.includes(text)),
            JSON.stringify(descriptions(outcome)),
        );

        const tagged = await ask(`path includes Languages/${file}\ntag includes ${tag}`);
        check(`${file}: a tag in this script is found`, tagged.matched === 1, String(tagged.matched));
    }

    const tree = await ask('path includes Languages/日本語\nnot done\nshow tree');
    check(
        'the tree works in Japanese too',
        /- \[ \] 世界征服をする 🌍\n {4}- \[ \] 征服計画書を書く/.test(tree.markdown),
        tree.markdown,
    );

    // Not just the file name and the tag: the search text itself has to
    // arrive in the filter unharmed. `includes` compares case-insensitively,
    // which is where accents and dotless ı get interesting.
    const searches: [string, number, string][] = [
        ['牛乳', 1, 'Japanese: buy milk'],
        ['猫粮', 1, 'Chinese: buy cat food'],
        ['ısmarlamak', 1, 'Turkish: the dotless ı in the search text'],
        ['CONQUÉRIR', 1, 'French: accented capitals fold to lower case'],
        ['ração', 1, 'Portuguese: til and cedilla in the search text'],
        ['חלב', 1, 'Hebrew: right-to-left search text'],
        ['شیر', 1, 'Persian: right-to-left search text'],
        ['ซื้อนม', 1, 'Thai: a word not delimited by spaces'],
        ['우유', 1, 'Korean: buy milk'],
    ];
    for (const [needle, expected, label] of searches) {
        const found = await ask(`description includes ${needle}`);
        check(`description includes — ${label}`, found.matched === expected, `${found.matched}: ` + descriptions(found).join(' | '));
    }

    // The language files are built alike, so the totals catch a file that
    // silently fails to parse: five open tasks each (Ukrainian has six) and
    // exactly one done task.
    const expectedOpen = cases.reduce((sum, { open = 5 }) => sum + open, 0);
    const open = await ask('path includes Languages/\nnot done');
    const done = await ask('path includes Languages/\ndone');
    check(
        `all ${cases.length} language files together hold ${expectedOpen} open and ${cases.length} done tasks`,
        open.matched === expectedOpen && done.matched === cases.length,
        `${open.matched} open, ${done.matched} done`,
    );
}

/**
 * The example queries have to keep working.
 *
 * They are the first thing anybody runs, and they are the one part of the
 * repo that speaks the submodule's language directly: an instruction renamed
 * or dropped by a `git submodule update --remote` shows up here and nowhere
 * else. Only parsing is checked — what the queries return depends on the
 * vault and on today's date.
 */
console.log('\nExample queries');
{
    const files = readdirSync(examplesDir).filter((name) => name.endsWith('.txt')).sort();
    check('there are example queries at all', files.length > 0, examplesDir);

    for (const name of files) {
        const source = readFileSync(join(examplesDir, name), 'utf8');
        const outcome = await runQuery([vault], source, { enableJs: true });
        check(`examples/${name}: every line understood`, outcome.error === null, outcome.error ?? '');
        check(`examples/${name}: runs without a search error`, outcome.searchError === null, outcome.searchError ?? '');
    }
}

/**
 * The repository's own TODO list is a vault too.
 *
 * `docs/TODO.md` is written in the Tasks format, which makes it a smoke test
 * that needs no vault at all: if the build cannot read tasks out of a folder
 * of ordinary notes, this fails before anybody gets as far as their own
 * vault. Only that much is asserted — the file is short, and it gets shorter
 * as items are ticked off, so any expectation about its contents would be
 * wrong within a month.
 */
console.log('\nThe repository as a vault (docs/)');
{
    const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
    const source = readFileSync(join(examplesDir, 'todo.txt'), 'utf8');
    const outcome = await runQuery([docsDir], source);

    check('docs/ is read without problems', outcome.problems.length === 0, outcome.problems.join('\n'));
    check('the TODO list yields tasks', outcome.total > 0, `${outcome.total} tasks`);
    check('and some of them are still open', outcome.matched > 0, `${outcome.matched} matched`);
}

/**
 * `--summary` has to stay airtight.
 *
 * A vault is private, and the normal output quotes the notes it read. The
 * flag exists so that output can leave the machine — a bug report, a CI log,
 * a terminal shared with a language model — without anybody having to
 * remember to redact. A promise like that is worth nothing unless something
 * checks it, so this drives the real CLI and reads what actually lands on
 * stdout.
 */
console.log('\nDiscretion (--summary)');
{
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), 'cli.js');
    const run = (args: string[]) =>
        execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    const queryFile = join(examplesDir, 'overdue-and-undated.txt');
    const loud = run([vault, queryFile]);
    const quiet = run(['--summary', vault, queryFile]);

    // The premise: without the flag the task text really is in the output.
    check('without --summary the task lines are printed', loud.includes('Take over the world'), loud.slice(0, 400));

    check(
        'with --summary no task text reaches stdout',
        !quiet.includes('Take over the world') && !quiet.includes('Buy milk'),
        quiet,
    );
    check('with --summary the counts survive', /Matches: \d+ of \d+ tasks/.test(quiet), quiet);

    // The check run must not name notes either: paths are note titles.
    const checked = run(['--check', '--summary', vault]);
    check(
        'with --summary the check names no note',
        !/[\w-]+\.md/.test(checked),
        checked,
    );
    check('with --summary the check still counts', /\d+ files, \d+ tasks/.test(checked), checked);
}

/**
 * The version named in the README has to be the version in the submodule.
 *
 * Prose that repeats a fact recorded elsewhere goes stale — the pin moves
 * and nobody thinks of the README. Rather than leave that to memory, the
 * claim is checked: `manifest.json` is a tracked file, so it is there even
 * in the `--depth 1` clone the README suggests, and no git or tags are
 * needed to read it.
 */
console.log('\nThe version in the README');
{
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const { version } = JSON.parse(
        readFileSync(join(root, 'vendor', 'obsidian-tasks', 'manifest.json'), 'utf8'),
    ) as { version: string };
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const claimed = /\*\*obsidian-tasks (\d+\.\d+\.\d+)\*\*/.exec(readme)?.[1] ?? null;

    check(
        `the README names the submodule's version (${version})`,
        claimed === version,
        claimed === null
            ? 'README.md names no tested obsidian-tasks version — expected a line ' +
              `containing "**obsidian-tasks ${version}**".`
            : `README.md says ${claimed}, the submodule is at ${version}. Update that line.`,
    );
}

console.log('\nReading without incident');
{
    const outcome = await ask('not done');
    check('no file was left unread', outcome.problems.length === 0, outcome.problems.join('\n'));
}

/**
 * The invariants check no expected results but properties that hold for any
 * vault. Here they run over the fixtures; the same check can be turned loose
 * on an arbitrarily large, unknown vault via
 * `node dist/cli.js --check <vault>`.
 */
console.log('\nInvariants');
for (const [name, dir] of [
    ['fixture vault', vault],
    ['vault with a global filter', vaultWithFilter],
] as const) {
    const report = await checkVault([dir]);
    check(
        `${name}: all invariants hold (${report.counts.listItems} list items)`,
        report.findings.length === 0,
        report.findings.map((f) => `${f.rule} ${f.path}:${f.line} — ${f.detail}`).join('\n'),
    );
    check(`${name}: something was checked at all`, report.counts.listItems > 0);
}
check('every invariant is described', Object.values(RULES).every((text) => text.length > 20));

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
