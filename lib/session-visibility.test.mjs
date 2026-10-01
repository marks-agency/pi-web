import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { createSessionVisibilityStore } = await jiti.import("./session-visibility.ts");

test("session visibility is private to each profile and supports hide/restore", () => {
  let persisted = null;
  const store = createSessionVisibilityStore({
    load: () => persisted,
    save: (state) => { persisted = structuredClone(state); },
  });

  store.setHidden("alice", ["root-session", "child-session"], true);
  assert.deepEqual([...store.getHiddenSessionIds("alice")].sort(), ["child-session", "root-session"]);
  assert.deepEqual([...store.getHiddenSessionIds("bob")], []);

  store.setHidden("alice", ["root-session", "child-session"], false);
  assert.deepEqual([...store.getHiddenSessionIds("alice")], []);
  assert.deepEqual(persisted.hiddenByProfile, {});
});

test("session deletion cleans hidden ids from every profile", () => {
  let persisted = null;
  const store = createSessionVisibilityStore({
    load: () => persisted,
    save: (state) => { persisted = structuredClone(state); },
  });
  store.setHidden("alice", ["root", "child"], true);
  store.setHidden("bob", ["child", "other"], true);

  store.deleteSessionIds(["child"]);

  assert.deepEqual([...store.getHiddenSessionIds("alice")], ["root"]);
  assert.deepEqual([...store.getHiddenSessionIds("bob")], ["other"]);
});

test("session visibility store rejects invalid identifiers and corrupt persisted state", () => {
  const store = createSessionVisibilityStore({ load: () => null, save: () => {} });
  assert.throws(() => store.setHidden("../profile", ["session"], true), /profile id/i);
  assert.throws(() => store.setHidden("alice", ["../session"], true), /session id/i);
  assert.throws(() => createSessionVisibilityStore({
    load: () => ({ version: 1, hiddenByProfile: { alice: ["../session"] } }),
    save: () => {},
  }), /invalid profile or session id/i);
});
