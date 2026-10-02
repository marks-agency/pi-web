import type { BlockingExtensionUiRequest, ExtensionUiRequest } from "./types";

interface WindowNotificationLike {
  onclick: Notification["onclick"];
  close: () => void;
}

interface ServiceWorkerRegistrationLike {
  showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
}

export interface BrowserNotificationEnvironment {
  createWindowNotification: (title: string, options?: NotificationOptions) => WindowNotificationLike;
  getServiceWorkerRegistration: (() => Promise<ServiceWorkerRegistrationLike | undefined>) | null;
}

export interface BrowserNotificationOptions {
  title: string;
  body: string;
  sessionUrl: string;
  onClick: () => void;
  tag?: string;
}

export type NotificationDelivery = "service-worker" | "window" | null;

export interface BrowserCompletionNotificationQueue<T> {
  enqueue: (key: string, notification: T) => void;
  clear: () => void;
}

export interface BrowserCompletionNotificationQueueEnvironment<T> {
  shouldDeliver: () => boolean;
  deliver: (notification: T) => void;
  makeDigest: (notifications: readonly T[]) => T;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  cooldownMs: number;
}

export function createBrowserCompletionNotificationQueue<T>(
  environment: BrowserCompletionNotificationQueueEnvironment<T>,
): BrowserCompletionNotificationQueue<T> {
  const pending = new Map<string, T>();
  const now = () => environment.now?.() ?? Date.now();
  const cooldownMs = environment.cooldownMs;
  const scheduleTimer = environment.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelTimer = environment.clearTimeout ?? ((timer) => clearTimeout(timer));
  let lastDeliveredAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    pending.clear();
    if (timer !== null) cancelTimer(timer);
    timer = null;
  };
  const deliverBatch = (notifications: T[]) => {
    if (notifications.length === 1) environment.deliver(notifications[0]);
    else if (notifications.length > 1) environment.deliver(environment.makeDigest(notifications));
  };
  const flush = () => {
    timer = null;
    if (pending.size === 0) return;
    if (!environment.shouldDeliver()) {
      clear();
      return;
    }
    const notifications = [...pending.values()];
    pending.clear();
    lastDeliveredAt = now();
    deliverBatch(notifications);
  };

  return {
    enqueue(key, notification) {
      if (!environment.shouldDeliver()) {
        clear();
        return;
      }
      pending.set(key, notification);
      const time = now();
      if (lastDeliveredAt === null || time - lastDeliveredAt >= cooldownMs) {
        const notifications = [...pending.values()];
        pending.clear();
        if (timer !== null) cancelTimer(timer);
        timer = null;
        lastDeliveredAt = time;
        deliverBatch(notifications);
        return;
      }
      if (timer !== null) return;
      const delay = Math.max(0, lastDeliveredAt + cooldownMs - time);
      timer = scheduleTimer(flush, delay);
    },
    clear,
  };
}

type DocumentAttentionState = Pick<Document, "visibilityState" | "hasFocus">;

export function shouldShowBrowserNotification(
  attentionState: DocumentAttentionState = document,
): boolean {
  return attentionState.visibilityState !== "visible" || !attentionState.hasFocus();
}

export function isBlockingExtensionUiRequest(
  request: ExtensionUiRequest,
): request is BlockingExtensionUiRequest {
  switch (request.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      return true;
    case "custom":
      return request.closed !== true;
    default:
      return false;
  }
}

export function claimExtensionAttentionNotification(
  request: ExtensionUiRequest,
  notifiedRequestIds: Set<string>,
): request is BlockingExtensionUiRequest {
  if (!isBlockingExtensionUiRequest(request) || notifiedRequestIds.has(request.id)) return false;
  notifiedRequestIds.add(request.id);
  return true;
}

function getBrowserEnvironment(): BrowserNotificationEnvironment {
  return {
    createWindowNotification: (title, options) => new Notification(title, options),
    getServiceWorkerRegistration: "serviceWorker" in navigator
      ? () => navigator.serviceWorker.getRegistration()
      : null,
  };
}

export async function showBrowserNotification(
  options: BrowserNotificationOptions,
  environment: BrowserNotificationEnvironment = getBrowserEnvironment(),
): Promise<NotificationDelivery> {
  const notificationOptions: NotificationOptions = {
    body: options.body,
    ...(options.tag ? { tag: options.tag, renotify: true } : {}),
  };

  if (environment.getServiceWorkerRegistration) {
    try {
      const registration = await environment.getServiceWorkerRegistration();
      if (registration) {
        await registration.showNotification(options.title, {
          ...notificationOptions,
          data: { url: options.sessionUrl },
        });
        return "service-worker";
      }
    } catch {
      // Fall back to a page notification where the constructor is supported.
    }
  }

  try {
    const notification = environment.createWindowNotification(options.title, notificationOptions);
    notification.onclick = () => {
      notification.close();
      options.onClick();
    };
    return "window";
  } catch {
    // Most mobile browsers expose Notification but require service-worker delivery.
    return null;
  }
}
