import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import webpush from "web-push";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { enLocale } from "./i18n/messages/en";
import { zhCNLocale } from "./i18n/messages/zh-CN";
import { zhTWLocale } from "./i18n/messages/zh-TW";
import { getAgentDir } from "./session-reader";
import { getSessionOwnerId as readSessionOwnerId } from "./session-owners";
import {
  NOTIFICATION_COOLDOWN_MS,
  NOTIFICATION_IDLE_MS,
  NOTIFICATION_PRESENCE_TTL_MS,
} from "./notification-policy";
import { getWebAuthConfig, getWebRequestIdentity } from "./web-auth";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale: string;
  userId?: string;
}

interface PushStateFile {
  vapidKeys: { publicKey: string; privateKey: string };
  subscriptions: PushSubscriptionRecord[];
}

export interface NotificationPresence {
  visible: boolean;
  focused: boolean;
  lastActivityAt: number;
}

interface PresenceRecord extends NotificationPresence {
  reportedAt: number;
}

interface CompletionQueue {
  lastSentAt: number | null;
  pendingSessionIds: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
}

interface WebPushEnvironment {
  send: (
    subscription: PushSubscriptionRecord,
    payload: string,
    vapidKeys: PushStateFile["vapidKeys"],
  ) => Promise<void>;
  loadState: () => PushStateFile | null;
  saveState: (state: PushStateFile) => void;
  generateVapidKeys: () => PushStateFile["vapidKeys"];
  listSessionNames: () => Promise<Map<string, string>>;
  getAuthMode?: () => "none" | "legacy" | "users" | "selection";
  getSessionOwnerId?: (sessionId: string) => string | undefined;
  getConfiguredUserIds?: () => readonly string[];
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface WebPushNotifier {
  getVapidPublicKey: () => string;
  addSubscription: (subscription: PushSubscriptionRecord) => void;
  removeSubscription: (endpoint: string, userId?: string) => void;
  reportPresence: (profileId: string, clientId: string, presence: NotificationPresence) => boolean;
  removePresence: (profileId: string, clientId: string) => void;
  notifySessionComplete: (sessionId: string) => Promise<void>;
}

function stateFilePath(): string {
  return join(getAgentDir(), "web-push.json");
}

/**
 * VAPID subject must be a valid `mailto:` or `https:` URL. Apple's push
 * service rejects requests whose subject is not a syntactically valid URL
 * (e.g. the previously used `mailto:pi-web@localhost`, which Apple answers
 * with 403 BadJwtToken), so default to the project homepage and let operators
 * override it via PI_WEB_PUSH_SUBJECT.
 */
export function vapidSubject(): string {
  const configured = process.env.PI_WEB_PUSH_SUBJECT?.trim();
  if (configured) return configured;
  return "https://github.com/agegr/pi-web";
}

// Ask the push service to deliver immediately. Lower urgencies let idle
// devices (especially iOS) defer delivery to an arbitrary later window.
export const PUSH_OPTIONS = { TTL: 2419200, urgency: "high" as const };
const MAX_PRESENCE_CLIENTS_PER_PROFILE = 32;
const GLOBAL_NOTIFICATION_PROFILE = "__global__";

function getDefaultEnvironment(): WebPushEnvironment {
  return {
    async send(subscription, payload, vapidKeys) {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        payload,
        {
          vapidDetails: {
            subject: vapidSubject(),
            publicKey: vapidKeys.publicKey,
            privateKey: vapidKeys.privateKey,
          },
          TTL: PUSH_OPTIONS.TTL,
          urgency: PUSH_OPTIONS.urgency,
        },
      );
    },
    loadState() {
      const path = stateFilePath();
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, "utf8")) as PushStateFile;
      } catch {
        return null;
      }
    },
    saveState(state) {
      const path = stateFilePath();
      mkdirSync(dirname(path), { recursive: true });
      writePrivateFileAtomicSync(path, JSON.stringify(state));
    },
    generateVapidKeys: () => webpush.generateVAPIDKeys(),
    async listSessionNames() {
      const names = new Map<string, string>();
      try {
        for (const session of await SessionManager.listAll()) {
          if (session.name) names.set(session.id, session.name);
        }
      } catch {
        // Session list is best-effort; fall back to the generic title.
      }
      return names;
    },
    getAuthMode() {
      return getWebAuthConfig().mode;
    },
    getSessionOwnerId(sessionId) {
      return readSessionOwnerId(sessionId);
    },
    getConfiguredUserIds() {
      const config = getWebAuthConfig();
      return config.mode === "users" || config.mode === "selection"
        ? config.data.users.map((user) => user.id)
        : [];
    },
  };
}

function pushStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

/**
 * Locale lookup for push payloads. The browser reports its UI locale when it
 * subscribes; unknown locales fall back to English.
 */
type PushTextKey = "sessionComplete" | "taskFinished" | "multipleSessionsComplete" | "reviewCompletedSessions";

const pushTextFallbacks: Record<PushTextKey, string> = {
  sessionComplete: "Session complete",
  taskFinished: "Task finished.",
  multipleSessionsComplete: "{count} sessions finished",
  reviewCompletedSessions: "Open Pi Web to review them.",
};

export function localeText(locale: string, key: PushTextKey, count = 1): string {
  const dictionaries: Record<string, Record<string, string>> = {
    en: enLocale.messages,
    "zh-CN": zhCNLocale.messages,
    "zh-TW": zhTWLocale.messages,
  };
  const message = dictionaries[locale]?.[`i18n.${key}`] ?? enLocale.messages[`i18n.${key}`] ?? pushTextFallbacks[key];
  return message.replaceAll("{count}", String(count));
}

export function createWebPushNotifier(environment: WebPushEnvironment): WebPushNotifier {
  const loaded = environment.loadState();
  const state: PushStateFile = {
    vapidKeys: loaded?.vapidKeys?.publicKey && loaded.vapidKeys.privateKey
      ? loaded.vapidKeys
      : { publicKey: "", privateKey: "" },
    subscriptions: loaded?.subscriptions ?? [],
  };
  const ensureVapidKeys = () => {
    if (!state.vapidKeys.publicKey || !state.vapidKeys.privateKey) {
      state.vapidKeys = environment.generateVapidKeys();
    }
  };
  const queues = new Map<string, CompletionQueue>();
  const presenceByProfile = new Map<string, Map<string, PresenceRecord>>();
  const saveState = () => {
    ensureVapidKeys();
    environment.saveState(state);
  };
  const now = () => environment.now?.() ?? Date.now();
  const scheduleTimer = environment.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelTimer = environment.clearTimeout ?? ((timer) => clearTimeout(timer));

  const getQueue = (profileId: string): CompletionQueue => {
    let queue = queues.get(profileId);
    if (!queue) {
      queue = { lastSentAt: null, pendingSessionIds: new Map(), timer: null };
      queues.set(profileId, queue);
    }
    return queue;
  };

  const prunePresence = (time: number) => {
    for (const [profileId, clients] of presenceByProfile) {
      for (const [clientId, record] of clients) {
        if (time - record.reportedAt > NOTIFICATION_PRESENCE_TTL_MS) clients.delete(clientId);
      }
      if (clients.size === 0) presenceByProfile.delete(profileId);
    }
  };

  const isProfileEngaged = (profileId: string, time = now()): boolean => {
    prunePresence(time);
    const clients = presenceByProfile.get(profileId);
    if (!clients) return false;
    return [...clients.values()].some((record) => (
      record.visible
      && record.focused
      && record.lastActivityAt <= time
      && time - record.lastActivityAt < NOTIFICATION_IDLE_MS
    ));
  };

  const clearPending = (profileId: string) => {
    const queue = queues.get(profileId);
    if (!queue) return;
    queue.pendingSessionIds.clear();
    if (queue.timer !== null) cancelTimer(queue.timer);
    queue.timer = null;
    if (queue.lastSentAt === null) queues.delete(profileId);
  };

  const recipientsFor = (profileId: string, authMode: ReturnType<NonNullable<WebPushEnvironment["getAuthMode"]>>): PushSubscriptionRecord[] => {
    if (authMode === "users" || authMode === "selection") {
      if (profileId === GLOBAL_NOTIFICATION_PROFILE) return [];
      const configuredUserIds = new Set(environment.getConfiguredUserIds?.() ?? []);
      if (!configuredUserIds.has(profileId)) return [];
      return state.subscriptions.filter((subscription) => subscription.userId === profileId);
    }
    return profileId === GLOBAL_NOTIFICATION_PROFILE ? state.subscriptions : [];
  };

  const deliver = async (profileId: string, sessionIds: string[]) => {
    const authMode = environment.getAuthMode?.() ?? "none";
    const currentSessionIds = authMode === "users" || authMode === "selection"
      ? sessionIds.filter((sessionId) => environment.getSessionOwnerId?.(sessionId) === profileId)
      : sessionIds;
    const recipients = recipientsFor(profileId, authMode);
    if (currentSessionIds.length === 0 || recipients.length === 0) return;

    ensureVapidKeys();
    let names = new Map<string, string>();
    try {
      names = await environment.listSessionNames();
    } catch {
      // Session names are best-effort; use localized generic text instead.
    }
    const singleSessionId = currentSessionIds.length === 1 ? currentSessionIds[0] : null;
    let pruned = false;
    for (const subscription of [...recipients]) {
      const locale = subscription.locale;
      const payload = singleSessionId
        ? {
            title: names.get(singleSessionId) ?? localeText(locale, "sessionComplete"),
            body: localeText(locale, "taskFinished"),
            url: `/?session=${encodeURIComponent(singleSessionId)}`,
            tag: `pi-session-complete:${singleSessionId}`,
          }
        : {
            title: localeText(locale, "multipleSessionsComplete", currentSessionIds.length),
            body: localeText(locale, "reviewCompletedSessions"),
            url: "/",
            tag: `pi-session-complete-digest:${profileId}`,
          };
      try {
        await environment.send(subscription, JSON.stringify(payload), state.vapidKeys);
      } catch (error) {
        const statusCode = pushStatusCode(error);
        if (statusCode === 404 || statusCode === 410) {
          state.subscriptions = state.subscriptions.filter((candidate) => candidate.endpoint !== subscription.endpoint);
          pruned = true;
        }
      }
    }
    if (pruned) saveState();
  };

  const scheduleFlush = (profileId: string) => {
    const queue = getQueue(profileId);
    if (queue.timer !== null || queue.lastSentAt === null || queue.pendingSessionIds.size === 0) return;
    const delay = Math.max(0, queue.lastSentAt + NOTIFICATION_COOLDOWN_MS - now());
    queue.timer = scheduleTimer(() => {
      queue.timer = null;
      void flushPending(profileId).catch((error) => {
        console.error("[pi-web] failed to send completion digest:", error instanceof Error ? error.message : error);
      });
    }, delay);
  };

  const flushPending = async (profileId: string) => {
    const queue = queues.get(profileId);
    if (!queue || queue.pendingSessionIds.size === 0) return;
    const time = now();
    if (isProfileEngaged(profileId, time)) {
      clearPending(profileId);
      return;
    }
    if (queue.lastSentAt !== null && time - queue.lastSentAt < NOTIFICATION_COOLDOWN_MS) {
      scheduleFlush(profileId);
      return;
    }
    const sessionIds = [...queue.pendingSessionIds.keys()];
    queue.pendingSessionIds.clear();
    queue.lastSentAt = time;
    await deliver(profileId, sessionIds);
  };

  return {
    getVapidPublicKey() {
      saveState();
      return state.vapidKeys.publicKey;
    },
    addSubscription(subscription) {
      state.subscriptions = [
        ...state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
        subscription,
      ];
      saveState();
    },
    removeSubscription(endpoint, userId) {
      const next = state.subscriptions.filter((subscription) => (
        subscription.endpoint !== endpoint
        || (userId !== undefined && subscription.userId !== undefined && subscription.userId !== userId)
      ));
      if (next.length !== state.subscriptions.length) {
        state.subscriptions = next;
        saveState();
      }
    },
    reportPresence(profileId, clientId, presence) {
      const time = now();
      prunePresence(time);
      let clients = presenceByProfile.get(profileId);
      if (!clients) {
        clients = new Map();
        presenceByProfile.set(profileId, clients);
      }
      if (!clients.has(clientId) && clients.size >= MAX_PRESENCE_CLIENTS_PER_PROFILE) {
        const oldestClientId = [...clients.entries()].sort((a, b) => a[1].reportedAt - b[1].reportedAt)[0]?.[0];
        if (oldestClientId) clients.delete(oldestClientId);
      }
      clients.set(clientId, { ...presence, reportedAt: time });
      const engaged = isProfileEngaged(profileId, time);
      if (engaged) clearPending(profileId);
      return engaged;
    },
    removePresence(profileId, clientId) {
      const clients = presenceByProfile.get(profileId);
      clients?.delete(clientId);
      if (clients?.size === 0) presenceByProfile.delete(profileId);
    },
    async notifySessionComplete(sessionId) {
      const authMode = environment.getAuthMode?.() ?? "none";
      let profileId = GLOBAL_NOTIFICATION_PROFILE;
      if (authMode === "users" || authMode === "selection") {
        profileId = environment.getSessionOwnerId?.(sessionId) ?? "";
        const configuredUserIds = new Set(environment.getConfiguredUserIds?.() ?? []);
        if (!profileId || !configuredUserIds.has(profileId)) return;
      }
      if (recipientsFor(profileId, authMode).length === 0) return;
      const time = now();
      if (isProfileEngaged(profileId, time)) {
        clearPending(profileId);
        return;
      }

      const queue = getQueue(profileId);
      if (queue.lastSentAt !== null && time - queue.lastSentAt < NOTIFICATION_COOLDOWN_MS) {
        queue.pendingSessionIds.set(sessionId, time);
        scheduleFlush(profileId);
        return;
      }
      const sessionIds = [...queue.pendingSessionIds.keys()];
      if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId);
      queue.pendingSessionIds.clear();
      if (queue.timer !== null) cancelTimer(queue.timer);
      queue.timer = null;
      queue.lastSentAt = time;
      await deliver(profileId, sessionIds);
    },
  };
}

