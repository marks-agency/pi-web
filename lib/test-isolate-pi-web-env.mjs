/**
 * Import this first in a test file whose subject reads Pi Web's deployment
 * environment. The node test runner gives every file its own process, so
 * deleting the variables here affects only that file and lets the suite pass
 * in a shell that inherited a running service's settings (for example
 * PI_WEB_AUTH_MODE=selection or PI_WEB_IDLE_TIMEOUT_MS=0).
 */
export const PI_WEB_DEPLOYMENT_ENV_KEYS = Object.freeze([
  "PI_WEB_AUTH_MODE",
  "PI_WEB_USERS_FILE",
  "PI_WEB_PASSWORD",
  "PI_WEB_IDLE_TIMEOUT_MS",
]);

for (const key of PI_WEB_DEPLOYMENT_ENV_KEYS) delete process.env[key];
