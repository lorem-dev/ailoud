// Jest setupFiles entry for the `tools` project (see jest.config.cjs and
// setupNoTools.cjs, its counterpart). Marks this run as one where real
// ffmpeg, whisper-cli and a model are expected, so resources.spec.ts's
// real-audio describe block actually executes here instead of skipping.
process.env.AILOUD_E2E_TOOLS = 'true';
