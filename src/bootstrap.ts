/**
 * Runs before any vendor module is used.
 *
 * Obsidian provides `moment` globally, and the engine reaches for it in many
 * places without importing it. ESM imports are hoisted — a `window.moment = …`
 * at the top of cli.ts would therefore run AFTER the engine's module bodies.
 * Hence this setup lives in a module of its own: whoever imports it first is
 * guaranteed to have it run first.
 */
import moment from 'moment';
import { initializeI18n } from '../vendor/obsidian-tasks/src/i18n/i18n';

const globals = globalThis as unknown as { window?: { moment?: typeof moment }; moment?: typeof moment };
globals.window = globals.window ?? {};
globals.window.moment = moment;
globals.moment = moment;

let ready: Promise<void> | null = null;

/** Once per process: bring up i18next, otherwise `i18n.t()` throws. */
export function bootstrap(): Promise<void> {
    ready ??= initializeI18n();
    return ready;
}
