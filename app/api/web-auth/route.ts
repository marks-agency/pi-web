import { NextRequest, NextResponse } from "next/server";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  recordAuthSuccess,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  createUserSelectionToken,
  createUserWebSessionToken,
  createWebSessionToken,
  findWebUserByUsername,
  getWebAuthConfig,
  getWebRequestIdentity,
  isValidWebPassword,
  PI_WEB_PROFILE_COOKIE,
  PI_WEB_PROFILE_MAX_AGE,
  PI_WEB_SESSION_COOKIE,
  PI_WEB_SESSION_MAX_AGE,
  verifyWebUserPassword,
} from "@/lib/web-auth";

export const dynamic = "force-dynamic";

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";
}

function tooManyAttempts(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    { error: "Too many failed attempts", retryAfterMs },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds(retryAfterMs)),
      },
    },
  );
}

function clearSessionCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  });
}

function clearProfileCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    name: PI_WEB_PROFILE_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  });
}

function unavailableAuthConfig(): NextResponse {
  return NextResponse.json(
    { error: "Pi Web authentication is misconfigured" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const config = getWebAuthConfig();
    const identity = getWebRequestIdentity(request, config);
    const authenticated = config.mode === "none"
      || (config.mode !== "selection" && identity !== null);
    return NextResponse.json(
      {
        enabled: config.mode === "legacy" || config.mode === "users",
        mode: config.mode,
        authenticated,
        ...(config.mode !== "selection" && identity
          ? { user: { id: identity.id, username: identity.username, displayName: identity.displayName } }
          : {}),
        ...(config.mode === "users" && identity
          ? { users: config.data.users.map(({ id, username, displayName }) => ({ id, username, displayName })) }
          : {}),
        ...(config.mode === "selection"
          ? {
              profiles: config.data.users.map(({ id, displayName }) => ({ id, displayName })),
              selectedProfile: identity ? { id: identity.id, displayName: identity.displayName } : null,
            }
          : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[pi-web] invalid authentication configuration:", error instanceof Error ? error.message : error);
    return unavailableAuthConfig();
  }
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let config: ReturnType<typeof getWebAuthConfig>;
  try {
    config = getWebAuthConfig();
  } catch (error) {
    console.error("[pi-web] invalid authentication configuration:", error instanceof Error ? error.message : error);
    return unavailableAuthConfig();
  }
  if (config.mode === "none") {
    return NextResponse.json({ error: "Password authentication is disabled" }, { status: 404 });
  }

  if (config.mode === "selection") {
    const body = await request.json().catch(() => null) as { profileId?: unknown } | null;
    if (!body || typeof body.profileId !== "string") {
      return NextResponse.json({ error: "profileId is required" }, { status: 400 });
    }
    const user = config.usersById.get(body.profileId);
    if (!user) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    clearSessionCookie(response, request);
    response.cookies.set({
      name: PI_WEB_PROFILE_COOKIE,
      value: createUserSelectionToken(user, config.data.sessionSecret),
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureRequest(request),
      path: "/",
      maxAge: PI_WEB_PROFILE_MAX_AGE,
    });
    return response;
  }

  const retryAfterMs = getAuthRetryAfterMs();
  if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);

  const body = await request.json().catch(() => null) as {
    username?: unknown;
    password?: unknown;
  } | null;
  let sessionToken: string | undefined;
  if (config.mode === "legacy") {
    if (body && typeof body.password === "string" && isValidWebPassword(body.password, config.password)) {
      sessionToken = createWebSessionToken(config.password);
    }
  } else if (body && typeof body.username === "string" && typeof body.password === "string") {
    const user = findWebUserByUsername(config, body.username);
    if (verifyWebUserPassword(user, body.password) && user) {
      sessionToken = createUserWebSessionToken(user, config.data.sessionSecret);
    }
  }

  if (!sessionToken) {
    const delayMs = recordAuthFailure();
    console.warn(`[web-auth] Authentication failed; next attempt blocked for ${delayMs}ms`);
    return NextResponse.json(
      { error: config.mode === "legacy" ? "Invalid password" : "Invalid credentials", retryAfterMs: delayMs },
      { status: 401, headers: { "Retry-After": String(retryAfterSeconds(delayMs)) } },
    );
  }

  recordAuthSuccess();
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: sessionToken,
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: PI_WEB_SESSION_MAX_AGE,
  });
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response, request);
  clearProfileCookie(response, request);
  return response;
}
