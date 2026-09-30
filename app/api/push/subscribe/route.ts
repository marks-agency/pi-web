import { addSubscription, removeSubscription, type PushSubscriptionRecord } from "@/lib/web-push";
import { getWebAuthConfig, getWebRequestIdentity } from "@/lib/web-auth";

export const dynamic = "force-dynamic";

interface SubscribeRequestBody {
  subscription?: Partial<PushSubscriptionRecord>;
  locale?: string;
}

interface UnsubscribeRequestBody {
  endpoint?: unknown;
}

function isValidSubscription(subscription: Partial<PushSubscriptionRecord> | undefined): subscription is PushSubscriptionRecord {
  if (typeof subscription !== "object" || subscription === null) return false;
  if (typeof subscription.endpoint !== "string" || !/^https:\/\//.test(subscription.endpoint)) return false;
  const keys = subscription.keys;
  if (typeof keys !== "object" || keys === null) return false;
  return typeof keys.p256dh === "string" && keys.p256dh.length > 0
    && typeof keys.auth === "string" && keys.auth.length > 0;
}

function identityForRequest(request: Request) {
  const config = getWebAuthConfig();
  const identity = getWebRequestIdentity(request, config);
  if (config.mode === "users" && !identity) return { error: "Authentication required" } as const;
  return { config, identity } as const;
}

// POST /api/push/subscribe - register a browser push subscription. The owner
// is always derived from the validated server-side login identity, never body data.
export async function POST(req: Request): Promise<Response> {
  let body: SubscribeRequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isValidSubscription(body.subscription)) {
    return Response.json({ error: "Invalid push subscription" }, { status: 400 });
  }

  try {
    const auth = identityForRequest(req);
    if ("error" in auth) return Response.json({ error: auth.error }, { status: 401 });
    const locale = body.locale === "zh-CN" ? "zh-CN" : "en";
    await addSubscription({
      endpoint: body.subscription.endpoint,
      keys: body.subscription.keys,
      locale,
      ...(auth.identity ? { userId: auth.identity.id } : {}),
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 503 });
  }
}

// DELETE /api/push/subscribe - unlink this browser endpoint at logout.
export async function DELETE(req: Request): Promise<Response> {
  let body: UnsubscribeRequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.endpoint !== "string" || !/^https:\/\//.test(body.endpoint)) {
    return Response.json({ error: "Invalid push endpoint" }, { status: 400 });
  }

  try {
    const auth = identityForRequest(req);
    if ("error" in auth) return Response.json({ error: auth.error }, { status: 401 });
    await removeSubscription(body.endpoint, auth.identity?.id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 503 });
  }
}
