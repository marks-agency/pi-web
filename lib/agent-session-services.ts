import {
  createAgentSessionServices,
  type AgentSessionServices,
  type CreateAgentSessionServicesOptions,
} from "@earendil-works/pi-coding-agent";

const CLAUDE_BRIDGE_ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");
const DEFER_CLAUDE_BRIDGE_REGISTRATION = Object.freeze({ source: "pi-web-shared-model-runtime" });
const SERVICE_CREATION_LOCK_KEY = Symbol.for("pi-web:create-agent-session-services-lock");

type ServiceCreationLock = { tail: Promise<void> };

function getServiceCreationLock(): ServiceCreationLock {
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  let lock = globals[SERVICE_CREATION_LOCK_KEY] as ServiceCreationLock | undefined;
  if (!lock) {
    lock = { tail: Promise.resolve() };
    globals[SERVICE_CREATION_LOCK_KEY] = lock;
  }
  return lock;
}

async function withBridgeRegistrationContext<T>(
  sharedRuntime: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = getServiceCreationLock();
  const previous = lock.tail;
  let release!: () => void;
  lock.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const previousBridgeRegistration = globals[CLAUDE_BRIDGE_ACTIVE_STREAM_SIMPLE_KEY];
  globals[CLAUDE_BRIDGE_ACTIVE_STREAM_SIMPLE_KEY] = sharedRuntime
    ? DEFER_CLAUDE_BRIDGE_REGISTRATION
    : undefined;
  try {
    return await operation();
  } finally {
    globals[CLAUDE_BRIDGE_ACTIVE_STREAM_SIMPLE_KEY] = previousBridgeRegistration;
    release();
  }
}

/** Run extension reload using the registration mode for this session's runtime. */
export function withPiWebAgentSessionRuntime<T>(
  sharedRuntime: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  return withBridgeRegistrationContext(sharedRuntime, operation);
}

/**
 * Create Pi Web's services while selecting Bridge's registration path for the
 * registry these services will use. Bridge 0.9.x makes this decision from a
 * process-global symbol before it can inspect the target ModelRuntime.
 *
 * Fresh runtimes need an eager registration so model discovery works before a
 * session starts. Subagents pass their parent's ModelRuntime, so those loads
 * must defer until session_start, where Bridge will see the parent's provider
 * and avoid replacing its stream handler. The process-wide lock keeps other Pi
 * Web service constructions and extension reloads from observing the temporary
 * symbol value.
 */
export function createPiWebAgentSessionServices(
  options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
  return withBridgeRegistrationContext(
    options.modelRuntime !== undefined,
    () => createAgentSessionServices(options),
  );
}
