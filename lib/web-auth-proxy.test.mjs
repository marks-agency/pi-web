import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const originalUsersFile = process.env.PI_WEB_USERS_FILE;
const originalAuthMode = process.env.PI_WEB_AUTH_MODE;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { GET: webAuthGet, POST: webAuthPost } = await jiti.import("../app/api/web-auth/route.ts");
const {
  createUserSelectionToken,
  createWebSessionToken,
  createWebUserRecord,
  createWebUsersFile,
} = await jiti.import("./web-auth.ts");
const { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } = await import("./auth-throttle.ts");

before(() => { process.env.PI_WEB_PASSWORD = "secret"; });
beforeEach(() => { recordAuthSuccess(); });
after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
  if (originalUsersFile === undefined) delete process.env.PI_WEB_USERS_FILE;
  else process.env.PI_WEB_USERS_FILE = originalUsersFile;
  if (originalAuthMode === undefined) delete process.env.PI_WEB_AUTH_MODE;
  else process.env.PI_WEB_AUTH_MODE = originalAuthMode;
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

test("redirects page navigation to the login page and preserves its query", () => {
  const response = proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login?next=%2F%3Fsession%3Dabc");
});

test("accepts a signed session for pages", () => {
  const token = createWebSessionToken("secret");
  const response = proxy(request("/", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("keeps Basic Auth compatibility for APIs but not pages", () => {
  const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
  assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 200);
  assert.equal(proxy(request("/", { Authorization: authorization })).status, 307);
  assert.equal(proxy(request("/api/sessions")).status, 401);
});

test("leaves the login endpoint reachable without a session", () => {
  assert.equal(proxy(request("/login")).status, 200);
  assert.equal(proxy(request("/api/web-auth")).status, 200);
});

function basic(password) {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

test("a wrong Basic password blocks further attempts, even with the right password", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  assert.ok(getAuthRetryAfterMs() > 0);

  for (const path of ["/api/sessions", "/api/web-auth"]) {
    const response = proxy(request(path, { Authorization: basic("secret") }));
    assert.equal(response.status, 429, path);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("GET /api/web-auth cannot be used to check Basic passwords without the throttle", () => {
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess") })).status, 200);
  assert.ok(getAuthRetryAfterMs() > 0);
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess-2") })).status, 429);
});

test("a signed session keeps working while Basic attempts are blocked", () => {
  proxy(request("/api/sessions", { Authorization: basic("guess") }));
  const token = createWebSessionToken("secret");
  const response = proxy(request("/api/sessions", {
    Authorization: basic("guess"),
    Cookie: `pi_web_session=${token}`,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("only Basic credentials count as password attempts", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: "Bearer token" })).status, 401);
  assert.equal(getAuthRetryAfterMs(), 0);
});

test("users mode ignores forwarded Basic headers while preserving login and API auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-users-proxy-"));
  const previousUsersFile = process.env.PI_WEB_USERS_FILE;
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const usersFile = join(directory, "users.json");
  const password = "synthetic-fixture-password";
  const user = createWebUserRecord({ id: "alice-id", username: "alice", password });

  try {
    await writeFile(usersFile, JSON.stringify(createWebUsersFile([user])), { mode: 0o600 });
    await chmod(usersFile, 0o600);
    process.env.PI_WEB_USERS_FILE = usersFile;
    delete process.env.PI_WEB_PASSWORD;

    const authorization = basic("edge-fixture-credential");
    const statusRequest = request("/api/web-auth", { Authorization: authorization });
    assert.equal(proxy(statusRequest).status, 200);
    const statusResponse = await webAuthGet(statusRequest);
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json();
    assert.equal(statusBody.mode, "users");
    assert.equal(statusBody.authenticated, false);
    assert.equal(Object.hasOwn(statusBody, "user"), false);
    assert.equal(Object.hasOwn(statusBody, "users"), false);
    assert.equal(getAuthRetryAfterMs(), 0);

    const loginRequest = new NextRequest("http://localhost/api/web-auth", {
      method: "POST",
      headers: {
        Host: "localhost",
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: user.username, password }),
    });
    assert.equal(proxy(loginRequest).status, 200);
    assert.equal(getAuthRetryAfterMs(), 0);
    const loginResponse = await webAuthPost(loginRequest);
    assert.equal(loginResponse.status, 200);
    const sessionCookie = loginResponse.cookies.get("pi_web_session")?.value;
    assert.ok(sessionCookie);
    assert.equal(getAuthRetryAfterMs(), 0);

    assert.equal(proxy(request("/api/sessions", {
      Authorization: authorization,
      Cookie: `pi_web_session=${sessionCookie}`,
    })).status, 200);
    assert.equal(getAuthRetryAfterMs(), 0);

    assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 401);
    assert.equal(getAuthRetryAfterMs(), 0);
  } finally {
    recordAuthSuccess();
    if (previousUsersFile === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = previousUsersFile;
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    await rm(directory, { recursive: true, force: true });
  }
});

test("selection mode redirects until a profile is chosen but does not authenticate that identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-profile-proxy-"));
  const previousUsersFile = process.env.PI_WEB_USERS_FILE;
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const previousMode = process.env.PI_WEB_AUTH_MODE;
  const usersFile = join(directory, "users.json");
  const user = createWebUserRecord({ id: "profile-123", username: "alice", displayName: "Alice", password: "fixture-only-password" });
  const users = createWebUsersFile([user]);
  try {
    await writeFile(usersFile, JSON.stringify(users), { mode: 0o600 });
    await chmod(usersFile, 0o600);
    process.env.PI_WEB_USERS_FILE = usersFile;
    process.env.PI_WEB_AUTH_MODE = "selection";
    delete process.env.PI_WEB_PASSWORD;

    const edgeHeader = { Authorization: "Basic dGVzdDp0ZXN0" };
    assert.equal(proxy(request("/")).status, 307);
    assert.equal(proxy(request("/api/sessions", edgeHeader)).status, 401);
    assert.equal(proxy(request("/login", edgeHeader)).status, 200);
    assert.equal(proxy(request("/api/web-auth", edgeHeader)).status, 200);
    assert.equal(getAuthRetryAfterMs(), 0);

    const profileToken = createUserSelectionToken(user, users.sessionSecret);
    const profileCookie = { Cookie: `pi_web_profile=${profileToken}` };
    assert.equal(proxy(request("/api/sessions", { ...edgeHeader, ...profileCookie })).status, 200);
    assert.equal(proxy(request("/login", { ...edgeHeader, ...profileCookie })).status, 200);
    assert.equal(proxy(request("/api/sessions", { ...edgeHeader, Cookie: `pi_web_session=${profileToken}` })).status, 401);

    delete process.env.PI_WEB_AUTH_MODE;
    assert.equal(proxy(request("/api/sessions", { Cookie: `pi_web_profile=${profileToken}` })).status, 401);
    process.env.PI_WEB_AUTH_MODE = "users";
    assert.equal(proxy(request("/api/sessions")).status, 503);
    process.env.PI_WEB_AUTH_MODE = "selection";
    process.env.PI_WEB_PASSWORD = "fixture-only-conflict";
    assert.equal(proxy(request("/api/sessions")).status, 503);
  } finally {
    recordAuthSuccess();
    if (previousUsersFile === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = previousUsersFile;
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    if (previousMode === undefined) delete process.env.PI_WEB_AUTH_MODE;
    else process.env.PI_WEB_AUTH_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Basic success does not reset earlier failures", () => {
  recordAuthFailure(Date.now() - 2_000);
  assert.equal(getAuthRetryAfterMs(), 0);
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("secret") })).status, 200);

  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  // The second failure in a row doubles the block instead of starting over.
  assert.ok(getAuthRetryAfterMs() > 1_000);
});
