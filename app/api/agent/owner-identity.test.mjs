import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { POST } = await jiti.import("./[id]/route.ts");
const { createUserWebSessionToken, createWebUserRecord, createWebUsersFile } = await jiti.import("../../../lib/web-auth.ts");

test("agent commands receive the signed-in actor separately from spoofable command fields", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-agent-owner-"));
  const previousUsersFile = process.env.PI_WEB_USERS_FILE;
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const previousRegistry = globalThis.__piSessions;
  const usersPath = join(directory, "users.json");
  const user = createWebUserRecord({ id: "alice-id", username: "alice", password: "a sufficiently long password" });
  const users = createWebUsersFile([user]);
  await writeFile(usersPath, JSON.stringify(users), { mode: 0o600 });
  await chmod(usersPath, 0o600);
  process.env.PI_WEB_USERS_FILE = usersPath;
  delete process.env.PI_WEB_PASSWORD;
  const calls = [];
  globalThis.__piSessions = new Map([[
    "session-1",
    { isAlive: () => true, send: async (...args) => { calls.push(args); return { newSessionId: "child-1" }; } },
  ]]);

  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    if (previousUsersFile === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = previousUsersFile;
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    await rm(directory, { recursive: true, force: true });
  });

  const token = createUserWebSessionToken(user, users.sessionSecret);
  const response = await POST(new Request("http://localhost/api/agent/session-1", {
    method: "POST",
    headers: { Cookie: `pi_web_session=${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "fork_branch", actorUserId: "attacker", ownerUserId: "attacker" }),
  }), { params: Promise.resolve({ id: "session-1" }) });

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0][0], { type: "fork_branch", actorUserId: "attacker", ownerUserId: "attacker" });
  assert.deepEqual(calls[0][1], { actorUserId: "alice-id" });
});
