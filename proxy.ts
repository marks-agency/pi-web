import { NextResponse, type NextRequest } from "next/server";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  getWebAuthConfig,
  getWebSessionIdentity,
  isValidBasicAuthorization,
  PI_WEB_SESSION_COOKIE,
  type WebAuthConfig,
} from "@/lib/web-auth";

function tooManyAttempts(retryAfterMs: number): NextResponse {
  return new NextResponse("Too many failed attempts", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds(retryAfterMs)),
    },
  });
}

function unavailableAuthConfig(): NextResponse {
  return new NextResponse("Pi Web authentication is misconfigured", {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  let config: WebAuthConfig;
  try {
    config = getWebAuthConfig();
  } catch (error) {
    console.error("[pi-web] invalid authentication configuration:", error instanceof Error ? error.message : error);
    return unavailableAuthConfig();
  }

  if (config.mode === "none") {
    if (request.nextUrl.pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  const cookieIdentity = getWebSessionIdentity(
    request.cookies.get(PI_WEB_SESSION_COOKIE)?.value,
    config,
  );
  let authenticated = cookieIdentity !== null;
  const authorization = isApiRequest ? request.headers.get("authorization") : null;
  if (!authenticated && config.mode === "legacy" && authorization && /^Basic\s/i.test(authorization)) {
    const retryAfterMs = getAuthRetryAfterMs();
    if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);
    authenticated = isValidBasicAuthorization(authorization, config.password);
    if (!authenticated) recordAuthFailure();
  }
  if (request.nextUrl.pathname === "/login") {
    return authenticated
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }
  if (request.nextUrl.pathname === "/api/web-auth") return NextResponse.next();

  if (!authenticated) {
    if (!isApiRequest) {
      const loginUrl = new URL("/login", request.url);
      if (request.nextUrl.search) {
        loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      }
      return NextResponse.redirect(loginUrl);
    }
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        ...(config.mode === "legacy"
          ? { "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"' }
          : {}),
      },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/api/:path*"] };
