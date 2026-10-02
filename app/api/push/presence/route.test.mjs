import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { DELETE, POST } = await jiti.import("./route.ts");
const {
  createUserWebSessionToken,
  createWebUserRecord,
  createWebUsersFile,
} = await jiti.import("../../../../lib/web-auth.ts");

test("presence heartbeats are bound to the signed-in profile and require identity in users mode", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-notification-presence-"));
  const usersPath = join(directory, "users.json");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousUsersFile = process.env.PI_WEB_USERS_FILE;
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const previousMode = process.env.PI_WEB_AUTH_MODE;
  const previousNotifier = globalThis.__piWebPushNotifier;
  const alice = createWebUserRecord({ id: "alice", username: "alice", password: "a sufficiently long password" });
  const bob = createWebUserRecord({ id: "bob", username: "bob", password: "another sufficiently long password" });
  const users = createWebUsersFile([alice, bob]);
  await writeFile(usersPath, JSON.stringify(users), { mode: 0o600 });
  await chmod(usersPath, 0o600);
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_WEB_USERS_FILE = usersPath;
  delete process.env.PI_WEB_PASSWORD;
  delete process.env.PI_WEB_AUTH_MODE;

  const reports = [];
  const removals = [];
  globalThis.__piWebPushNotifier = Promise.resolve({
    reportPresence: (...args) => {
      reports.push(args);
      return true;
    },
    removePresence: (...args) => removals.push(args),
  });
  t.after(async () => {
    globalThis.__piWebPushNotifier = previousNotifier;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousUsersFile === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = previousUsersFile;
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    if (previousMode === undefined) delete process.env.PI_WEB_AUTH_MODE;
    else process.env.PI_WEB_AUTH_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  });

  const clientId = "tab-1234567890abcdef";
  const requestFor = (profile, method, body) => new Request("http://localhost/api/push/presence", {
    method,
    headers: {
      host: "localhost",
      Cookie: `pi_web_session=${createUserWebSessionToken(profile, users.sessionSecret)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const heartbeat = await POST(requestFor(alice, "POST", {
    clientId, visible: true, focused: true, lastActivityAt: Date.now(),
  }));
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).engaged, true);
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0], "alice");
  assert.equal(reports[0][1], clientId);
  assert.equal(reports[0][2].visible, true);

  const removed = await DELETE(requestFor(bob, "DELETE", { clientId }));
  assert.equal(removed.status, 200);
  assert.deepEqual(removals, [["bob", clientId]]);

  const unauthenticated = await POST(new Request("http://localhost/api/push/presence", {
    method: "POST",
    headers: { host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, visible: true, focused: true, lastActivityAt: Date.now() }),
  }));
  assert.equal(unauthenticated.status, 401);
});
