import { randomUUID } from "node:crypto";

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
const RPC_VERSION = 1;
const REQUEST_TIMEOUT_MS = 5_000;

export type PiSubagentsRpcMethod = "ping" | "status" | "steer" | "stop";
export interface PiSubagentsRpcError extends Error {
  code?: string;
}
export type PiSubagentsRpcRequest = (
  method: PiSubagentsRpcMethod,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export interface PiSubagentsEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface BridgeEntry {
  request: PiSubagentsRpcRequest;
  dispose: () => void;
}

declare global {
  // Survives Next.js module reloads, like the RPC session registry.
  var __piWebSubagentsBridges: Map<string, BridgeEntry> | undefined;
}

function bridges(): Map<string, BridgeEntry> {
  globalThis.__piWebSubagentsBridges ??= new Map();
  return globalThis.__piWebSubagentsBridges;
}

export function createPiSubagentsRpcRequest(events: PiSubagentsEventBus): PiSubagentsRpcRequest {
  return (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const replyEvent = `${RPC_REPLY_EVENT_PREFIX}${requestId}`;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error("pi-subagents did not respond"));
    }, REQUEST_TIMEOUT_MS);
    const unsubscribe = events.on(replyEvent, (raw) => {
      if (settled || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const reply = raw as Record<string, unknown>;
      if (reply.requestId !== requestId || reply.version !== RPC_VERSION) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (reply.success === true) resolve(reply.data);
      else {
        const error = reply.error && typeof reply.error === "object"
          ? (reply.error as Record<string, unknown>).message
          : undefined;
        const rpcError = reply.error && typeof reply.error === "object"
          ? reply.error as Record<string, unknown>
          : {};
        const failure = new Error(typeof error === "string" ? error.slice(0, 500) : "pi-subagents RPC failed") as PiSubagentsRpcError;
        if (typeof rpcError.code === "string") failure.code = rpcError.code;
        reject(failure);
      }
    });
    events.emit(RPC_REQUEST_EVENT, {
      version: RPC_VERSION,
      requestId,
      method,
      params,
      source: { name: "pi-web", version: 1 },
    });
  });
}

export function registerPiSubagentsBridge(sessionId: string, request: PiSubagentsRpcRequest): () => void {
  const registry = bridges();
  registry.get(sessionId)?.dispose();
  let disposed = false;
  const entry: BridgeEntry = {
    request,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (registry.get(sessionId) === entry) registry.delete(sessionId);
    },
  };
  registry.set(sessionId, entry);
  return entry.dispose;
}

export function unregisterPiSubagentsBridge(sessionId: string): void {
  bridges().get(sessionId)?.dispose();
}

export function getPiSubagentsBridge(sessionId: string): PiSubagentsRpcRequest | undefined {
  return bridges().get(sessionId)?.request;
}
