import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./web-auth.ts");
}

function authorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

test("enables password authentication only for a non-empty configured password", async () => {
  const { isWebPasswordEnabled } = await loadSubject();
  assert.equal(isWebPasswordEnabled(undefined), false);
  assert.equal(isWebPasswordEnabled(""), false);
  assert.equal(isWebPasswordEnabled("secret"), true);
});

test("accepts only the fixed pi username and configured password", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  assert.equal(isValidBasicAuthorization(authorization("pi", "secret"), "secret"), true);
  assert.equal(isValidBasicAuthorization(authorization("admin", "secret"), "secret"), false);
  assert.equal(isValidBasicAuthorization(authorization("pi", "wrong"), "secret"), false);
});

test("supports UTF-8 passwords and colons in the password", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  const password = "口令:with:colons";
  assert.equal(isValidBasicAuthorization(authorization("pi", password), password), true);
});

test("rejects missing, malformed, and non-canonical authorization values", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  const valid = authorization("pi", "secret");

  assert.equal(isValidBasicAuthorization(null, "secret"), false);
  assert.equal(isValidBasicAuthorization("Bearer token", "secret"), false);
  assert.equal(isValidBasicAuthorization("Basic !!!", "secret"), false);
  assert.equal(isValidBasicAuthorization(`${valid}!`, "secret"), false);
  assert.equal(isValidBasicAuthorization(
    `Basic ${Buffer.from("missing-separator", "utf8").toString("base64")}`,
    "secret",
  ), false);
});

test("does not authenticate when password protection is disabled", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  assert.equal(isValidBasicAuthorization(authorization("pi", ""), ""), false);
  assert.equal(isValidBasicAuthorization(authorization("pi", "secret"), undefined), false);
});

