// Jest setupFiles entry for the `no-tools` project (see jest.config.cjs).
//
// resources.spec.ts is the one spec file that belongs to both projects at
// once: its stub-only cases run everywhere, but its real-audio cases must
// never run here, on a machine CI never provisions with ffmpeg or
// whisper-cli. Jest assigns a whole FILE to a project via testMatch; it has
// no equivalent for one describe block inside a file shared by two projects.
// This env flag is that missing granularity -- resources.spec.ts reads it
// and skips the real-audio describe block whenever it is not "true".
process.env.AILOUD_E2E_TOOLS = 'false';
