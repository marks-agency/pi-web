# Team fork additions

This fork (`marks-agency/pi-web`, branch `pre-deploy/mark-pi-web`) adds a small team layer on top of upstream. Everything here is attribution and routing, never an access boundary: every visitor who passes the deployment's external gate can read, continue, edit, and delete every session, and all of them share the host account.

## Auth modes (`lib/web-auth.ts`, `proxy.ts`, `app/api/web-auth/route.ts`)
- `getWebAuthConfig()` returns one of `none`, `legacy` (`PI_WEB_PASSWORD`), `users` (`PI_WEB_USERS_FILE`), or `selection` (`PI_WEB_AUTH_MODE=selection` plus the users file). The users file is read fresh on every call and fails closed: missing, group-readable, malformed, or combined with `PI_WEB_PASSWORD` is a 503, never open access.
- `users` mode issues `v2.` HMAC session cookies bound to the user id and `credentialVersion`; `pi-web-user password` bumps the version and so logs that user out everywhere. `selection` mode issues a `p1.` profile cookie signed with the same secret, which identifies but does not authenticate: the proxy requires it on every API call, and `/api/web-auth` lists the profiles to anyone. Both modes ignore forwarded `Authorization: Basic` headers.
- `bin/pi-web-user.js` is a dependency-free CommonJS copy of the users-file validation so it works without a build. Keep its patterns in step with `lib/web-auth.ts` (`USERNAME_PATTERN`, `ID_PATTERN`, salt and hash lengths, scrypt parameters).

## Ownership and visibility (`lib/session-owners.ts`, `lib/session-visibility.ts`)
- Owners live in `~/.pi/agent/web-session-owners.json`, keyed by session id. New, fork, fork_branch, clone, and tool-recreate paths in `lib/rpc-manager.ts` write the acting identity; subagents inherit their parent's owner at read time (`resolveSessionOwnerInfo`). `attachSessionOwnerInfo` is applied to persisted and live session lists with one shared config per list, not one read per session.
- Hidden sessions live in `web-session-visibility.json` per profile id (`local` in `none` mode, `legacy` in legacy mode). Hiding applies to a whole session family. `/api/sessions` returns `hiddenSessionIds` for the caller's profile and `/api/sessions/search?hidden=1` searches only hidden ones. Deleting a session removes it from both indexes.

## Push, presence and coalescing (`lib/web-push.ts`, `app/api/push/presence/route.ts`, `lib/browser-notifications.ts`)
- A subscription's `userId` is always the server-side identity of the request that registered it. In `users` and `selection` modes a completion push goes only to the owner's subscriptions; unowned sessions notify nobody. `none` and `legacy` keep the upstream broadcast.
- Presence is in-memory per profile: a client is engaged when visible, focused, and active within `NOTIFICATION_IDLE_MS`. An engaged profile receives no push and its queued completions are dropped. Otherwise completions within `NOTIFICATION_COOLDOWN_MS` of the last push coalesce into one digest. The browser mirrors the same policy for in-page notifications through `createBrowserCompletionNotificationQueue`, and skips them entirely when a push subscription is ready, so one completion never produces two alerts.

## pi-subagents bridge (`lib/pi-subagents-web-bridge.ts`, `app/api/subagents/extension/route.ts`, `components/PiSubagentsRuns.tsx`)
- The host extension registers a per-session RPC request function on `session_start` that speaks pi-subagents' `subagents:rpc:v1:request` / `reply` events (protocol version 1). The route calls `ping` to learn the method list, `status` for the async snapshot, `status` with `view: "transcript"` for one run, and `steer` / `stop` for controls. Everything returned to the browser is re-validated and bounded (`MAX_RUNS`, `MAX_CHILDREN`, label and transcript lengths, control characters stripped).
- An absent bridge or a `ping` failure renders as "unavailable", never as an error. Verified against pi-subagents 0.74.0.

## claude-bridge registration shim (`lib/agent-session-services.ts`)
- pi-claude-bridge 0.9.x decides how to register its stream handler from `Symbol.for("claude-bridge:activeStreamSimple")` on `globalThis` before it can see the session's `ModelRuntime`. `createPiWebAgentSessionServices` sets that symbol under a process-wide lock while services are created or reloaded: eager for fresh runtimes, deferred for subagents that share the parent's runtime. Every `createAgentSessionServices` call in this fork goes through it, including upstream's built-in extensions path.
- **Before upgrading pi-claude-bridge**, confirm the new version still reads that symbol with the same meaning (grep its dist for `activeStreamSimple`). If it does not, the shim becomes a no-op at best and the fix belongs in the bridge, not here. Verified with pi-claude-bridge 0.9.1 and pi 1.0.0.

## Deployment
- Production runs from a global npm prefix (`~/.local/share/pi-web-agegr`) as the user unit `pi-web-agegr.service`, in `selection` mode behind an external gate. Build and pack from the repo, install the tarball into a fresh staging prefix, back up the current install, swap, restart. The pi-web session doing the deploy may itself be served by that unit, so run the restart from a shell outside it.
- Tests must pass both in a clean shell and in one that inherited the unit's environment; `lib/test-isolate-pi-web-env.mjs` is imported first by the tests that read those variables.
