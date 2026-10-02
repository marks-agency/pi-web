import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const [push, policy] = await Promise.all([
    jiti.import("./web-push.ts"),
    jiti.import("./notification-policy.ts"),
  ]);
  return { ...push, ...policy };
}

const {
  createWebPushNotifier,
  localeText,
  NOTIFICATION_COOLDOWN_MS,
  NOTIFICATION_IDLE_MS,
  NOTIFICATION_PRESENCE_TTL_MS,
} = await loadSubject();

function makeEnvironment({
  initialState = null,
  sessionNames = new Map([["session-1", "My session"]]),
  errorFor = () => null,
  authMode = "none",
  sessionOwnerId,
  configuredUserIds = [],
  now,
  setTimeout,
  clearTimeout,
} = {}) {
  let state = initialState;
  let saved = null;
  const sent = [];

  const env = {
    send: async (subscription, payload, vapidKeys) => {
      sent.push({ subscription, payload, vapidKeys });
      const error = errorFor(subscription);
      if (error) throw error;
    },
    loadState: () => state,
    saveState: (s) => { saved = s; },
    generateVapidKeys: () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    listSessionNames: async () => sessionNames,
    getAuthMode: () => authMode,
    getSessionOwnerId: (sessionId) => typeof sessionOwnerId === "function" ? sessionOwnerId(sessionId) : sessionOwnerId,
    getConfiguredUserIds: () => configuredUserIds,
    ...(now ? { now } : {}),
    ...(setTimeout ? { setTimeout } : {}),
    ...(clearTimeout ? { clearTimeout } : {}),
  };

  return {
    notifier: createWebPushNotifier(env),
    sent,
    getSaved: () => saved,
  };
}

const SUB_EN = {
  endpoint: "https://push.example.com/en",
  keys: { p256dh: "p256dh-en", auth: "auth-en" },
  locale: "en",
};
const SUB_ZH = {
  endpoint: "https://push.example.com/zh",
  keys: { p256dh: "p256dh-zh", auth: "auth-zh" },
  locale: "zh-CN",
};

test("generates and persists VAPID keys when no state exists", () => {
  const { notifier, getSaved } = makeEnvironment();

  assert.equal(notifier.getVapidPublicKey(), "pub-key");
  assert.deepEqual(getSaved(), {
    vapidKeys: { publicKey: "pub-key", privateKey: "priv-key" },
    subscriptions: [],
  });
});

test("reuses persisted VAPID keys", () => {
  const { notifier } = makeEnvironment({
    initialState: {
      vapidKeys: { publicKey: "persisted-pub", privateKey: "persisted-priv" },
      subscriptions: [],
    },
  });

  assert.equal(notifier.getVapidPublicKey(), "persisted-pub");
});

test("addSubscription upserts by endpoint and persists", () => {
  const { notifier, getSaved } = makeEnvironment();

  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);
  notifier.addSubscription({ ...SUB_EN, locale: "zh-CN" });

  const saved = getSaved();
  assert.equal(saved.subscriptions.length, 2);
  const updated = saved.subscriptions.find((s) => s.endpoint === SUB_EN.endpoint);
  assert.equal(updated.locale, "zh-CN");
});

test("addSubscription persists even after getVapidPublicKey already saved", () => {
  const { notifier, getSaved } = makeEnvironment();

  notifier.getVapidPublicKey(); // first save
  notifier.addSubscription(SUB_EN);

  assert.equal(getSaved().subscriptions.length, 1);
});

test("re-registering an endpoint transfers it to the currently signed-in user", () => {
  const { notifier, getSaved } = makeEnvironment();
  notifier.addSubscription({ ...SUB_EN, userId: "alice" });
  notifier.addSubscription({ ...SUB_EN, locale: "zh-CN", userId: "bob" });

  assert.deepEqual(getSaved().subscriptions, [{ ...SUB_EN, locale: "zh-CN", userId: "bob" }]);
});

test("user mode sends completion only to the current owner’s subscriptions", async () => {
  const { notifier, sent } = makeEnvironment({
    authMode: "users",
    sessionOwnerId: "alice",
    configuredUserIds: ["alice", "bob"],
  });
  notifier.addSubscription({ ...SUB_EN, userId: "alice" });
  notifier.addSubscription({ ...SUB_ZH, userId: "bob" });

  await notifier.notifySessionComplete("session-1");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].subscription.userId, "alice");
});

