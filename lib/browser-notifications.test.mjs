import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./browser-notifications.ts");
}

function createFakeTimers(startAt = 0) {
  let now = startAt;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delayMs) {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: now + delayMs });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advanceBy(deltaMs) {
      now += deltaMs;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
        if (!next || next[1].dueAt > now) return;
        timers.delete(next[0]);
        next[1].callback();
      }
    },
  };
}

test("coalesces local completion notices into one digest per cooldown", async () => {
  const { createBrowserCompletionNotificationQueue } = await loadSubject();
  const { NOTIFICATION_COOLDOWN_MS } = await import("./notification-policy.ts");
  const timers = createFakeTimers();
  const delivered = [];
  const queue = createBrowserCompletionNotificationQueue({
    shouldDeliver: () => true,
    deliver: (notice) => delivered.push(notice),
    makeDigest: (notices) => ({ digest: notices.map((notice) => notice.id) }),
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    cooldownMs: NOTIFICATION_COOLDOWN_MS,
  });

  queue.enqueue("session-a", { id: "session-a" });
  queue.enqueue("session-b", { id: "session-b" });
  queue.enqueue("session-b", { id: "session-b-updated" });
  queue.enqueue("session-c", { id: "session-c" });
  assert.deepEqual(delivered, [{ id: "session-a" }]);

  timers.advanceBy(NOTIFICATION_COOLDOWN_MS);
  assert.deepEqual(delivered, [
    { id: "session-a" },
    { digest: ["session-b-updated", "session-c"] },
  ]);
});

test("drops a pending local completion digest if the profile becomes engaged", async () => {
  const { createBrowserCompletionNotificationQueue } = await loadSubject();
  const { NOTIFICATION_COOLDOWN_MS } = await import("./notification-policy.ts");
  const timers = createFakeTimers();
  const delivered = [];
  let engaged = false;
  const queue = createBrowserCompletionNotificationQueue({
    shouldDeliver: () => !engaged,
    deliver: (notice) => delivered.push(notice),
    makeDigest: (notices) => ({ digest: notices.map((notice) => notice.id) }),
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    cooldownMs: NOTIFICATION_COOLDOWN_MS,
  });

  queue.enqueue("session-a", { id: "session-a" });
  queue.enqueue("session-b", { id: "session-b" });
  engaged = true;
  timers.advanceBy(NOTIFICATION_COOLDOWN_MS);
  engaged = false;
  queue.enqueue("session-c", { id: "session-c" });

  assert.deepEqual(delivered, [{ id: "session-a" }, { id: "session-c" }]);
});

test("uses a service worker notification when a registration is available", async () => {
  const { showBrowserNotification } = await loadSubject();
  const shown = [];
  let constructorCalled = false;

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/?session=session-1",
    tag: "session-complete:session-1",
    onClick: () => assert.fail("service worker owns the click handler"),
  }, {
    createWindowNotification: () => {
      constructorCalled = true;
      throw new Error("unexpected constructor call");
    },
    getServiceWorkerRegistration: async () => ({
      showNotification: async (title, options) => shown.push({ title, options }),
    }),
  });

  assert.equal(delivery, "service-worker");
  assert.equal(constructorCalled, false);
  assert.deepEqual(shown, [{
    title: "Session complete",
    options: {
      body: "Task finished.",
      tag: "session-complete:session-1",
      renotify: true,
      data: { url: "/?session=session-1" },
    },
  }]);
});

test("falls back to a page notification and wires its click handler", async () => {
  const { showBrowserNotification } = await loadSubject();
  let notificationOptions;
  let clicked = false;
  let closed = false;
  const notification = {
    onclick: null,
    close: () => { closed = true; },
  };

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/?session=session-1",
    onClick: () => { clicked = true; },
  }, {
    createWindowNotification: (title, options) => {
      notificationOptions = { title, options };
      return notification;
    },
    getServiceWorkerRegistration: async () => {
      throw new Error("service worker unavailable");
    },
  });

  assert.equal(delivery, "window");
  assert.deepEqual(notificationOptions, {
    title: "Session complete",
    options: { body: "Task finished." },
  });

  notification.onclick();
  assert.equal(closed, true);
  assert.equal(clicked, true);
});

test("silently skips notification when neither delivery mechanism works", async () => {
  const { showBrowserNotification } = await loadSubject();

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/",
    onClick: () => {},
  }, {
    createWindowNotification: () => {
      throw new TypeError("Illegal constructor");
    },
    getServiceWorkerRegistration: null,
  });

  assert.equal(delivery, null);
});

test("shows notifications when the page is hidden", async () => {
  const { shouldShowBrowserNotification } = await loadSubject();
  let focusChecked = false;

  assert.equal(shouldShowBrowserNotification({
    visibilityState: "hidden",
    hasFocus: () => {
      focusChecked = true;
      return true;
    },
  }), true);
  assert.equal(focusChecked, false);
});

test("shows notifications when the visible page is unfocused", async () => {
  const { shouldShowBrowserNotification } = await loadSubject();

  assert.equal(shouldShowBrowserNotification({
    visibilityState: "visible",
    hasFocus: () => false,
  }), true);
});

test("skips notifications only when the visible page is focused", async () => {
  const { shouldShowBrowserNotification } = await loadSubject();

  assert.equal(shouldShowBrowserNotification({
    visibilityState: "visible",
    hasFocus: () => true,
  }), false);
});

test("claims only blocking extension requests and deduplicates their ids", async () => {
  const { claimExtensionAttentionNotification } = await loadSubject();
  const notifiedIds = new Set();
  const confirmRequest = {
    type: "extension_ui_request",
    id: "confirm-1",
    method: "confirm",
    title: "Approve",
    message: "Continue?",
  };

  assert.equal(claimExtensionAttentionNotification(confirmRequest, notifiedIds), true);
  assert.equal(claimExtensionAttentionNotification(confirmRequest, notifiedIds), false);
  for (const request of [
    { type: "extension_ui_request", id: "select-1", method: "select", title: "Choose", options: ["A"] },
    { type: "extension_ui_request", id: "input-1", method: "input", title: "Enter value" },
    { type: "extension_ui_request", id: "editor-1", method: "editor", title: "Edit value" },
  ]) {
    assert.equal(claimExtensionAttentionNotification(request, notifiedIds), true);
  }
  assert.equal(claimExtensionAttentionNotification({
    type: "extension_ui_request",
    id: "notice-1",
    method: "notify",
    message: "Informational",
  }, notifiedIds), false);
  assert.equal(claimExtensionAttentionNotification({
    type: "extension_ui_request",
    id: "custom-closed",
    method: "custom",
    lines: [],
    closed: true,
  }, notifiedIds), false);
  assert.equal(claimExtensionAttentionNotification({
    type: "extension_ui_request",
    id: "custom-open",
    method: "custom",
    lines: ["Waiting for input"],
  }, notifiedIds), true);
  assert.deepEqual([...notifiedIds], ["confirm-1", "select-1", "input-1", "editor-1", "custom-open"]);
});
