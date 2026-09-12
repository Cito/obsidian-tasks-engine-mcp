/**
 * Adopt the Tasks plugin settings of the vault.
 *
 * ==========================================================================
 *  Why this is not optional
 * ==========================================================================
 *
 * Without this step the engine computes with its default values while
 * Obsidian computes with the user's. Two examples:
 *
 *  - `globalFilter: "#task"` — Obsidian only considers lines carrying `#task`
 *    to be tasks. Without the setting every checkbox is a task, easily three
 *    times as many: the query then returns shopping and packing lists too.
 *  - `customStatuses` — in the vault `[-]` may mean "Cancelled" and `[/]` "In
 *    Progress". Unknown symbols count as TODO to the engine, so `not done`
 *    returns cancelled tasks as well.
 *
 * Everything set here is a **process-wide singleton** (the plugin does the
 * same in `main.ts`). Set it afresh on every run, never merely add to it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { GlobalFilter } from '../vendor/obsidian-tasks/src/Config/GlobalFilter';
import { GlobalQuery } from '../vendor/obsidian-tasks/src/Config/GlobalQuery';
import { getSettings, resetSettings, updateSettings } from '../vendor/obsidian-tasks/src/Config/Settings';
import { StatusSettings } from '../vendor/obsidian-tasks/src/Config/StatusSettings';
import { StatusRegistry } from '../vendor/obsidian-tasks/src/Statuses/StatusRegistry';
import { EnableJsInTasksQueries } from '../vendor/obsidian-tasks/src/Config/EnableJsInTasksQueries';
import { InMemoryLocalStorageProvider } from '../vendor/obsidian-tasks/src/Config/InMemoryLocalStorageProvider';

import { describeProblem } from './paths';

const PLUGIN_DATA = join('.obsidian', 'plugins', 'obsidian-tasks-plugin', 'data.json');

export interface AppliedSettings {
    /**
     * The settings file that was used, named from the root it was found for —
     * `null` if none was found.
     *
     * Relative, like every other path that leaves this process: the settings
     * file otherwise names the user's home directory in every answer, and it
     * survives even `--summary`. The tail is the constant `PLUGIN_DATA`, so
     * what the leading `../` say is how far above the root the vault begins —
     * a depth, not anybody's directory names.
     */
    settingsFile: string | null;
    globalFilter: string;
    globalQuery: string;
    /** Every known status symbol, spelled as it appears in the checkbox. */
    statusSymbols: string[];
    /** Whether `filter by function` and relatives are allowed. */
    jsEnabled: boolean;
    /** Everything the user should know before trusting the result. */
    warnings: string[];
}

/**
 * Looks for the settings file from `startDir` upwards.
 *
 * Upwards, because the caller may also pass subdirectories of a vault as
 * `rootDirs` — `.obsidian/` then lives further up.
 */
export function findSettingsFile(startDir: string): string | null {
    let dir = resolve(startDir);
    for (;;) {
        const candidate = join(dir, PLUGIN_DATA);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

export interface EngineOptions {
    /**
     * Allow JavaScript in queries (`filter by function`, `sort by function`,
     * placeholders).
     *
     * This setting is **not** in data.json but in Obsidian's vault-local app
     * storage — so it cannot be read from outside. Hence a switch of its own
     * here, with the same default as the plugin: off. Turning it on lets
     * arbitrary JavaScript from the query run.
     */
    enableJs?: boolean;

    /**
     * Vault-relative subpath the scan is restricted to — for example
     * `Projects/`. Files outside it are not read; task paths stay relative to
     * the vault root. It has no effect on the settings: data.json belongs to
     * the vault, not to the subpath.
     */
    scope?: string;
}

export function applyVaultSettings(rootDirs: string[], options: EngineOptions = {}): AppliedSettings {
    const warnings: string[] = [];
    const enableJs = options.enableJs ?? false;

    // The plugin loads this value from Obsidian's app storage at startup.
    // Without initialisation, even parsing a query with `by function` throws.
    const storage = new InMemoryLocalStorageProvider();
    storage.save('enableJsInTasksQueries', enableJs);
    EnableJsInTasksQueries.initialise(storage);

    // Always reset to factory state first: otherwise the singletons survive
    // the previous call with different rootDirs.
    resetSettings();
    GlobalFilter.getInstance().reset();
    GlobalQuery.getInstance().reset();
    StatusRegistry.getInstance().resetToDefaultStatuses();

    // Each settings file is remembered together with the root it was found
    // for, so it can be named relative to that root rather than absolutely.
    const found: { file: string; root: string }[] = [];
    for (const root of rootDirs) {
        const file = findSettingsFile(root);
        if (file !== null && !found.some((other) => other.file === file)) found.push({ file, root });
    }

    if (found.length === 0) {
        warnings.push(
            'No Tasks plugin settings found (' +
                PLUGIN_DATA +
                '). Defaults apply: no global filter, only the standard statuses. ' +
                'The result may differ from what Obsidian shows.',
        );
        return { settingsFile: null, ...currentValues(), warnings };
    }

    const named = found.map(({ file, root }) => relativeToRoot(file, root));

    if (found.length > 1) {
        warnings.push(
            'The requested directories belong to several vaults with settings of their own (' +
                named.join(', ') +
                `). Applied are those from ${named[0]}; for the others the result may differ.`,
        );
    }

    const settingsFile = named[0];
    try {
        updateSettings(JSON.parse(readFileSync(found[0].file, 'utf8')));
    } catch (error) {
        warnings.push(`${settingsFile} is not readable (${describeProblem(error, rootDirs)}). Defaults apply.`);
        return { settingsFile: null, ...currentValues(), warnings };
    }

    // The same order as TasksPlugin.loadSettings() in main.ts.
    const settings = getSettings();
    GlobalFilter.getInstance().set(settings.globalFilter);
    GlobalFilter.getInstance().setRemoveGlobalFilter(settings.removeGlobalFilter);
    GlobalQuery.getInstance().set(settings.globalQuery);
    StatusSettings.applyToStatusRegistry(settings.statusSettings, StatusRegistry.getInstance());

    return { settingsFile, ...currentValues(), warnings };
}

/**
 * `.obsidian/…/data.json` as seen from the root that was asked about.
 *
 * `findSettingsFile()` searches upwards, so the answer may legitimately lie
 * above the root — then the path begins with `../`, which says how far up and
 * nothing else. Everything after it is the fixed `PLUGIN_DATA`.
 */
function relativeToRoot(file: string, root: string): string {
    return relative(resolve(root), resolve(file)).split(sep).join('/');
}

function currentValues() {
    return {
        globalFilter: GlobalFilter.getInstance().get(),
        globalQuery: GlobalQuery.getInstance().hasInstructions() ? getSettings().globalQuery : '',
        statusSymbols: StatusRegistry.getInstance().registeredStatuses.map((status) => `[${status.symbol}]`),
        jsEnabled: EnableJsInTasksQueries.getInstance().get(),
    };
}
