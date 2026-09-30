import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  PI_CODING_AGENT_PACKAGE_ROOT_ENV,
  resolvePiCodingAgentPackageRoot,
  withSubagentPiPackageRoot,
} = require("../bin/subagent-host-package.js");

async function makeHostPackage(t, packageName = "@earendil-works/pi-coding-agent") {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-web-host-package-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const packageDir = join(tempDir, "app");
  const hostRoot = join(packageDir, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(join(hostRoot, "dist"), { recursive: true });
  await writeFile(join(hostRoot, "package.json"), JSON.stringify({
    name: packageName,
    main: "./dist/index.js",
  }));
  await writeFile(join(hostRoot, "dist", "index.js"), "module.exports = {};\n");
  return { packageDir, hostRoot };
}

test("discovers the host package root relative to Pi Web's install directory", async (t) => {
  const { packageDir, hostRoot } = await makeHostPackage(t);

  assert.equal(resolvePiCodingAgentPackageRoot(packageDir), hostRoot);
});

test("preserves an explicit Subagents package-root override", async (t) => {
  const { packageDir, hostRoot } = await makeHostPackage(t);
  const env = { [PI_CODING_AGENT_PACKAGE_ROOT_ENV]: "/explicit/pi-host" };

  const childEnv = withSubagentPiPackageRoot(env, packageDir);

  assert.equal(childEnv[PI_CODING_AGENT_PACKAGE_ROOT_ENV], "/explicit/pi-host");
  assert.notStrictEqual(childEnv, env);
  assert.equal(hostRoot === childEnv[PI_CODING_AGENT_PACKAGE_ROOT_ENV], false);
});

test("leaves the environment unchanged when Pi's host package is unavailable", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-web-no-host-package-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const env = { PI_WEB_HOSTNAME: "127.0.0.1" };

  assert.deepEqual(withSubagentPiPackageRoot(env, tempDir), env);
});
