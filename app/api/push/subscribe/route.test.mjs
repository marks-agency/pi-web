import "../../../../lib/test-isolate-pi-web-env.mjs";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { DELETE, POST } = await jiti.import("./route.ts");
const {
  createUserSelectionToken,
  createUserWebSessionToken,
  createWebUserRecord,
  createWebUsersFile,
} = await jiti.import("../../../../lib/web-auth.ts");

const readSubscriptions = async (directory) => JSON.parse(await readFile(join(directory, "web-push.json"), "utf8")).subscriptions;

test("push subscriptions bind to a selected profile without treating it as authentication", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-push-selection-"));
  const usersPath = join(directory, "users.json");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousUsersFile = process.env.PI_WEB_USERS_FILE;
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const previousMode = process.env.PI_WEB_AUTH_MODE;
  const previousNotifier = globalThis.__piWebPushNotifier;
  const user = createWebUserRecord({ id: "profile-id", username: "profile", password: "fixture-only-password" });
  const users = createWebUsersFile([user]);
  await writeFile(usersPath, JSON.stringify(users), { mode: 0o600 });
  await chmod(usersPath, 0o600);
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_WEB_USERS_FILE = usersPath;
  process.env.PI_WEB_AUTH_MODE = "selection";
  delete process.env.PI_WEB_PASSWORD;
  globalThis.__piWebPushNotifier = undefined;

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

  const subscription = {
    endpoint: "https://push.example.test/subscription/profile",
    keys: { p256dh: "public-key", auth: "auth-key" },
  };
  const token = createUserSelectionToken(user, users.sessionSecret);
  const response = await POST(new Request("http://localhost/api/push/subscribe", {
    method: "POST",
    headers: { Cookie: `pi_web_profile=${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subscription, locale: "en" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await readSubscriptions(directory), [{ ...subscription, locale: "en", userId: user.id }]);

  const missing = await POST(new Request("http://localhost/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription, locale: "en" }),
  }));
  assert.equal(missing.status, 401);
});

test("push endpoints are bound from authenticated identity and logout cannot unlink another user", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-push-user-"));
  const usersPath = join(directory, "users.json");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousUsersFile = process.env.PI_WEB_USERS_FILE;
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const previousNotifier = globalThis.__piWebPushNotifier;
  const alice = createWebUserRecord({ id: "alice-id", username: "alice", password: "a sufficiently long password" });
  const bob = createWebUserRecord({ id: "bob-id", username: "bob", password: "another sufficiently long password" });
  const users = createWebUsersFile([alice, bob]);
  await writeFile(usersPath, JSON.stringify(users), { mode: 0o600 });
  await chmod(usersPath, 0o600);
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_WEB_USERS_FILE = usersPath;
  delete process.env.PI_WEB_PASSWORD;
  globalThis.__piWebPushNotifier = undefined;

  t.after(async () => {
    globalThis.__piWebPushNotifier = previousNotifier;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousUsersFile === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = previousUsersFile;
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    await rm(directory, { recursive: true, force: true });
  });

  const endpoint = "https://push.example.test/subscription/alice";
  const subscription = { endpoint, keys: { p256dh: "public-key", auth: "auth-secret" } };
  const aliceCookie = `pi_web_session=${createUserWebSessionToken(alice, users.sessionSecret)}`;
  const bobCookie = `pi_web_session=${createUserWebSessionToken(bob, users.sessionSecret)}`;
  const subscribe = (cookie, userId) => POST(new Request("http://localhost/api/push/subscribe", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: { ...subscription, userId }, locale: "en" }),
  }));
  const unsubscribe = (cookie) => DELETE(new Request("http://localhost/api/push/subscribe", {
    method: "DELETE",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  }));

  assert.equal((await subscribe(aliceCookie, "bob-id")).status, 200);
  assert.deepEqual(await readSubscriptions(directory), [{ ...subscription, locale: "en", userId: "alice-id" }]);
  assert.equal((await unsubscribe(bobCookie)).status, 200);
  assert.equal((await readSubscriptions(directory))[0].userId, "alice-id");
  assert.equal((await unsubscribe(aliceCookie)).status, 200);
  assert.deepEqual(await readSubscriptions(directory), []);
  assert.equal((await subscribe("", "alice-id")).status, 401);
});
