import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./route.ts");

function installBridge(t, request) {
  const previous = globalThis.__piWebSubagentsBridges;
  globalThis.__piWebSubagentsBridges = new Map([["session-a", { request, dispose() {} }]]);
  t.after(() => { globalThis.__piWebSubagentsBridges = previous; });
}

test("returns a bounded sanitized run snapshot from pi-subagents RPC", async (t) => {
  installBridge(t, async (method) => {
    if (method === "ping") return { methods: ["status", "steer", "stop"] };
    return {
      asyncSnapshot: {
        kind: "pi-subagents.async-status-snapshot",
        version: 1,
        generatedAt: 100,
        omitted: { runs: 0, children: 0 },
        runs: [{
          id: "run-a",
          kind: "workflow",
          label: "Review\u001b[31m task",
          state: "running",
          startedAt: 50,
          activity: { currentTool: "read\u0000file", lastActivityAt: 90, turnCount: 4 },
          children: [{ id: "child-a", kind: "step", label: "worker", state: "complete" }],
        }],
      },
    };
  });

  const response = await GET(new Request("http://localhost/api/subagents/extension?sessionId=session-a"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.available, true);
  assert.deepEqual(body.controls, { steer: true, stop: true });
  assert.equal(body.runs[0].label, "Review task");
  assert.equal(body.runs[0].activity.currentTool, "readfile");
  assert.equal(body.runs[0].children[0].id, "child-a");
  assert.equal("turnCount" in body.runs[0].activity, false);
});

test("returns transcript text on an explicit run inspection", async (t) => {
  const calls = [];
  installBridge(t, async (method, params) => {
    calls.push({ method, params });
    return { text: "run output\u001b[31m red" };
  });

  const response = await GET(new Request("http://localhost/api/subagents/extension?sessionId=session-a&runId=run-1"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.transcript, "run output red");
  assert.deepEqual(calls[0], { method: "status", params: { id: "run-1", view: "transcript", lines: 80 } });
});

test("validates and forwards steer and stop controls to the current session extension", async (t) => {
  const calls = [];
  installBridge(t, async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  });
  const steerResponse = await POST(new Request("http://localhost/api/subagents/extension?sessionId=session-a", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "steer", runId: "run-1", message: " focus on tests " }),
  }));
  assert.equal(steerResponse.status, 200);
  assert.deepEqual(calls[0], { method: "steer", params: { id: "run-1", message: " focus on tests " } });

  const stopResponse = await POST(new Request("http://localhost/api/subagents/extension?sessionId=session-a", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "stop", runId: "run-1" }),
  }));
  assert.equal(stopResponse.status, 200);
  assert.deepEqual(calls[1], { method: "stop", params: { id: "run-1" } });
});

test("rejects malformed controls and reports stale runs as conflicts", async (t) => {
  installBridge(t, async () => { throw Object.assign(new Error("run is no longer active"), { code: "invalid_state" }); });
  const send = (body) => POST(new Request("http://localhost/api/subagents/extension?sessionId=session-a", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  assert.equal((await send({ action: "steer", runId: "run-1", message: " " })).status, 400);
  assert.equal((await send({ action: "drop", runId: "run-1" })).status, 400);
  assert.equal((await send({ action: "stop", runId: "../outside" })).status, 400);
  const stale = await send({ action: "stop", runId: "run-1" });
  assert.equal(stale.status, 409);
});

test("requires a session id and treats an absent extension as unavailable", async (t) => {
  const bad = await GET(new Request("http://localhost/api/subagents/extension"));
  assert.equal(bad.status, 400);

  installBridge(t, async () => { throw new Error("pi-subagents did not respond"); });
  const missing = await GET(new Request("http://localhost/api/subagents/extension?sessionId=session-a"));
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).available, false);
});
