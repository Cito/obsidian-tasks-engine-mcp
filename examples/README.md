# Example queries

One query per file, in Obsidian Tasks syntax — the same text you would put
inside a ```` ```tasks ```` code block. Lines starting with `#` are comments
and are ignored by the engine.

```bash
node dist/cli.js /path/to/vault examples/morning-briefing.txt
node dist/cli.js --enable-js /path/to/vault examples/scripting.txt
node dist/cli.js docs examples/todo.txt        # a smoke test on this repo's own docs/
```

| File | Shows |
|---|---|
| `morning-briefing.txt` | what is actionable today: dates, `is not blocked`, `show tree`, `sort by urgency` |
| `weekly-review.txt` | what got done recently, grouped into headings |
| `blocked-and-waiting.txt` | dependencies between tasks (`id` / `dependsOn`) |
| `overdue-and-undated.txt` | a boolean combination, and filtering on missing dates |
| `by-tag.txt` | grouping by tag |
| `scripting.txt` | `filter by function` — needs `--enable-js` |
| `todo.txt` | open items, hardest first, grouped by heading — can be run on this repository's own `docs/TODO.md` |

They are not decoration: `tests/selftest.ts` runs every file in this directory
through the engine and fails if a single line is no longer understood. So an
instruction the plugin renames or drops on a `git submodule update --remote`
surfaces here rather than in somebody's first attempt.
