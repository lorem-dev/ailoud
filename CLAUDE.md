# CLAUDE.md -- ailoud

`ailoud` is a command-line tool that transcribes audio and video into a local
recording library, searches it, and summarizes and answers questions over it
through a large language model. Speech-to-text and the LLM are separate engine
layers behind stable ports. There is no GUI; the CLI is the only front end, and
the interface is English-only.

**Must read before touching code:**

- [AGENTS.md](./AGENTS.md) -- project overview, workspace layout, the
  dependency direction, running the gate, conventions, and local skills.
- [CONTRIBUTING.md](./CONTRIBUTING.md) -- commit rules, dependency license
  policy, GPG signing.

<!-- CODEGRAPH_START -->

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call -- the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely -- indexing is the user's decision.
<!-- CODEGRAPH_END -->
