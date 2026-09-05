# @ailoud/core

The domain layer of [AILoud](https://github.com/lorem-dev/ailoud): the model,
the ports, and the pure logic that does no I/O.

Every effect reaches this package as a port -- `Fs`, `Clock`, `AudioTool`,
`TranscriptionProvider`, `RecordingStore`, `Summarizer` -- implemented in
[`@ailoud/providers`](https://www.npmjs.com/package/@ailoud/providers) and wired
together by the [`ailoud`](https://www.npmjs.com/package/ailoud) CLI. A lint
rule fails the build if anything here imports `node:fs`, `node:child_process`
or a network module.

Published because the CLI depends on it. The interfaces are not stable yet, and
there is no reason to depend on this package directly.

Documentation: <https://lorem-dev.github.io/ailoud/>
