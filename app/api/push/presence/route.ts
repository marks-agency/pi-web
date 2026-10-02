import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getPushProfileId, removePushPresence, reportPushPresence } from "@/lib/web-push";

export const dynamic = "force-dynamic";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

interface PresenceRequestBody {
  clientId?: unknown;
  visible?: unknown;
  focused?: unknown;
  lastActivityAt?: unknown;
}

interface PresenceRemovalBody {
  clientId?: unknown;
}

function invalidRequest(request: Request): Response | null {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  return null;
}

function validClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

export async function POST(request: Request): Promise<Response> {
  const invalid = invalidRequest(request);
  if (invalid) return invalid;

  let body: PresenceRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!validClientId(body.clientId) || typeof body.visible !== "boolean" || typeof body.focused !== "boolean"
    || !Number.isSafeInteger(body.lastActivityAt) || (body.lastActivityAt as number) < 0) {
    return Response.json({ error: "Invalid presence report" }, { status: 400 });
  }

  try {
    const profileId = getPushProfileId(request);
    if (!profileId) return Response.json({ error: "Authentication or profile selection required" }, { status: 401 });
    const engaged = await reportPushPresence(profileId, body.clientId, {
      visible: body.visible,
      focused: body.focused,
      lastActivityAt: Math.min(body.lastActivityAt as number, Date.now()),
    });
    return Response.json({ ok: true, engaged }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Presence service unavailable" }, { status: 503 });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const invalid = invalidRequest(request);
  if (invalid) return invalid;

  let body: PresenceRemovalBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!validClientId(body.clientId)) {
    return Response.json({ error: "Invalid client id" }, { status: 400 });
  }

  try {
    const profileId = getPushProfileId(request);
    if (!profileId) return Response.json({ error: "Authentication or profile selection required" }, { status: 401 });
    await removePushPresence(profileId, body.clientId);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Presence service unavailable" }, { status: 503 });
  }
}
