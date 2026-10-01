import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { GET, POST, DELETE } = await jiti.import("./route.ts");
const { createWebUserRecord, createWebUsersFile } = await jiti.import("../../../lib/web-auth.ts");
const { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } = await import("../../../lib/auth-throttle.ts");

before(() => { process.env.PI_WEB_PASSWORD = "correct horse battery staple"; });
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

function request(method, body, headers = {}) {
  return new NextRequest("http://localhost/api/web-auth", {
    method,
    headers: {
      Host: "localhost",
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("logs in with one password and reports the signed session", async () => {
  let response = await POST(request("POST", { password: "wrong" }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(response.headers.get("retry-after"), "1");

  recordAuthSuccess();
  response = await POST(request("POST", { password: "correct horse battery staple" }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^pi_web_session=v1\./);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//i);

  const cookiePair = cookie.split(";", 1)[0];
  response = await GET(request("GET", undefined, { Cookie: cookiePair }));
  assert.deepEqual(await response.json(), { enabled: true, mode: "legacy", authenticated: true, user: { id: "legacy", username: "pi", displayName: "Pi" } });
});

test("logs in as a local user and returns its identity from the signed session", async () => {
  const passwordBefore = process.env.PI_WEB_PASSWORD;
  const usersFileBefore = process.env.PI_WEB_USERS_FILE;
  const directory = mkdtempSync(join(tmpdir(), "pi-web-users-"));
  const path = join(directory, "users.json");
  const user = createWebUserRecord({ id: "user-123", username: "alice", displayName: "Alice", password: "correct horse" });
  const users = createWebUsersFile([user]);
  writeFileSync(path, JSON.stringify(users), { mode: 0o600 });
  chmodSync(path, 0o600);
  delete process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_USERS_FILE = path;
  try {
    const response = await POST(request("POST", { username: "Alice", password: "correct horse" }));
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /^pi_web_session=v2\./);
    const status = await GET(request("GET", undefined, { Cookie: cookie.split(";", 1)[0] }));
    assert.deepEqual(await status.json(), {
      enabled: true,
      mode: "users",
      authenticated: true,
      user: { id: "user-123", username: "alice", displayName: "Alice" },
      users: [{ id: "user-123", username: "alice", displayName: "Alice" }],
    });

    const legacyToken = `pi_web_session=v1.invalid`;
    const rejected = await GET(request("GET", undefined, { Cookie: legacyToken }));
    assert.equal((await rejected.json()).authenticated, false);
  } finally {
    if (passwordBefore === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = passwordBefore;
    if (usersFileBefore === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = usersFileBefore;
    rmSync(directory, { recursive: true, force: true });
    recordAuthSuccess();
  }
});

test("selection mode returns profiles and sets an attribution-only cookie without a password", async () => {
  const previousPath = process.env.PI_WEB_USERS_FILE;
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const previousMode = process.env.PI_WEB_AUTH_MODE;
  const directory = mkdtempSync(join(tmpdir(), "pi-web-profile-api-"));
  const path = join(directory, "users.json");
  const user = createWebUserRecord({ id: "profile-123", username: "alice", displayName: "Alice", password: "fixture-only-password" });
  writeFileSync(path, JSON.stringify(createWebUsersFile([user])), { mode: 0o600 });
  chmodSync(path, 0o600);
  process.env.PI_WEB_USERS_FILE = path;
  process.env.PI_WEB_AUTH_MODE = "selection";
  delete process.env.PI_WEB_PASSWORD;
  try {
    const status = await GET(request("GET"));
    assert.deepEqual(await status.json(), {
      enabled: false,
      mode: "selection",
      authenticated: false,
      profiles: [{ id: user.id, displayName: user.displayName }],
      selectedProfile: null,
    });

    const unknown = await POST(request("POST", { profileId: "missing-profile" }));
    assert.equal(unknown.status, 400);

    recordAuthFailure();
    const selected = await POST(request("POST", { profileId: user.id }));
    assert.equal(selected.status, 200);
    assert.ok(getAuthRetryAfterMs() > 0, "profile selection must not clear password failure throttling");
    const profileCookie = selected.cookies.get("pi_web_profile");
    assert.match(profileCookie?.value ?? "", /^p1\./);
    assert.equal(selected.cookies.get("pi_web_session")?.maxAge, 0);
    assert.match(selected.headers.get("set-cookie") ?? "", /HttpOnly/i);

    const selectedStatus = await GET(request("GET", undefined, {
      Cookie: `pi_web_profile=${profileCookie?.value}`,
    }));
    const selectedBody = await selectedStatus.json();
    assert.equal(selectedBody.authenticated, false);
    assert.deepEqual(selectedBody.selectedProfile, { id: user.id, displayName: user.displayName });
    assert.equal(Object.hasOwn(selectedBody, "users"), false);

    const switched = await DELETE(request("DELETE"));
    assert.equal(switched.cookies.get("pi_web_profile")?.maxAge, 0);
    assert.equal(switched.cookies.get("pi_web_session")?.maxAge, 0);
  } finally {
    recordAuthSuccess();
    if (previousPath === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = previousPath;
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    if (previousMode === undefined) delete process.env.PI_WEB_AUTH_MODE;
    else process.env.PI_WEB_AUTH_MODE = previousMode;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when the configured local users file is missing", async () => {
  const originalPath = process.env.PI_WEB_USERS_FILE;
  const passwordBefore = process.env.PI_WEB_PASSWORD;
  delete process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_USERS_FILE = join(tmpdir(), `missing-pi-web-users-${Date.now()}.json`);
  try {
    const response = await GET(request("GET"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "Pi Web authentication is misconfigured");
  } finally {
    if (originalPath === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = originalPath;
    if (passwordBefore === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = passwordBefore;
  }
});

test("blocks further attempts after a failure, even with the right password", async () => {
  let response = await POST(request("POST", { password: "wrong" }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid password", retryAfterMs: 1000 });

  response = await POST(request("POST", { password: "correct horse battery staple" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.has("set-cookie"), false);
  const body = await response.json();
  assert.equal(body.error, "Too many failed attempts");
  assert.ok(body.retryAfterMs > 0 && body.retryAfterMs <= 1000);
});

test("logout clears the session cookie", async () => {
  const response = await DELETE(request("DELETE"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /pi_web_session=;/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/i);
});

test("rejects cross-origin login attempts", async () => {
  const response = await POST(request(
    "POST",
    { password: "correct horse battery staple" },
    { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
  ));
  assert.equal(response.status, 403);
});
