// Death-shape controls for the crash-window predicate. Dies in the exact
// shapes the tightened gates must tell apart:
//   crashpoint - reaches the armed production crashpoint (marker + SIGKILL)
//   exception  - uncaught exception while "armed" (exit 1, no marker)
//   clean      - exits 0 on purpose while "armed"
// The suite arms AEGISPI_CRASH_POINT for all three; only the first ever
// reaches crashpoint(), which is precisely the discrimination under test.
import { crashpoint } from "../../../../apps/daemon/src/testing/crashpoints.mjs";

const death = process.env.AEGISPI_PROBE_DEATH ?? "exception";
if (death === "clean") {
  console.log("probe: clean exit");
  process.exit(0);
}
if (death === "crashpoint") {
  crashpoint("probe:crashpoint");
  console.log("probe: NOT REACHED");
  process.exit(0);
}
throw new Error("probe: uncaught exception death");
