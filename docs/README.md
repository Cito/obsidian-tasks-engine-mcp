# Developer documentation

This directory is aimed at **contributors** — anyone changing the code. If you
only want to use the server, the [project README](../README.md) is the right
place; it also explains how to check your own vault.

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Why the project is built this way: a submodule instead of a reimplementation, the alias instead of a mock, why nothing is parsed by hand, why TypeScript stays — then security: what must not happen to a private vault and which code stops it — and, at the end, the non-goals: what this server will never do. |
| [TODO.md](TODO.md) | What is still open, and the two standing duties that are the long-term work. Written in the Obsidian Tasks format, so it doubles as a worked example of what the server reads. |
| [TESTS.md](TESTS.md) | The four layers of checking — static checks, fixtures, invariants, comparison with real Obsidian data — and what each one can and cannot do. |

The rules for patches are in [CONTRIBUTING.md](../CONTRIBUTING.md).

One level deeper lies the **detailed map of the engine**: which vendor class is
responsible for what, which runtime symbols the shim has to provide and in
which order the plugin starts up. It sits as a skill in
`.claude/skills/obsidian-tasks-engine/SKILL.md` — useful without Claude Code
too, it is an ordinary Markdown file.
