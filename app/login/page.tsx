"use client";

import Image from "next/image";
import { useEffect, useState, type FormEvent } from "react";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { clearPushSubscriptionForCurrentUser, isPushSupported, setupPushSubscription } from "@/lib/push-client";
import { safeLoginDestination } from "@/lib/login-destination";

type LoginMode = "loading" | "legacy" | "users" | "error";

function safeDestination(): string {
  const destination = new URLSearchParams(window.location.search).get("next");
  return safeLoginDestination(destination, window.location.origin);
}

function LoginForm() {
  const { locale, t } = useI18n();
  const [mode, setMode] = useState<LoginMode>("loading");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/web-auth", { cache: "no-store" })
      .then(async (response) => {
        const status = await response.json() as { mode?: string };
        if (!response.ok || (status.mode !== "legacy" && status.mode !== "users")) {
          throw new Error("Authentication configuration is unavailable");
        }
        if (!cancelled) setMode(status.mode);
      })
      .catch(() => {
        if (!cancelled) {
          setMode("error");
          setError(t("auth.loginFailed"));
        }
      });
    return () => { cancelled = true; };
  }, [t]);

  const failureMessage = async (response: Response): Promise<string> => {
    if (response.status === 401) return t("auth.invalidCredentials");
    if (response.status !== 429) return t("auth.loginFailed");
    const seconds = Number(response.headers.get("retry-after"));
    return t("auth.tooManyAttempts", { seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 1 });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/web-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "users" ? { username, password } : { password }),
      });
      if (!response.ok) {
        setError(await failureMessage(response));
        return;
      }
      if (isPushSupported() && Notification.permission === "granted") {
        const bound = await setupPushSubscription(locale);
        if (!bound) await clearPushSubscriptionForCurrentUser();
      }
      window.location.replace(safeDestination());
    } catch {
      setError(t("auth.loginFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="web-login-page">
      <div className="web-login-shell">
        <header className="web-login-brand">
          <Image src="/icons/apple-touch-icon.png" width={52} height={52} alt="" priority />
          <div>
            <h1>Pi Web</h1>
            <p>{t("auth.prompt")}</p>
          </div>
        </header>
        <form className="web-login-form" onSubmit={submit}>
          <div className="web-login-composer">
            {mode === "users" && (
              <>
                <label className="web-login-label" htmlFor="web-login-username">{t("auth.username")}</label>
                <input
                  id="web-login-username"
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={t("auth.username")}
                  autoComplete="username"
                  autoFocus
                  required
                  disabled={busy}
                />
              </>
            )}
            <label className="web-login-label" htmlFor="web-login-password">{t("auth.password")}</label>
            <input
              id="web-login-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("auth.password")}
              autoComplete="current-password"
              autoFocus={mode === "legacy"}
              required
              disabled={busy || mode === "loading" || mode === "error"}
            />
            <button type="submit" disabled={busy || mode === "loading" || mode === "error" || !password || (mode === "users" && !username)}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              {busy ? t("auth.loggingIn") : t("auth.logIn")}
            </button>
          </div>
          <p className="web-login-error" role="alert" aria-live="polite">{error}</p>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <I18nProvider><LoginForm /></I18nProvider>;
}
