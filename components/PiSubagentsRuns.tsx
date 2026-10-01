"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

interface RunNode {
  id: string;
  kind: "subagent" | "workflow" | "step" | "host-step";
  label: string;
  state: string;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  activity?: { currentTool?: string; lastActivityAt?: number };
  children?: RunNode[];
}

interface RunSnapshot {
  available: boolean;
  runs: RunNode[];
  error?: string;
  controls?: { steer: boolean; stop: boolean };
  omitted?: { runs: number; children: number };
}

function stateColor(state: string): string {
  if (state === "running" || state === "queued") return "var(--accent)";
  if (state === "complete") return "#16a34a";
  if (state === "failed" || state === "rejected") return "#dc2626";
  return "var(--text-dim)";
}

function formatElapsed(startedAt: number | undefined, endedAt?: number): string {
  if (startedAt === undefined) return "";
  const seconds = Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function PiSubagentsRuns({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [transcript, setTranscript] = useState<{ runId: string; text: string } | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState<string | null>(null);
  const [steerTarget, setSteerTarget] = useState<string | null>(null);
  const [steerMessage, setSteerMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/subagents/extension?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const data = await response.json() as RunSnapshot;
      setSnapshot(response.ok ? data : { available: false, runs: [], error: data.error });
    } catch (error) {
      setSnapshot({ available: false, runs: [], error: error instanceof Error ? error.message : String(error) });
    }
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!snapshot?.available) return;
    const timer = window.setInterval(() => { void refresh(); }, 4_000);
    return () => window.clearInterval(timer);
  }, [refresh, snapshot?.available]);

  const controlRun = async (runId: string, action: "steer" | "stop", message?: string) => {
    setPendingAction(runId);
    setActionError(null);
    try {
      const response = await fetch(`/api/subagents/extension?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, runId, ...(message !== undefined ? { message } : {}) }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? t("subagents.actionFailed"));
      setSteerTarget(null);
      setSteerMessage("");
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("subagents.actionFailed"));
    } finally {
      setPendingAction(null);
    }
  };

  const inspect = async (runId: string) => {
    setLoadingTranscript(runId);
    try {
      const response = await fetch(`/api/subagents/extension?sessionId=${encodeURIComponent(sessionId)}&runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
      const data = await response.json() as { transcript?: string; error?: string };
      setTranscript({ runId, text: response.ok ? data.transcript ?? t("subagents.noTranscript") : data.error ?? t("subagents.requestFailed") });
    } catch (error) {
      setTranscript({ runId, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoadingTranscript(null);
    }
  };

  const renderRun = (run: RunNode, depth = 0) => (
    <div key={`${run.kind}:${run.id}`} style={{ borderTop: "1px solid var(--border)", padding: "9px 12px 9px 12px", marginLeft: depth ? Math.min(depth, 3) * 12 : 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: stateColor(run.state), flexShrink: 0 }} />
        <span title={run.label} style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12, fontWeight: 550 }}>{run.label}</span>
        <span style={{ color: stateColor(run.state), fontSize: 10, whiteSpace: "nowrap" }}>{t(`subagents.state.${run.state}` as never)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, paddingLeft: 15, color: "var(--text-dim)", fontSize: 10 }}>
        <span>{formatElapsed(run.startedAt, run.endedAt)}</span>
        {run.activity?.currentTool && <span title={run.activity.currentTool} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{run.activity.currentTool}</span>}
        {depth === 0 && (run.kind === "subagent" || run.kind === "workflow") && (run.state === "running" || run.state === "queued") && (
          <>
            {snapshot?.controls?.steer && <button type="button" onClick={() => { setActionError(null); setSteerTarget(steerTarget === run.id ? null : run.id); }} disabled={pendingAction === run.id} style={{ marginLeft: "auto", border: 0, padding: 0, background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 10, whiteSpace: "nowrap" }}>
              {t("subagents.steer")}
            </button>}
            {snapshot?.controls?.stop && <button type="button" onClick={() => { if (window.confirm(t("subagents.stopConfirm"))) void controlRun(run.id, "stop"); }} disabled={pendingAction === run.id} style={{ border: 0, padding: 0, background: "transparent", color: "#dc2626", cursor: "pointer", fontSize: 10, whiteSpace: "nowrap" }}>
              {pendingAction === run.id ? t("subagents.stopping") : t("subagents.stop")}
            </button>}
          </>
        )}
        {run.kind !== "step" && run.kind !== "host-step" && (
          <button type="button" onClick={() => void inspect(run.id)} disabled={loadingTranscript === run.id || pendingAction === run.id} style={{ marginLeft: depth === 0 && (run.state === "running" || run.state === "queued") && (snapshot?.controls?.steer || snapshot?.controls?.stop) ? 0 : "auto", border: 0, padding: 0, background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 10, whiteSpace: "nowrap" }}>
            {loadingTranscript === run.id ? t("subagents.loading") : t("subagents.inspect")}
          </button>
        )}
      </div>
      {steerTarget === run.id && (
        <form onSubmit={(event) => { event.preventDefault(); if (steerMessage.trim()) void controlRun(run.id, "steer", steerMessage.trim()); }} style={{ display: "flex", gap: 6, padding: "7px 0 0 15px" }}>
          <input value={steerMessage} onChange={(event) => setSteerMessage(event.target.value)} maxLength={4000} placeholder={t("subagents.steerPlaceholder")} aria-label={t("subagents.steerPlaceholder")} autoFocus style={{ minWidth: 0, flex: 1, height: 28, border: "1px solid var(--border)", borderRadius: 5, padding: "0 8px", background: "var(--bg)", color: "var(--text)", fontSize: 11 }} />
          <button type="submit" disabled={!steerMessage.trim() || pendingAction === run.id} style={{ border: 0, borderRadius: 5, padding: "0 8px", background: "var(--accent)", color: "var(--bg-panel)", cursor: "pointer", fontSize: 10 }}>{t("subagents.send")}</button>
          <button type="button" onClick={() => { setSteerTarget(null); setSteerMessage(""); }} style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "0 8px", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>{t("subagents.cancel")}</button>
        </form>
      )}
      {run.children?.map((child) => renderRun(child, depth + 1))}
    </div>
  );

  const runs = snapshot?.runs ?? [];
  const activeCount = runs.reduce((count, run) => count + (run.state === "running" || run.state === "queued" ? 1 : 0), 0);

  return (
    <section aria-label={t("subagents.extensionTitle")} style={{ borderTop: "1px solid var(--border)" }}>
      <div style={{ minHeight: 38, display: "flex", alignItems: "center", gap: 8, padding: "6px 12px" }}>
        <strong style={{ fontSize: 11, fontWeight: 600 }}>{t("subagents.extensionTitle")}</strong>
        {activeCount > 0 && <span style={{ color: "var(--accent)", fontSize: 10 }}>{t("subagents.activeCount", { count: activeCount })}</span>}
        <button type="button" onClick={() => void refresh()} title={t("subagents.refresh")} aria-label={t("subagents.refresh")} style={{ marginLeft: "auto", border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>↻</button>
      </div>
      {snapshot?.error && <div role="status" style={{ padding: "0 12px 8px", color: "var(--text-dim)", fontSize: 11 }}>{snapshot.error}</div>}
      {actionError && <div role="alert" style={{ padding: "0 12px 8px", color: "#dc2626", fontSize: 11 }}>{actionError}</div>}
      {snapshot && !snapshot.available && !snapshot.error && <div style={{ padding: "0 12px 10px", color: "var(--text-dim)", fontSize: 11 }}>{t("subagents.extensionUnavailable")}</div>}
      {snapshot?.available && runs.length === 0 && <div style={{ padding: "0 12px 10px", color: "var(--text-dim)", fontSize: 11 }}>{t("subagents.noRuns")}</div>}
      {runs.map((run) => renderRun(run))}
      {snapshot?.omitted && (snapshot.omitted.runs > 0 || snapshot.omitted.children > 0) && <div style={{ padding: "6px 12px", color: "var(--text-dim)", fontSize: 10 }}>{t("subagents.omitted")}</div>}
      {transcript && (
        <div role="dialog" aria-modal="true" aria-label={t("subagents.transcriptTitle")} style={{ position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 16, background: "rgba(0,0,0,0.35)" }} onClick={() => setTranscript(null)}>
          <div onClick={(event) => event.stopPropagation()} style={{ width: "min(760px, 100%)", maxHeight: "80dvh", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 18px 48px rgba(0,0,0,0.24)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, borderBottom: "1px solid var(--border)" }}>
              <strong style={{ flex: 1, fontSize: 12 }}>{t("subagents.transcriptTitle")}</strong>
              <button type="button" onClick={() => setTranscript(null)} aria-label={t("i18n.close")} style={{ border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}>×</button>
            </div>
            <pre style={{ margin: 0, padding: 12, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text)", fontSize: 11, lineHeight: 1.5 }}>{transcript.text}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
