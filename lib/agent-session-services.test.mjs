import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSessionFromServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createPiWebAgentSessionServices, withPiWebAgentSessionRuntime } = await jiti.import("./agent-session-services.ts");
const bridgeRegistrationKey = Symbol.for("claude-bridge:activeStreamSimple");

function bridgeModelCount(services) {
  return services.modelRuntime.getModels().filter((model) => model.provider === "claude-bridge").length;
}

function bridgeProvider(services) {
  return services.modelRuntime.getRegisteredProviderConfig("claude-bridge");
}

test("service creation isolates Bridge registration across fresh and shared runtimes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-web-bridge-services-"));
  const pluginPath = join(tempDir, "guarded-provider.ts");
  const originalBridgeRegistration = globalThis[bridgeRegistrationKey];
  const sessions = [];

  await writeFile(join(tempDir, "settings.json"), "{}\n");
  await writeFile(pluginPath, `
const key = Symbol.for("claude-bridge:activeStreamSimple");
const streamSimple = async () => { throw new Error("fixture stream must not be called"); };
const providerConfig = {
  baseUrl: "https://example.invalid/v1",
  apiKey: "fixture-key",
  api: "openai-completions",
  models: [{
    id: "fixture-model",
    name: "Fixture model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  }],
  streamSimple,
};
export default (pi) => {
  const globals = globalThis;
  if (!globals[key]) {
    globals[key] = streamSimple;
    pi.registerProvider("claude-bridge", providerConfig);
    return;
  }
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.modelRegistry.getProvider("claude-bridge")) {
      pi.registerProvider("claude-bridge", providerConfig);
    }
  });
};
`);

  async function createServices(name, modelRuntime) {
    const cwd = join(tempDir, name);
    await mkdir(cwd, { recursive: true });
    return createPiWebAgentSessionServices({
      cwd,
      agentDir: tempDir,
      ...(modelRuntime ? { modelRuntime } : {}),
      resourceLoaderOptions: {
        additionalExtensionPaths: [pluginPath],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
  }

  async function bindSession(services, name) {
    const cwd = join(tempDir, name);
    const sessionManager = SessionManager.create(cwd, join(tempDir, `sessions-${name}`));
    const { session } = await createAgentSessionFromServices({ services, sessionManager });
    sessions.push(session);
    await session.bindExtensions({ mode: "json" });
    return session;
  }

  try {
    const parent = await createServices("workspace-a");
    assert.equal(bridgeModelCount(parent), 1, "fresh runtime registers before session_start");
    assert.equal(globalThis[bridgeRegistrationKey], originalBridgeRegistration, "fresh registration restores the process marker");

    const [workspaceB, workspaceC] = await Promise.all([
      createServices("workspace-b"),
      createServices("workspace-c"),
    ]);
    assert.equal(bridgeModelCount(workspaceB), 1, "concurrent fresh runtime B registers before session_start");
    assert.equal(bridgeModelCount(workspaceC), 1, "concurrent fresh runtime C registers before session_start");

    const parentSession = await bindSession(parent, "workspace-a");
    const parentStream = bridgeProvider(parent)?.streamSimple;
    const subagent = await createServices("subagent-worktree", parent.modelRuntime);
    assert.strictEqual(subagent.modelRuntime, parent.modelRuntime, "subagent uses the parent's ModelRuntime");
    assert.strictEqual(bridgeProvider(parent)?.streamSimple, parentStream, "service creation does not replace the parent's handler");
    const subagentSession = await bindSession(subagent, "subagent-worktree");
    assert.strictEqual(bridgeProvider(parent)?.streamSimple, parentStream, "session_start preserves the parent's handler");
    assert.equal(bridgeModelCount(parent), 1);
    await withPiWebAgentSessionRuntime(true, () => subagentSession.reload());
    assert.strictEqual(bridgeProvider(parent)?.streamSimple, parentStream, "shared-runtime reload preserves the parent's handler");

    await withPiWebAgentSessionRuntime(false, () => parentSession.reload());
    assert.equal(bridgeModelCount(parent), 1, "owning-session reload keeps the Bridge model registered");
    assert.ok(bridgeProvider(parent)?.streamSimple, "reload leaves a stream handler registered");
  } finally {
    for (const session of sessions.reverse()) await session.shutdown?.();
    globalThis[bridgeRegistrationKey] = originalBridgeRegistration;
    await rm(tempDir, { recursive: true, force: true });
  }
});