test("local user credentials and signed identities are bound to immutable user ids and credential versions", async () => {
  const auth = await loadSubject();
  const directory = mkdtempSync(join(tmpdir(), "pi-web-auth-test-"));
  const path = join(directory, "users.json");
  const originalPath = process.env.PI_WEB_USERS_FILE;
  const originalPassword = process.env.PI_WEB_PASSWORD;
  const user = auth.createWebUserRecord({
    id: "user-123",
    username: "alice",
    displayName: "Alice",
    password: "correct horse",
  });
  const data = auth.createWebUsersFile([user]);
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  chmodSync(path, 0o600);
  process.env.PI_WEB_USERS_FILE = path;
  delete process.env.PI_WEB_PASSWORD;
  try {
    const config = auth.getWebAuthConfig();
    assert.equal(config.mode, "users");
    assert.equal(auth.verifyWebUserPassword(auth.findWebUserByUsername(config, "ALICE"), "correct horse"), true);
    assert.equal(auth.verifyWebUserPassword(auth.findWebUserByUsername(config, "alice"), "wrong"), false);
    assert.equal(auth.verifyWebUserPassword(undefined, "wrong"), false);

    const token = auth.createUserWebSessionToken(user, data.sessionSecret, Date.UTC(2026, 8, 7), "a".repeat(32));
    assert.equal(auth.getWebSessionIdentity(token, config, Date.UTC(2026, 8, 7))?.id, "user-123");
    assert.equal(auth.getWebSessionIdentity(`v1.${token}`, config), null);

    const changedUser = { ...user, credentialVersion: user.credentialVersion + 1 };
    writeFileSync(path, JSON.stringify(auth.createWebUsersFile([changedUser], data.sessionSecret)), { mode: 0o600 });
    chmodSync(path, 0o600);
    const changedConfig = auth.getWebAuthConfig();
    assert.equal(auth.getWebSessionIdentity(token, changedConfig, Date.UTC(2026, 8, 7)), null);
  } finally {
    if (originalPath === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = originalPath;
    if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = originalPassword;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local users configuration fails closed when missing, malformed, or combined with legacy password", async () => {
  const auth = await loadSubject();
  const originalPath = process.env.PI_WEB_USERS_FILE;
  const originalPassword = process.env.PI_WEB_PASSWORD;
  try {
    process.env.PI_WEB_USERS_FILE = join(tmpdir(), `missing-pi-web-users-${Date.now()}.json`);
    delete process.env.PI_WEB_PASSWORD;
    assert.throws(() => auth.getWebAuthConfig(), /does not exist/);

    const directory = mkdtempSync(join(tmpdir(), "pi-web-auth-invalid-"));
    const path = join(directory, "users.json");
    writeFileSync(path, "not-json", { mode: 0o600 });
    chmodSync(path, 0o600);
    process.env.PI_WEB_USERS_FILE = path;
    assert.throws(() => auth.getWebAuthConfig(), /Could not read Pi Web users file/);

    process.env.PI_WEB_PASSWORD = "legacy-secret";
    assert.throws(() => auth.getWebAuthConfig(), /cannot both be configured/);
    rmSync(directory, { recursive: true, force: true });
  } finally {
    if (originalPath === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = originalPath;
    if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = originalPassword;
  }
});

test("profile selection is signed, separate from authentication, and bound to configured profiles", async () => {
  const auth = await loadSubject();
  const directory = mkdtempSync(join(tmpdir(), "pi-web-profile-selection-"));
  const path = join(directory, "users.json");
  const originalPath = process.env.PI_WEB_USERS_FILE;
  const originalPassword = process.env.PI_WEB_PASSWORD;
  const originalMode = process.env.PI_WEB_AUTH_MODE;
  const user = auth.createWebUserRecord({
    id: "profile-123",
    username: "alice",
    displayName: "Alice",
    password: "fixture-only-password",
  });
  const data = auth.createWebUsersFile([user]);
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  chmodSync(path, 0o600);
  process.env.PI_WEB_USERS_FILE = path;
  process.env.PI_WEB_AUTH_MODE = "selection";
  delete process.env.PI_WEB_PASSWORD;
  try {
    const config = auth.getWebAuthConfig();
    assert.equal(config.mode, "selection");
    const now = Date.now();
    const token = auth.createUserSelectionToken(user, data.sessionSecret, now, "b".repeat(32));
    const identity = auth.getUserSelectionIdentity(token, config, now);
    assert.deepEqual(identity, { id: user.id, username: user.username, displayName: user.displayName, mode: "selection" });
    assert.equal(auth.getWebSessionIdentity(token, config, now), null);
    assert.deepEqual(auth.getWebRequestIdentity(
      new Request("http://localhost", { headers: { Cookie: `pi_web_profile=${token}` } }),
      config,
    ), identity);
    assert.equal(auth.getWebRequestIdentity(
      new Request("http://localhost", { headers: { Cookie: `pi_web_session=${token}` } }),
      config,
    ), null);
    const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    assert.equal(auth.getUserSelectionIdentity(tampered, config, now), null);
    assert.equal(auth.getUserSelectionIdentity(token, config, now + auth.PI_WEB_PROFILE_MAX_AGE * 1000), null);
    const unknown = auth.createUserSelectionToken({ id: "unknown-profile" }, data.sessionSecret, now, "c".repeat(32));
    assert.equal(auth.getUserSelectionIdentity(unknown, config, now), null);
  } finally {
    if (originalPath === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = originalPath;
    if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = originalPassword;
    if (originalMode === undefined) delete process.env.PI_WEB_AUTH_MODE;
    else process.env.PI_WEB_AUTH_MODE = originalMode;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selection mode requires a configured users file", async () => {
  const auth = await loadSubject();
  const originalPath = process.env.PI_WEB_USERS_FILE;
  const originalPassword = process.env.PI_WEB_PASSWORD;
  const originalMode = process.env.PI_WEB_AUTH_MODE;
  delete process.env.PI_WEB_USERS_FILE;
  delete process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_AUTH_MODE = "selection";
  try {
    assert.throws(() => auth.getWebAuthConfig(), /requires PI_WEB_USERS_FILE/);
  } finally {
    if (originalPath === undefined) delete process.env.PI_WEB_USERS_FILE;
    else process.env.PI_WEB_USERS_FILE = originalPath;
    if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = originalPassword;
    if (originalMode === undefined) delete process.env.PI_WEB_AUTH_MODE;
    else process.env.PI_WEB_AUTH_MODE = originalMode;
  }
});

test("creates signed sessions that expire and cannot be altered", async () => {
  const {
    createWebSessionToken,
    isValidWebSessionToken,
    PI_WEB_SESSION_MAX_AGE,
  } = await loadSubject();
  const now = Date.UTC(2026, 8, 7);
  const token = createWebSessionToken("secret", now, "a".repeat(32));

  assert.equal(isValidWebSessionToken(token, "secret", now), true);
  assert.equal(isValidWebSessionToken(token, "wrong", now), false);
  assert.equal(isValidWebSessionToken(`${token.slice(0, -1)}0`, "secret", now), false);
  assert.equal(isValidWebSessionToken(token, "secret", now + PI_WEB_SESSION_MAX_AGE * 1000), false);
});
