"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_CODING_AGENT_PACKAGE_PARTS = PI_CODING_AGENT_PACKAGE.split("/");
const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

function resolvePiCodingAgentPackageRoot(packageDir) {
  let directory = path.resolve(packageDir);
  while (true) {
    const candidate = path.join(directory, "node_modules", ...PI_CODING_AGENT_PACKAGE_PARTS);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
      if (manifest.name === PI_CODING_AGENT_PACKAGE) return fs.realpathSync(candidate);
    } catch {
      // Keep walking; dependencies may be hoisted to an ancestor node_modules.
    }

    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function withSubagentPiPackageRoot(env, packageDir) {
  const nextEnv = { ...env };
  const configuredRoot = nextEnv[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
  if (typeof configuredRoot === "string" && configuredRoot.trim()) return nextEnv;

  const packageRoot = resolvePiCodingAgentPackageRoot(packageDir);
  if (packageRoot) nextEnv[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = packageRoot;
  return nextEnv;
}

module.exports = {
  PI_CODING_AGENT_PACKAGE_ROOT_ENV,
  resolvePiCodingAgentPackageRoot,
  withSubagentPiPackageRoot,
};
