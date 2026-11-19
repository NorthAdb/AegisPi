// Env-gated fault injection for the 06 section 9 crash matrix. The suites arm
// one named point per child process via AEGISPI_CRASH_POINT and the process
// SIGKILLs itself exactly there — no cleanup handlers, no graceful shutdown,
// the same on-disk state a power cut would leave. Without the env var every
// call is a no-op, so production behavior is untouched.
//
// When AEGISPI_CRASH_MARKER is set, the kill is WITNESSED: the point name is
// written synchronously before the SIGKILL, so the parent can tell an
// intended crash-point kill from any other death. On Windows both a SIGKILL
// self-kill and an uncaught exception surface as exit code 1 with signal
// null — the fresh marker is the only discriminator there.

import { writeFileSync } from "node:fs";

export function crashpoint(name) {
  if (process.env.AEGISPI_CRASH_POINT === name) {
    const marker = process.env.AEGISPI_CRASH_MARKER;
    if (marker) {
      writeFileSync(marker, name);
    }
    process.kill(process.pid, "SIGKILL");
  }
}