declare global {
  var __piWebPushNotifier: Promise<WebPushNotifier> | undefined;
}

function getNotifier(): Promise<WebPushNotifier> {
  if (!globalThis.__piWebPushNotifier) {
    globalThis.__piWebPushNotifier = Promise.resolve().then(() => createWebPushNotifier(getDefaultEnvironment()));
  }
  return globalThis.__piWebPushNotifier;
}

export function getVapidPublicKey(): Promise<string> {
  return getNotifier().then((notifier) => notifier.getVapidPublicKey());
}

export function addSubscription(subscription: PushSubscriptionRecord): Promise<void> {
  return getNotifier().then((notifier) => notifier.addSubscription(subscription));
}

export function removeSubscription(endpoint: string, userId?: string): Promise<void> {
  return getNotifier().then((notifier) => notifier.removeSubscription(endpoint, userId));
}

export function getPushProfileId(request: Request): string | null {
  const config = getWebAuthConfig();
  const identity = getWebRequestIdentity(request, config);
  if ((config.mode === "users" || config.mode === "selection") && !identity) return null;
  return identity?.id ?? GLOBAL_NOTIFICATION_PROFILE;
}

export async function reportPushPresence(
  profileId: string,
  clientId: string,
  presence: NotificationPresence,
): Promise<boolean> {
  const notifier = await getNotifier();
  return notifier.reportPresence(profileId, clientId, presence);
}

export async function removePushPresence(profileId: string, clientId: string): Promise<void> {
  const notifier = await getNotifier();
  notifier.removePresence(profileId, clientId);
}

export async function notifySessionComplete(sessionId: string): Promise<void> {
  const notifier = await getNotifier();
  await notifier.notifySessionComplete(sessionId);
}
