import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createSessionOwnerStore } = await jiti.import("./session-owners.ts");

function environment(initial = null) {
  let state = initial;
  const saved = [];
  return {
    environment: {
      load: () => state,
      save: (next) => {
        state = next;
        saved.push(structuredClone(next));
      },
    },
    getState: () => state,
    saved,
  };
}

test("persists owner assignment, reassignment, clearing, and deletion", () => {
  const env = environment();
  const store = createSessionOwnerStore(env.environment);

  store.setOwnerId("session-1", "user-a");
  assert.equal(store.getOwnerId("session-1"), "user-a");
  store.setOwnerId("session-1", "user-b");
  assert.equal(store.getOwnerId("session-1"), "user-b");
  store.setOwnerId("session-2", "user-a");
  store.setOwnerId("session-1", null);
  assert.equal(store.getOwnerId("session-1"), undefined);
  assert.equal(store.getOwnerId("session-2"), "user-a");

  store.deleteSessionIds(["session-2", "missing"]);
  assert.equal(store.getOwnerId("session-2"), undefined);
  assert.deepEqual(env.getState(), { version: 1, owners: {} });
  assert.equal(env.saved.length, 5);
});

test("inherits an owner only when the child has no direct assignment", () => {
  const env = environment({ version: 1, owners: { parent: "user-a", child: "user-b" } });
  const store = createSessionOwnerStore(env.environment);

  assert.equal(store.getOwnerId("child", store.getOwnerId("parent")), "user-b");
  assert.equal(store.getOwnerId("subagent", store.getOwnerId("parent")), "user-a");
  assert.equal(store.getOwnerId("unassigned"), undefined);
});

test("rejects malformed owner state and invalid ids", () => {
  assert.throws(() => createSessionOwnerStore(environment({ version: 2, owners: {} }).environment), /unsupported version/);
  const store = createSessionOwnerStore(environment().environment);
  assert.throws(() => store.setOwnerId("bad id", "user-a"), /Invalid session id/);
  assert.throws(() => store.setOwnerId("session-1", "bad user id"), /Invalid owner id/);
});
