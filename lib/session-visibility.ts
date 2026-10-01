import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getWebAuthConfig, getWebRequestIdentity, type WebAuthConfig } from "./web-auth";

export const SESSION_VISIBILITY_FILE_NAME = "web-session-visibility.json";
export const SESSION_VISIBILITY_STATE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface SessionVisibilityState {
  version: 1;
  hiddenByProfile: Record<string, string[]>;
}

export interface SessionVisibilityStoreEnvironment {
  load: () => SessionVisibilityState | null;
  save: (state: SessionVisibilityState) => void;
}

export interface SessionVisibilityStore {
  getHiddenSessionIds: (profileId: string) => Set<string>;
  setHidden: (profileId: string, sessionIds: Iterable<string>, hidden: boolean) => void;
  deleteSessionIds: (sessionIds: Iterable<string>) => void;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function parseState(value: unknown): SessionVisibilityState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Session visibility index has an invalid format");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== SESSION_VISIBILITY_STATE_VERSION || typeof candidate.hiddenByProfile !== "object"
    || candidate.hiddenByProfile === null || Array.isArray(candidate.hiddenByProfile)) {
    throw new Error("Session visibility index has an unsupported version or format");
  }

  const hiddenByProfile: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [profileId, sessionIds] of Object.entries(candidate.hiddenByProfile)) {
    if (!validId(profileId) || !Array.isArray(sessionIds) || !sessionIds.every(validId)) {
      throw new Error("Session visibility index contains an invalid profile or session id");
    }
    hiddenByProfile[profileId] = [...new Set(sessionIds)];
  }
  return { version: SESSION_VISIBILITY_STATE_VERSION, hiddenByProfile };
}

export function createSessionVisibilityStore(environment: SessionVisibilityStoreEnvironment): SessionVisibilityStore {
  const loaded = environment.load();
  const state: SessionVisibilityState = loaded === null
    ? { version: SESSION_VISIBILITY_STATE_VERSION, hiddenByProfile: Object.create(null) as Record<string, string[]> }
    : parseState(loaded);

  const persist = () => environment.save({
    version: SESSION_VISIBILITY_STATE_VERSION,
    hiddenByProfile: Object.fromEntries(Object.entries(state.hiddenByProfile).map(([id, sessionIds]) => [id, [...sessionIds]])),
  });

  return {
    getHiddenSessionIds(profileId) {
      if (!validId(profileId)) throw new Error("Invalid profile id");
      return new Set(state.hiddenByProfile[profileId] ?? []);
    },
    setHidden(profileId, sessionIds, hidden) {
      if (!validId(profileId)) throw new Error("Invalid profile id");
      if (typeof hidden !== "boolean") throw new Error("Hidden state must be a boolean");
      const validSessionIds = [...new Set(sessionIds)];
      if (!validSessionIds.every(validId)) throw new Error("Invalid session id");
      const current = new Set(state.hiddenByProfile[profileId] ?? []);
      const before = current.size;
      for (const sessionId of validSessionIds) {
        if (hidden) current.add(sessionId);
        else current.delete(sessionId);
      }
      if (current.size === before && validSessionIds.every((id) => (state.hiddenByProfile[profileId] ?? []).includes(id) === hidden)) return;
      if (current.size === 0) delete state.hiddenByProfile[profileId];
      else state.hiddenByProfile[profileId] = [...current].sort();
      persist();
    },
    deleteSessionIds(sessionIds) {
      const deleted = new Set(sessionIds);
      if (![...deleted].every(validId)) throw new Error("Invalid session id");
      let changed = false;
      for (const [profileId, current] of Object.entries(state.hiddenByProfile)) {
        const remaining = current.filter((sessionId) => !deleted.has(sessionId));
        if (remaining.length === current.length) continue;
        changed = true;
        if (remaining.length === 0) delete state.hiddenByProfile[profileId];
        else state.hiddenByProfile[profileId] = remaining;
      }
      if (changed) persist();
    },
  };
}

function visibilityIndexPath(): string {
  return join(getAgentDir(), SESSION_VISIBILITY_FILE_NAME);
}

function loadVisibilityState(path: string): SessionVisibilityState | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read session visibility index: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseState(parsed);
}

function createFileBackedStore(path: string): SessionVisibilityStore {
  return createSessionVisibilityStore({
    load: () => loadVisibilityState(path),
    save(state) {
      mkdirSync(getAgentDir(), { recursive: true });
      writePrivateFileAtomicSync(path, JSON.stringify(state));
    },
  });
}

declare global {
  var __piWebSessionVisibilityStores: Map<string, SessionVisibilityStore> | undefined;
}

function getStore(): SessionVisibilityStore {
  const path = visibilityIndexPath();
  if (!globalThis.__piWebSessionVisibilityStores) globalThis.__piWebSessionVisibilityStores = new Map();
  let store = globalThis.__piWebSessionVisibilityStores.get(path);
  if (!store) {
    store = createFileBackedStore(path);
    globalThis.__piWebSessionVisibilityStores.set(path, store);
  }
  return store;
}

export function getSessionVisibilityProfileId(
  request: Request,
  config: WebAuthConfig = getWebAuthConfig(),
): string {
  const identity = getWebRequestIdentity(request, config);
  return identity?.id ?? (config.mode === "none" ? "local" : "legacy");
}

export function getHiddenSessionIds(profileId: string): Set<string> {
  return getStore().getHiddenSessionIds(profileId);
}

export function setSessionHidden(profileId: string, sessionIds: Iterable<string>, hidden: boolean): void {
  getStore().setHidden(profileId, sessionIds, hidden);
}

export function deleteSessionVisibility(sessionIds: Iterable<string>): void {
  getStore().deleteSessionIds(sessionIds);
}
