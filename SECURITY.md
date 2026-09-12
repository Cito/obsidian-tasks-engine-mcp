# Security

This server points a language model at somebody's notes. Security here is a
goal of the same rank as correctness, not an afterthought — what the server
guarantees, and how, is written down in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** under "Security is a goal of
the same rank as correctness".

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately instead:
[Report a vulnerability](https://github.com/Cito/obsidian-tasks-engine-mcp/security/advisories/new)
(GitHub's private vulnerability reporting).

A useful report says which guarantee breaks, on which transport (stdio or
`--http`), with which flags, and gives the smallest query or vault layout that
shows it. **Do not attach your own vault or output taken from it.** Build the
case from a few throwaway notes, or use `--summary`, which prints counts and
rule names and no task text.

You can expect an acknowledgement within a week. This is a project maintained
in spare time, so there is no fixed deadline for a fix — but a confirmed
vulnerability takes precedence over everything else, and you will be credited
in the advisory unless you would rather not be.

## Supported versions

Only the latest release, and `main`, receive fixes.

## What counts

Anything that breaks one of the guarantees the server makes:

- **A file outside the configured roots is read**, or its contents or name
  reach a response — through a symbolic link, `..`, a crafted `rootDirs` or
  `-scope`, or any other path.
- **Something other than tasks leaves the vault** — frontmatter, surrounding
  note text, or an absolute path in a result or an error message.
- **A request reaches the host**: code execution, a shell, a network call,
  or `filter by function` running without `--enable-js`.
- **The vault is written to**, in any way.
- **The HTTP transport can be reached or used from where it should not be**:
  from a non-loopback address, by a foreign `Host` or `Origin` (DNS
  rebinding), or without the token when `OBSIDIAN_TASKS_MCP_TOKEN` is set.
- **Text from the vault escapes the `<vault-content>` fence**, so that it
  can pass for the server's own words.

## What does not

- **What an operator switched on deliberately.** `--enable-js` runs arbitrary
  JavaScript from queries and `--allow-any-root` lets the caller choose any
  directory — both by design, both off by default.
- **The limits documented as such** in docs/ARCHITECTURE.md under "Risks that
  have no fix here, only honesty": task text reaching the model, output
  outliving the query, a model being talked round by instructions written in a
  note, and an expensive query taking a long time.
- **Bugs in the code this server builds on** that do not cross one of the
  boundaries above belong with that project:
  - the query engine, to the
    [Obsidian Tasks plugin](https://github.com/obsidian-tasks-group/obsidian-tasks);
  - the MCP protocol and transports, including the Host and Origin checks, to
    the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
    (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`);
  - any other dependency, to its own maintainers.

  If such a bug *does* break a guarantee here, report it here as well — the
  server chose to rely on that code and is responsible for what it lets
  through. Please report it to the other project through its own security
  policy too, rather than in a public issue.
