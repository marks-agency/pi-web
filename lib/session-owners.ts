import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getWebAuthConfig, type WebAuthConfig } from "./web-auth";
import type { SessionInfo } from "./types";

export const SESSION_OWNER_FILE_NAME = "web-session-owners.json";
export const SESSION_OWNER_STATE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface SessionOwnerState {
  version: 1;
  owners: Record<string, string>;
}

export interface SessionOwnerStoreEnvironment {
  load: () => SessionOwnerState | null;
  save: (state: SessionOwnerState) => void;
}

export interface SessionOwnerStore {
  getOwnerId: (sessionId: string, inheritedOwnerId?: string) => string | undefined;
  setOwnerId: (sessionId: string, ownerId: string | null) => void;
  deleteSessionIds: (sessionIds: Iterable<string>) => void;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function parseState(value: unknown): SessionOwnerState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Session owner index has an invalid format");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== SESSION_OWNER_STATE_VERSION || typeof candidate.owners !== "object"
    || candidate.owners === null || Array.isArray(candidate.owners)) {
    throw new Error("Session owner index has an unsupported version or format");
  }
  const owners: Record<string, string> = {};
  for (const [sessionId, ownerId] of Object.entries(candidate.owners)) {
    if (!validSessionId(sessionId) || !validSessionId(ownerId)) {
      throw new Error("Session owner index contains an invalid session or user id");
    }
    owners[sessionId] = ownerId;
  }
  return { version: SESSION_OWNER_STATE_VERSION, owners };
}

export function createSessionOwnerStore(environment: SessionOwnerStoreEnvironment): SessionOwnerStore {
  const loaded = environment.load();
  const state: SessionOwnerState = loaded === null
    ? { version: SESSION_OWNER_STATE_VERSION, owners: {} }
    : parseState(loaded);

  const persist = () => environment.save({ version: SESSION_OWNER_STATE_VERSION, owners: { ...state.owners } });
  return {
    getOwnerId(sessionId, inheritedOwnerId) {
      return state.owners[sessionId] ?? inheritedOwnerId;
    },
    setOwnerId(sessionId, ownerId) {
      if (!validSessionId(sessionId)) throw new Error("Invalid session id");
      if (ownerId !== null && !validSessionId(ownerId)) throw new Error("Invalid owner id");
      if (ownerId === null) delete state.owners[sessionId];
      else state.owners[sessionId] = ownerId;
      persist();
    },
    deleteSessionIds(sessionIds) {
      let changed = false;
      for (const sessionId of sessionIds) {
        if (Object.hasOwn(state.owners, sessionId)) {
          delete state.owners[sessionId];
          changed = true;
        }
      }
      if (changed) persist();
    },
  };
}

function ownerIndexPath(): string {
  return join(getAgentDir(), SESSION_OWNER_FILE_NAME);
}

function loadOwnerState(path: string): SessionOwnerState | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read session owner index: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseState(parsed);
}

function createFileBackedStore(path: string): SessionOwnerStore {
  return createSessionOwnerStore({
    load: () => loadOwnerState(path),
    save(state) {
      mkdirSync(getAgentDir(), { recursive: true });
      writePrivateFileAtomicSync(path, JSON.stringify(state));
    },
  });
}

declare global {
  var __piWebSessionOwnerStores: Map<string, SessionOwnerStore> | undefined;
}

function getStore(): SessionOwnerStore {
  const path = ownerIndexPath();
  if (!globalThis.__piWebSessionOwnerStores) globalThis.__piWebSessionOwnerStores = new Map();
  let store = globalThis.__piWebSessionOwnerStores.get(path);
  if (!store) {
    store = createFileBackedStore(path);
    globalThis.__piWebSessionOwnerStores.set(path, store);
  }
  return store;
}

export function getSessionOwnerId(sessionId: string, inheritedOwnerId?: string): string | undefined {
  return getStore().getOwnerId(sessionId, inheritedOwnerId);
}

export function setSessionOwnerId(sessionId: string, ownerId: string | null): void {
  getStore().setOwnerId(sessionId, ownerId);
}

export function deleteSessionOwners(sessionIds: Iterable<string>): void {
  getStore().deleteSessionIds(sessionIds);
}

export function resolveSessionOwnerInfo(
  session: Pick<SessionInfo, "id" | "relation">,
  config: WebAuthConfig = getWebAuthConfig(),
): Pick<SessionInfo, "ownerId" | "ownerName"> {
  const inheritedOwnerId = session.relation?.kind === "subagent"
    ? getSessionOwnerId(session.relation.parentSessionId)
    : undefined;
  const ownerId = getSessionOwnerId(session.id, inheritedOwnerId);
  if (!ownerId) return {};

  if (config.mode === "users" || config.mode === "selection") {
    const user = config.usersById.get(ownerId);
    return { ownerId, ownerName: user?.displayName ?? "Former team member" };
  }
  return { ownerId, ownerName: ownerId === "legacy" ? "Pi" : "Former team member" };
}

export function attachSessionOwnerInfo<T extends Pick<SessionInfo, "id" | "relation">>(
  session: T,
  config: WebAuthConfig = getWebAuthConfig(),
): T & Pick<SessionInfo, "ownerId" | "ownerName"> {
  return { ...session, ...resolveSessionOwnerInfo(session, config) };
}