test("selection mode routes completion only to the selected profile owner", async () => {
  const { notifier, sent } = makeEnvironment({
    authMode: "selection",
    sessionOwnerId: "alice",
    configuredUserIds: ["alice", "bob"],
  });
  notifier.addSubscription({ ...SUB_EN, userId: "alice" });
  notifier.addSubscription({ ...SUB_ZH, userId: "bob" });

  await notifier.notifySessionComplete("session-1");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].subscription.userId, "alice");
});

test("legacy mode preserves delivery to older unassigned subscription records", async () => {
  const { notifier, sent } = makeEnvironment({
    authMode: "legacy",
    initialState: { vapidKeys: { publicKey: "pub", privateKey: "priv" }, subscriptions: [SUB_EN] },
  });

  await notifier.notifySessionComplete("session-1");

  assert.equal(sent.length, 1);
});

test("user mode sends no completion for unassigned or removed owners", async () => {
  const unassigned = makeEnvironment({ authMode: "users", configuredUserIds: ["alice"] });
  unassigned.notifier.addSubscription({ ...SUB_EN, userId: "alice" });
  await unassigned.notifier.notifySessionComplete("session-1");
  assert.equal(unassigned.sent.length, 0);

  const removed = makeEnvironment({ authMode: "users", sessionOwnerId: "former-user", configuredUserIds: ["alice"] });
  removed.notifier.addSubscription({ ...SUB_EN, userId: "former-user" });
  await removed.notifier.notifySessionComplete("session-1");
  assert.equal(removed.sent.length, 0);
});

test("active profile presence suppresses routine completion pushes until five minutes of inactivity", async () => {
  let clock = 100_000;
  const { notifier, sent } = makeEnvironment({
    authMode: "users",
    sessionOwnerId: "alice",
    configuredUserIds: ["alice"],
    now: () => clock,
  });
  notifier.addSubscription({ ...SUB_EN, userId: "alice" });
  const report = () => notifier.reportPresence("alice", "tab-1234567890", {
    visible: true,
    focused: true,
    lastActivityAt: 100_000,
  });

  report();
  await notifier.notifySessionComplete("session-1");
  assert.equal(sent.length, 0);

  clock += NOTIFICATION_IDLE_MS - 1_000;
  report(); // Heartbeat keeps the tab present, but does not claim newer user activity.
  await notifier.notifySessionComplete("session-2");
  assert.equal(sent.length, 0);

  clock += 1_001;
  report();
  await notifier.notifySessionComplete("session-3");
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].payload).url, "/?session=session-3");
});

test("presence and cooldown state are isolated per profile", async () => {
  let clock = 100_000;
  const { notifier, sent } = makeEnvironment({
    authMode: "users",
    sessionOwnerId: (sessionId) => sessionId.startsWith("alice") ? "alice" : "bob",
    configuredUserIds: ["alice", "bob"],
    now: () => clock,
  });
  notifier.addSubscription({ ...SUB_EN, userId: "alice" });
  notifier.addSubscription({ ...SUB_ZH, userId: "bob" });
  notifier.reportPresence("alice", "tab-1234567890", {
    visible: true,
    focused: true,
    lastActivityAt: clock,
  });

  await notifier.notifySessionComplete("alice-session-1");
  await notifier.notifySessionComplete("bob-session-1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subscription.userId, "bob");

  clock += NOTIFICATION_PRESENCE_TTL_MS + 1;
  await notifier.notifySessionComplete("alice-session-2");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].subscription.userId, "alice");
});

