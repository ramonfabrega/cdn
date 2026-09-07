# skills/

`cdn/SKILL.md` is **generated** — it is exactly what `cdn --llms-full` prints, and
it is committed so that a change to a command's schema shows up as a diff someone
can read, rather than as a silent change in what agents are told.

Regenerate after touching any command:

```sh
bun run skill      # from packages/cli
```

If the diff surprises you, the schema surprised you first — that is the point of
committing it.

## Installing it

```sh
cdn skills add
```

That writes skill files into your agent's config (Claude Code, Cursor, and
others) so the CLI is discovered without being described. It is not run here and
not run by any test: it writes outside the repo, and a repo should not install
things on the machine that checked it out.

`cdn --mcp` and `cdn mcp add` are the other half of the same idea — the same
commands as MCP tools — if you would rather have them that way.

## For the author

The hand-written `share` skill in the author's dotfiles is superseded by this
one. It should become a pointer: the CLI's schemas are now the source of truth
for what the commands take and return, and a second hand-maintained description
is a second thing to keep true.
