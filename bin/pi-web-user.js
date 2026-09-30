#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { randomBytes, randomUUID, scryptSync } = require("crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
const {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} = fs;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { basename, dirname, isAbsolute, join } = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stdin, stdout } = require("process");

const HASH_BYTES = 32;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX_32_PATTERN = /^[a-f0-9]{32}$/;
const HEX_64_PATTERN = /^[a-f0-9]{64}$/;

function usage() {
  console.log(`Usage:
  pi-web-user add <username> [--name <display name>] [--file <absolute path>]
  pi-web-user password <username> [--file <absolute path>]
  pi-web-user remove <username> [--file <absolute path>]

PI_WEB_USERS_FILE is used when --file is omitted. The first add creates a
private users file and its signing secret. User ids are immutable; usernames
are case-insensitive.`);
}

function parseArgs(args) {
  const positional = [];
  let displayName;
  let file;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      positional.push(arg);
    } else if (arg === "--name" || arg === "--file") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--name") displayName = value;
      else file = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, displayName, file: file ?? process.env.PI_WEB_USERS_FILE };
}

function readHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return Promise.reject(new Error("Password entry requires an interactive terminal"));
  }
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          cleanup();
          stdout.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function passwordPrompt() {
  const first = await readHidden("Password (12+ characters): ");
  if (first.length < 12) throw new Error("Password must be at least 12 characters");
  const second = await readHidden("Confirm password: ");
  if (first !== second) throw new Error("Passwords do not match");
  return first;
}

function createEmptyFile() {
  return {
    version: 1,
    sessionSecret: randomBytes(32).toString("base64url"),
    users: [],
  };
}

function validateFile(value, allowEmpty = false) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value.version !== 1) {
    throw new Error("Users file has an unsupported format or version");
  }
  if (typeof value.sessionSecret !== "string") throw new Error("Users file has no session signing secret");
  const secret = Buffer.from(value.sessionSecret, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== value.sessionSecret) {
    throw new Error("Users file has an invalid session signing secret");
  }
  if (!Array.isArray(value.users) || (!allowEmpty && value.users.length === 0)) {
    throw new Error("Users file has no accounts");
  }
  const ids = new Set();
  const usernames = new Set();
  for (const user of value.users) {
    if (
      typeof user?.id !== "string" || !ID_PATTERN.test(user.id)
      || typeof user.username !== "string" || !USERNAME_PATTERN.test(user.username)
      || typeof user.displayName !== "string" || !user.displayName.trim() || user.displayName.length > 80
      || !Number.isSafeInteger(user.credentialVersion) || user.credentialVersion < 1
      || typeof user.salt !== "string" || !HEX_32_PATTERN.test(user.salt)
      || typeof user.passwordHash !== "string" || !HEX_64_PATTERN.test(user.passwordHash)
    ) throw new Error("Users file contains an invalid account record");
    const username = user.username.toLowerCase();
    if (ids.has(user.id) || usernames.has(username)) throw new Error("Users file has duplicate ids or usernames");
    ids.add(user.id);
    usernames.add(username);
  }
  return value;
}

function readUsersFile(path, allowEmpty = false) {
  if (!existsSync(path)) return createEmptyFile();
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateFile(data, allowEmpty);
}

function saveUsersFile(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function hashPassword(password, salt) {
  return scryptSync(password, Buffer.from(salt, "hex"), HASH_BYTES).toString("hex");
}

async function main() {
  const { positional, displayName, file } = parseArgs(process.argv.slice(2));
  if (positional[0] === "--help" || positional[0] === "-h" || positional.length === 0) {
    usage();
    return;
  }
  const [action, username] = positional;
  if (!new Set(["add", "password", "remove"]).has(action) || !username || positional.length !== 2) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (!USERNAME_PATTERN.test(username)) throw new Error("Username must be 1-64 letters, digits, dots, underscores, or hyphens");
  if (!file || !isAbsolute(file)) throw new Error("Set PI_WEB_USERS_FILE or pass --file with an absolute path");
  const data = readUsersFile(file, action === "add");
  const index = data.users.findIndex((user) => user.username.toLowerCase() === username.toLowerCase());

  if (action === "add") {
    if (index >= 0) throw new Error(`User already exists: ${username}`);
    const password = await passwordPrompt();
    const salt = randomBytes(16).toString("hex");
    data.users.push({
      id: randomUUID(),
      username,
      displayName: displayName?.trim() || username,
      credentialVersion: 1,
      salt,
      passwordHash: hashPassword(password, salt),
    });
  } else if (action === "password") {
    if (index < 0) throw new Error(`Unknown user: ${username}`);
    const password = await passwordPrompt();
    const user = data.users[index];
    const salt = randomBytes(16).toString("hex");
    data.users[index] = {
      ...user,
      credentialVersion: user.credentialVersion + 1,
      salt,
      passwordHash: hashPassword(password, salt),
    };
  } else {
    if (index < 0) throw new Error(`Unknown user: ${username}`);
    if (data.users.length === 1) throw new Error("Cannot remove the last Pi Web user");
    data.users.splice(index, 1);
  }

  validateFile(data);
  saveUsersFile(file, data);
  console.log(`${action === "add" ? "Added" : action === "remove" ? "Removed" : "Updated password for"} Pi Web user ${username}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
