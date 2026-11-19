// Env-gated fault injection for the 06 section 9 crash matrix. The suites arm
// one named point per child process via AEGISPI_CRASH_POINT and the process
// SIGKILLs itself exactly there — no cleanup handlers, no graceful shutdown,
// the same on-disk state a power cut would leave. Without the env var every
// call is a no-op, so production behavior is untouched.

export function crashpoint(name) {
  if (process.env.AEGISPI_CRASH_POINT === name) {
    process.kill(process.pid, "SIGKILL");
  }
}
