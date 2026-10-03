import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// Every production call to pi's createAgentSessionServices must go through
// lib/agent-session-services.ts, which sets the claude-bridge registration
// marker under a lock. Tests that build isolated fixture services are exempt.
test("createAgentSessionServices is only called through the Pi Web shim", () => {
  const output = execFileSync(
    "git",
    ["grep", "-l", "-E", "(await|=>) createAgentSessionServices\\(", "--", "app", "lib", "hooks", "components", "bin", "proxy.ts"],
    { encoding: "utf8" },
  );
  const callers = output.split("\n").filter(Boolean).filter((file) => !/\.test\.mjs$/.test(file));
  assert.deepEqual(callers, ["lib/agent-session-services.ts"]);
});
