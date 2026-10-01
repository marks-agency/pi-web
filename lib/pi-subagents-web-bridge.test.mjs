import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  createPiSubagentsRpcRequest,
  getPiSubagentsBridge,
  registerPiSubagentsBridge,
  unregisterPiSubagentsBridge,
} = await jiti.import("./pi-subagents-web-bridge.ts");

function eventBus() {
  const listeners = new Map();
  return {
    emit(name, data) {
      for (const listener of listeners.get(name) ?? []) void listener(data);
    },
    on(name, listener) {
      const group = listeners.get(name) ?? new Set();
      group.add(listener);
      listeners.set(name, group);
      return () => group.delete(listener);
    },
  };
}

test("sends a versioned pi-subagents RPC request and resolves its correlated reply", async () => {
  const events = eventBus();
  events.on("subagents:rpc:v1:request", (request) => {
    assert.equal(request.version, 1);
    assert.equal(request.method, "status");
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: { ok: true },
    });
  });
  const request = createPiSubagentsRpcRequest(events);
  assert.deepEqual(await request("status"), { ok: true });
});

test("preserves pi-subagents error codes for stale-run handling", async () => {
  const events = eventBus();
  events.on("subagents:rpc:v1:request", (request) => {
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: false,
      error: { code: "invalid_state", message: "run has already finished" },
    });
  });
  const request = createPiSubagentsRpcRequest(events);
  await assert.rejects(request("stop", { id: "run-1" }), (error) => {
    assert.equal(error.code, "invalid_state");
    assert.match(error.message, /already finished/);
    return true;
  });
});

test("registers and removes a session-scoped bridge", () => {
  const request = async () => ({ ok: true });
  const dispose = registerPiSubagentsBridge("pi-web-bridge-test", request);
  assert.equal(getPiSubagentsBridge("pi-web-bridge-test"), request);
  dispose();
  assert.equal(getPiSubagentsBridge("pi-web-bridge-test"), undefined);

  registerPiSubagentsBridge("pi-web-bridge-test", request);
  unregisterPiSubagentsBridge("pi-web-bridge-test");
  assert.equal(getPiSubagentsBridge("pi-web-bridge-test"), undefined);
});
