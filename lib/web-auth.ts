import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const PI_WEB_AUTH_USERNAME = "pi";
export const PI_WEB_SESSION_COOKIE = "pi_web_session";
export const PI_WEB_PROFILE_COOKIE = "pi_web_profile";
export const PI_WEB_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
export const PI_WEB_PROFILE_MAX_AGE = PI_WEB_SESSION_MAX_AGE;
export const WEB_USER_PASSWORD_SALT_BYTES = 16;
export const WEB_USER_PASSWORD_HASH_BYTES = 32;

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX_32_PATTERN = /^[a-f0-9]{32}$/;
const HEX_64_PATTERN = /^[a-f0-9]{64}$/;

export interface WebUserRecord {
  id: string;
  username: string;
  displayName: string;
  credentialVersion: number;
  salt: string;
  passwordHash: string;
}

export interface WebUsersFile {
  version: 1;
  sessionSecret: string;
  users: WebUserRecord[];
}

export interface WebUserIdentity {
  id: string;
  username: string;
  displayName: string;
  mode: "legacy" | "users" | "selection";
}

interface WebUsersAuthConfig {
  path: string;
  data: WebUsersFile;
  usersById: Map<string, WebUserRecord>;
}

export type WebAuthConfig =
  | { mode: "none" }
  | { mode: "legacy"; password: string }
  | ({ mode: "users" | "selection" } & WebUsersAuthConfig);

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hashSecret(actual), hashSecret(expected));
}

function parseWebUser(value: unknown): WebUserRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const user = value as Record<string, unknown>;
  if (
    typeof user.id !== "string" || !USER_ID_PATTERN.test(user.id)
    || typeof user.username !== "string" || !USERNAME_PATTERN.test(user.username)
    || typeof user.displayName !== "string" || user.displayName.trim().length === 0 || user.displayName.length > 80
    || !Number.isSafeInteger(user.credentialVersion) || (user.credentialVersion as number) < 1
    || typeof user.salt !== "string" || !HEX_32_PATTERN.test(user.salt)
    || typeof user.passwordHash !== "string" || !HEX_64_PATTERN.test(user.passwordHash)
  ) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName.trim(),
    credentialVersion: user.credentialVersion as number,
    salt: user.salt,
    passwordHash: user.passwordHash,
  };
}

function parseWebUsersFile(value: unknown): WebUsersFile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.sessionSecret !== "string") return null;
  const secretBytes = Buffer.from(candidate.sessionSecret, "base64url");
  if (secretBytes.length !== 32 || secretBytes.toString("base64url") !== candidate.sessionSecret) return null;
  if (!Array.isArray(candidate.users) || candidate.users.length === 0 || candidate.users.length > 1000) return null;
  const users = candidate.users.map(parseWebUser);
  if (users.some((user) => user === null)) return null;
  const validUsers = users as WebUserRecord[];
  const ids = new Set<string>();
  const usernames = new Set<string>();
  for (const user of validUsers) {
    const normalizedUsername = user.username.toLocaleLowerCase("en-US");
    if (ids.has(user.id) || usernames.has(normalizedUsername)) return null;
    ids.add(user.id);
    usernames.add(normalizedUsername);
  }
  return { version: 1, sessionSecret: candidate.sessionSecret, users: validUsers };
}

/**
 * Load the authentication mode from server configuration. Setting
 * PI_WEB_USERS_FILE opts into multi-user auth and is fail-closed: a missing,
 * unreadable, malformed, or conflicting config never falls back to open access.
 */
export function getWebAuthConfig(): WebAuthConfig {
  const configuredUsersPath = process.env.PI_WEB_USERS_FILE?.trim();
  const legacyPassword = process.env.PI_WEB_PASSWORD;
  const configuredMode = process.env.PI_WEB_AUTH_MODE?.trim();
  if (configuredMode && configuredMode !== "selection") {
    throw new Error("PI_WEB_AUTH_MODE must be 'selection' when set");
  }
  const selectionMode = configuredMode === "selection";
  if (selectionMode && !configuredUsersPath) {
    throw new Error("PI_WEB_AUTH_MODE=selection requires PI_WEB_USERS_FILE");
  }
  if (configuredUsersPath) {
    if (isWebPasswordEnabled(legacyPassword)) {
      throw new Error("PI_WEB_USERS_FILE and PI_WEB_PASSWORD cannot both be configured");
    }
    if (!isAbsolute(configuredUsersPath)) {
      throw new Error("PI_WEB_USERS_FILE must be an absolute path");
    }
    if (!existsSync(configuredUsersPath)) {
      throw new Error(`Pi Web users file does not exist: ${configuredUsersPath}`);
    }
    if (process.platform !== "win32" && (statSync(configuredUsersPath).mode & 0o077) !== 0) {
      throw new Error("Pi Web users file must not be accessible by group or other users (chmod 600)");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configuredUsersPath, "utf8"));
    } catch (error) {
      throw new Error(`Could not read Pi Web users file: ${error instanceof Error ? error.message : String(error)}`);
    }
    const data = parseWebUsersFile(parsed);
    if (!data) throw new Error("Pi Web users file has an invalid format");
    return {
      mode: selectionMode ? "selection" : "users",
      path: configuredUsersPath,
      data,
      usersById: new Map(data.users.map((user) => [user.id, user])),
    };
  }
  if (isWebPasswordEnabled(legacyPassword)) return { mode: "legacy", password: legacyPassword };
  return { mode: "none" };
}