test("coalesces completions into at most one per-profile digest per five-minute window", async () => {
  let clock = 100_000;
  let nextTimer = 0;
  const timers = new Map();
  const { notifier, sent } = makeEnvironment({
    authMode: "users",
    sessionOwnerId: "alice",
    configuredUserIds: ["alice"],
    now: () => clock,
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, due: clock + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  notifier.addSubscription({ ...SUB_EN, userId: "alice" });

  await notifier.notifySessionComplete("session-1");
  clock += 60_000;
  await notifier.notifySessionComplete("session-2");
  await notifier.notifySessionComplete("session-2");
  await notifier.notifySessionComplete("session-3");
  assert.equal(sent.length, 1);
  assert.equal(timers.size, 1);

  const [timerId, timer] = timers.entries().next().value;
  timers.delete(timerId);
  clock = timer.due;
  timer.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 2);
  const digest = JSON.parse(sent[1].payload);
  assert.equal(digest.title, "2 sessions finished");
  assert.equal(digest.body, "Open Pi Web to review them.");
  assert.equal(digest.url, "/");
  assert.equal(digest.tag, "pi-session-complete-digest:alice");
});

test("drops a pending digest when the profile becomes engaged again", async () => {
  let clock = 100_000;
  const timers = new Map();
  let nextTimer = 0;
  const { notifier, sent } = makeEnvironment({
    authMode: "users",
    sessionOwnerId: "alice",
    configuredUserIds: ["alice"],
    now: () => clock,
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, due: clock + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  notifier.addSubscription({ ...SUB_EN, userId: "alice" });
  await notifier.notifySessionComplete("session-1");
  clock += 1_000;
  await notifier.notifySessionComplete("session-2");
  assert.equal(timers.size, 1);

  notifier.reportPresence("alice", "tab-1234567890", {
    visible: true,
    focused: true,
    lastActivityAt: clock,
  });
  assert.equal(timers.size, 0);
  clock += NOTIFICATION_COOLDOWN_MS;
  assert.equal(sent.length, 1);
});

test("logout removes only the requesting user’s endpoint", () => {
  const { notifier, getSaved } = makeEnvironment();
  notifier.addSubscription({ ...SUB_EN, userId: "alice" });
  notifier.removeSubscription(SUB_EN.endpoint, "bob");
  assert.equal(getSaved().subscriptions.length, 1);
  notifier.removeSubscription(SUB_EN.endpoint, "alice");
  assert.equal(getSaved().subscriptions.length, 0);
});

test("notifySessionComplete sends localized payloads with the session name", async () => {
  const { notifier, sent } = makeEnvironment();
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("session-1");

  assert.equal(sent.length, 2);
  const en = sent.find((s) => s.subscription.endpoint === SUB_EN.endpoint);
  const zh = sent.find((s) => s.subscription.endpoint === SUB_ZH.endpoint);
  assert.deepEqual(JSON.parse(en.payload), {
    title: "My session",
    body: "Task finished.",
    url: "/?session=session-1",
    tag: "pi-session-complete:session-1",
  });
  assert.deepEqual(JSON.parse(zh.payload), {
    title: "My session",
    body: "任务已完成。",
    url: "/?session=session-1",
    tag: "pi-session-complete:session-1",
  });
});

test("notifySessionComplete falls back to the localized generic title", async () => {
  const { notifier, sent } = makeEnvironment({ sessionNames: new Map() });
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("unknown-session");

  assert.deepEqual(JSON.parse(sent[0].payload), {
    title: "任务完成",
    body: "任务已完成。",
    url: "/?session=unknown-session",
    tag: "pi-session-complete:unknown-session",
  });
});

test("notifySessionComplete prunes subscriptions dropped by the push service", async () => {
  const { notifier, sent, getSaved } = makeEnvironment({
    errorFor: (subscription) => subscription.endpoint === SUB_ZH.endpoint ? { statusCode: 410 } : null,
  });
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("session-1");

  assert.equal(sent.length, 2);
  const saved = getSaved();
  assert.deepEqual(saved.subscriptions.map((s) => s.endpoint), [SUB_EN.endpoint]);
});

test("localeText falls back to English for unknown locales", () => {
  assert.equal(localeText("zh-CN", "taskFinished"), "任务已完成。");
  assert.equal(localeText("ja", "taskFinished"), "Task finished.");
  assert.equal(localeText("en", "sessionComplete"), "Session complete");
});

test("push requests immediate delivery with a long TTL", async () => {
  const { PUSH_OPTIONS } = await loadSubject();

  // iOS may defer non-high-urgency pushes to an arbitrary later window.
  assert.equal(PUSH_OPTIONS.urgency, "high");
  assert.equal(PUSH_OPTIONS.TTL, 2419200);
});

test("vapidSubject defaults to a valid https URL, not mailto:localhost", async () => {
  const { vapidSubject } = await loadSubject();
  const subject = vapidSubject();
  assert.doesNotMatch(subject, /@localhost$/);
  assert.ok(subject.startsWith("https://") || subject.startsWith("mailto:"), subject);
});
