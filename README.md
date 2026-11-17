# github-core-clone

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/nerdwallet6/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/nerdwallet6/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node.js process — no
database, no UI, no git binary, no outside service. Built for the
[make.fun bounty "Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01).

## What it serves

- **Git smart HTTP** at `/<owner>/<repo>.git` — upload-pack protocol v2 (with
  a v0 fallback) and receive-pack v0, with its own object store and packfile
  reader/writer (plain, OFS-delta and REF-delta packs).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests with squash merges.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send, plus introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP (revision
  `2026-07-28`, with a legacy `initialize` handshake fallback) with tools
  for repos, issues and pull requests.

All four surfaces share one in-memory store, so a repository created over
MCP reads back identically over REST, GraphQL and git.

## Run

```sh
node --experimental-strip-types main.ts
```

Node 22.18 or later, no dependencies, no install step. The process binds an
ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL`, serves
until the suite answers `{"done": true}` on `/done`, then exits 0.

## License

MIT — see [LICENSE](LICENSE).