export function isWebPasswordEnabled(
  password: string | undefined = process.env.PI_WEB_PASSWORD,
): password is string {
  return typeof password === "string" && password.length > 0;
}

export function isValidWebPassword(
  suppliedPassword: string,
  password = process.env.PI_WEB_PASSWORD,
): boolean {
  return isWebPasswordEnabled(password) && secretsEqual(suppliedPassword, password);
}

function parseBasicAuthorization(authorization: string | null): { username: string; password: string } | null {
  if (!authorization) return null;
  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return null;

  let credentials: string;
  try {
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return null;
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }

  const separator = credentials.indexOf(":");
  if (separator === -1) return null;
  return { username: credentials.slice(0, separator), password: credentials.slice(separator + 1) };
}

export function isValidBasicAuthorization(
  authorization: string | null,
  password = process.env.PI_WEB_PASSWORD,
): boolean {
  const credentials = parseBasicAuthorization(authorization);
  if (!isWebPasswordEnabled(password) || !credentials) return false;
  const usernameMatches = secretsEqual(credentials.username, PI_WEB_AUTH_USERNAME);
  const passwordMatches = isValidWebPassword(credentials.password, password);
  return usernameMatches && passwordMatches;
}

function sessionSignature(payload: string, secret: string | Buffer): string {
  return createHmac("sha256", secret).update(`pi-web-session:${payload}`, "utf8").digest("hex");
}

export function createWebSessionToken(
  password: string,
  now = Date.now(),
  nonce = randomBytes(16).toString("hex"),
): string {
  const payload = `v1.${Math.floor(now / 1000) + PI_WEB_SESSION_MAX_AGE}.${nonce}`;
  return `${payload}.${sessionSignature(payload, password)}`;
}

export function isValidWebSessionToken(
  token: string | undefined,
  password = process.env.PI_WEB_PASSWORD,
  now = Date.now(),
): boolean {
  if (!token || !isWebPasswordEnabled(password)) return false;

  const match = /^(v1\.(\d+)\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;

  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;
  return secretsEqual(match[3], sessionSignature(match[1], password));
}

function userTokenPayload(user: WebUserRecord, now: number, nonce: string): string {
  return Buffer.from(JSON.stringify({
    exp: Math.floor(now / 1000) + PI_WEB_SESSION_MAX_AGE,
    sub: user.id,
    cv: user.credentialVersion,
    nonce,
  }), "utf8").toString("base64url");
}

export function createUserWebSessionToken(
  user: WebUserRecord,
  sessionSecret: string,
  now = Date.now(),
  nonce = randomBytes(16).toString("hex"),
): string {
  const payload = `v2.${userTokenPayload(user, now, nonce)}`;
  return `${payload}.${sessionSignature(payload, Buffer.from(sessionSecret, "base64url"))}`;
}

function identityForUser(user: WebUserRecord, mode: "users" | "selection"): WebUserIdentity {
  return { id: user.id, username: user.username, displayName: user.displayName, mode };
}

function profileSelectionSignature(payload: string, secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(`pi-web-profile-selection:${payload}`, "utf8")
    .digest("hex");
}

export function createUserSelectionToken(
  user: Pick<WebUserRecord, "id">,
  sessionSecret: string,
  now = Date.now(),
  nonce = randomBytes(16).toString("hex"),
): string {
  const claims = Buffer.from(JSON.stringify({
    exp: Math.floor(now / 1000) + PI_WEB_PROFILE_MAX_AGE,
    sub: user.id,
    nonce,
  }), "utf8").toString("base64url");
  const payload = `p1.${claims}`;
  return `${payload}.${profileSelectionSignature(payload, sessionSecret)}`;
}

export function getUserSelectionIdentity(
  token: string | undefined,
  config: WebAuthConfig,
  now = Date.now(),
): WebUserIdentity | null {
  if (!token || config.mode !== "selection") return null;
  const match = /^(p1\.([A-Za-z0-9_-]+))\.([a-f0-9]{64})$/.exec(token);
  if (!match || Buffer.from(match[2], "base64url").toString("base64url") !== match[2]) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
  const record = claims as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.exp) || (record.exp as number) <= Math.floor(now / 1000)
    || typeof record.sub !== "string"
    || typeof record.nonce !== "string" || !/^[a-f0-9]{32}$/.test(record.nonce)
  ) return null;
  const user = config.usersById.get(record.sub);
  if (!user) return null;
  const expected = profileSelectionSignature(match[1], config.data.sessionSecret);
  return secretsEqual(match[3], expected) ? identityForUser(user, "selection") : null;
}

