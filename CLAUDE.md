# CLAUDE.md -- laud

`laud` is a command-line tool that transcribes audio and video into a local
recording library, and, in a later milestone, will summarize and answer
questions over it through a large language model. Speech-to-text and the
LLM are separate engine layers behind stable ports. There is no GUI; the
CLI is the only front end, and the interface is English-only.

**Must read before touching code:**

- [AGENTS.md](./AGENTS.md) -- project overview, workspace layout, the
  dependency direction, running the gate, conventions, and local skills.
- [CONTRIBUTING.md](./CONTRIBUTING.md) -- commit rules, dependency license
  policy, GPG signing.
