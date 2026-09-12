/**
 * Linting for this project's own code — `src/`, `tests/` and `scripts/`.
 *
 * `vendor/obsidian-tasks` is never linted. It brings its own
 * `eslint.config.mjs`, and a finding there would be a finding we must not act
 * on: the submodule stays unmodified.
 *
 * The rules that earn their place here are the type-aware ones. This server
 * runs the engine's process-wide singletons under a mutex, and the MCP layer
 * is asynchronous throughout — an unawaited promise does not crash here, it
 * returns a plausible, wrong answer. `no-floating-promises` and
 * `await-thenable` are the point of the exercise; the stylistic rules are
 * along for the ride.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**', 'vendor/**', 'node_modules/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            globals: globals.node,
            parserOptions: {
                projectService: {
                    // The build scripts are plain ESM and not in tsconfig's
                    // `include`; check them with inferred types rather than
                    // leave them unlinted.
                    allowDefaultProject: ['scripts/*.mjs', 'eslint.config.mjs'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // Deliberate: `void handler(request, response)` in src/server.ts
            // says "this one is not awaited on purpose", which is exactly the
            // distinction the rule is there to force.
            '@typescript-eslint/no-floating-promises': 'error',

            // The engine's types are loose at its edges, but the shim can
            // name the shapes it hands over — so `any` in our own code is an
            // error. Where no type fits, say `unknown` and narrow it.
            '@typescript-eslint/no-explicit-any': 'error',

            // Underscore marks a parameter as knowingly unused.
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

            // Off, all five of them. The vendor tree is untyped at its edges
            // (see scripts/typecheck.mjs) and the build scripts are plain
            // JavaScript, so values arriving from either are `any` far too
            // often for these to be signal. What actually guards that boundary
            // is `npm test` against real vault data.
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
        },
    },
);