export function getWebSessionIdentity(
  token: string | undefined,
  config: WebAuthConfig,
  now = Date.now(),
): WebUserIdentity | null {
  if (!token) return null;
  if (config.mode === "legacy") {
    return isValidWebSessionToken(token, config.password, now)
      ? { id: "legacy", username: PI_WEB_AUTH_USERNAME, displayName: "Pi", mode: "legacy" }
      : null;
  }
  if (config.mode !== "users") return null;

  const match = /^(v2\.([A-Za-z0-9_-]+))\.([a-f0-9]{64})$/.exec(token);
  if (!match) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const claims = payload as Record<string, unknown>;
  if (
    !Number.isSafeInteger(claims.exp) || (claims.exp as number) <= Math.floor(now / 1000)
    || typeof claims.sub !== "string"
    || !Number.isSafeInteger(claims.cv)
    || typeof claims.nonce !== "string" || !/^[a-f0-9]{32}$/.test(claims.nonce)
  ) return null;
  const user = config.usersById.get(claims.sub);
  if (!user || user.credentialVersion !== claims.cv) return null;
  const expected = sessionSignature(match[1], Buffer.from(config.data.sessionSecret, "base64url"));
  return secretsEqual(match[3], expected) ? identityForUser(user, "users") : null;
}

function cookieValue(request: Request, cookieName: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const field of cookieHeader.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 0 || field.slice(0, separator).trim() !== cookieName) continue;
    return field.slice(separator + 1).trim();
  }
  return undefined;
}

/** Identity comes from a signed app session, selected-profile cookie, or legacy Basic credentials. */
export function getWebRequestIdentity(
  request: Request,
  config: WebAuthConfig = getWebAuthConfig(),
): WebUserIdentity | null {
  if (config.mode === "selection") {
    return getUserSelectionIdentity(cookieValue(request, PI_WEB_PROFILE_COOKIE), config);
  }
  const cookieIdentity = getWebSessionIdentity(cookieValue(request, PI_WEB_SESSION_COOKIE), config);
  if (cookieIdentity) return cookieIdentity;
  if (config.mode === "legacy" && isValidBasicAuthorization(request.headers.get("authorization"), config.password)) {
    return { id: "legacy", username: PI_WEB_AUTH_USERNAME, displayName: "Pi", mode: "legacy" };
  }
  return null;
}

export function createWebUserRecord(options: {
  id: string;
  username: string;
  displayName?: string;
  password: string;
  credentialVersion?: number;
  salt?: string;
}): WebUserRecord {
  const salt = options.salt ?? randomBytes(WEB_USER_PASSWORD_SALT_BYTES).toString("hex");
  return {
    id: options.id,
    username: options.username,
    displayName: options.displayName?.trim() || options.username,
    credentialVersion: options.credentialVersion ?? 1,
    salt,
    passwordHash: scryptSync(options.password, Buffer.from(salt, "hex"), WEB_USER_PASSWORD_HASH_BYTES).toString("hex"),
  };
}

export function verifyWebUserPassword(user: WebUserRecord | undefined, password: string): boolean {
  // Run the same work for unknown usernames so login responses do not reveal
  // which local accounts exist.
  const salt = user ? Buffer.from(user.salt, "hex") : Buffer.alloc(WEB_USER_PASSWORD_SALT_BYTES, 0x5a);
  const expected = user ? Buffer.from(user.passwordHash, "hex") : Buffer.alloc(WEB_USER_PASSWORD_HASH_BYTES, 0xa5);
  const actual = scryptSync(password, salt, WEB_USER_PASSWORD_HASH_BYTES);
  return timingSafeEqual(actual, expected) && Boolean(user);
}

export function findWebUserByUsername(config: WebAuthConfig, username: string): WebUserRecord | undefined {
  if (config.mode !== "users") return undefined;
  const normalized = username.toLocaleLowerCase("en-US");
  return config.data.users.find((user) => user.username.toLocaleLowerCase("en-US") === normalized);
}

export function createWebUsersFile(users: readonly WebUserRecord[], sessionSecret = randomBytes(32).toString("base64url")): WebUsersFile {
  const parsed = parseWebUsersFile({ version: 1, sessionSecret, users });
  if (!parsed) throw new Error("Cannot create invalid Pi Web users file");
  return parsed;
}
