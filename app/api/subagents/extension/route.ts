import { NextResponse } from "next/server";
import { getPiSubagentsBridge } from "@/lib/pi-subagents-web-bridge";

export const dynamic = "force-dynamic";

const MAX_RUNS = 20;
const MAX_CHILDREN = 40;
const MAX_LABEL = 160;
const MAX_ACTION = 120;
const MAX_TRANSCRIPT = 80_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = stripControlCharacters(value).trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function publicRun(value: unknown, depth: number, budget: { children: number }): Record<string, unknown> | null {
  const run = record(value);
  if (!run || depth > 4 || budget.children >= MAX_CHILDREN) return null;
  const id = boundedText(run.id, 160);
  const label = boundedText(run.label, MAX_LABEL);
  const states = new Set(["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected"]);
  const kinds = new Set(["subagent", "workflow", "step", "host-step"]);
  if (!id || !label || typeof run.state !== "string" || !states.has(run.state) || typeof run.kind !== "string" || !kinds.has(run.kind)) return null;
  budget.children += 1;
  const activity = record(run.activity);
  const children = Array.isArray(run.children)
    ? run.children.slice(0, MAX_CHILDREN).map((child) => publicRun(child, depth + 1, budget)).filter((child) => child !== null)
    : [];
  return {
    id,
    kind: run.kind,
    label,
    state: run.state,
    ...(boundedNumber(run.startedAt) !== undefined ? { startedAt: run.startedAt } : {}),
    ...(boundedNumber(run.updatedAt) !== undefined ? { updatedAt: run.updatedAt } : {}),
    ...(boundedNumber(run.endedAt) !== undefined ? { endedAt: run.endedAt } : {}),
    ...(activity ? {
      activity: {
        ...(boundedText(activity.currentTool, MAX_ACTION) ? { currentTool: boundedText(activity.currentTool, MAX_ACTION) } : {}),
        ...(boundedNumber(activity.lastActivityAt) !== undefined ? { lastActivityAt: activity.lastActivityAt } : {}),
      },
    } : {}),
    ...(children.length ? { children } : {}),
  };
}

function publicSnapshot(value: unknown): Record<string, unknown> | null {
  const snapshot = record(value);
  if (!snapshot || snapshot.kind !== "pi-subagents.async-status-snapshot" || snapshot.version !== 1 || !Array.isArray(snapshot.runs)) return null;
  const budget = { children: 0 };
  const runs = snapshot.runs.slice(0, MAX_RUNS)
    .map((run) => publicRun(run, 0, budget))
    .filter((run) => run !== null);
  return {
    generatedAt: boundedNumber(snapshot.generatedAt) ?? Date.now(),
    runs,
    omitted: record(snapshot.omitted) ? {
      runs: boundedNumber(record(snapshot.omitted)!.runs) ?? 0,
      children: boundedNumber(record(snapshot.omitted)!.children) ?? 0,
    } : { runs: 0, children: 0 },
  };
}

function stripControlCharacters(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function rpcErrorStatus(error: unknown): number {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "not_found") return 404;
  if (code === "invalid_state" || code === "stale" || code === "no_active_session") return 409;
  if (code === "invalid_params") return 400;
  return 503;
}

function rpcErrorMessage(error: unknown): string {
  const status = rpcErrorStatus(error);
  return status === 404 || status === 409 ? "The run is no longer active." : "pi-subagents request failed";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId || sessionId.length > 4096) {
    return NextResponse.json({ error: "A valid sessionId is required" }, { status: 400 });
  }
  const rpc = getPiSubagentsBridge(sessionId);
  if (!rpc) return NextResponse.json({ available: false, runs: [] }, { headers: { "Cache-Control": "no-store" } });

  try {
    const runId = url.searchParams.get("runId");
    if (runId !== null) {
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(runId)) {
        return NextResponse.json({ error: "Invalid runId" }, { status: 400 });
      }
      const result = record(await rpc("status", { id: runId, view: "transcript", lines: 80 }));
      const text = boundedText(result?.text, MAX_TRANSCRIPT);
      return NextResponse.json({ available: true, transcript: text ?? "No transcript is available." }, { headers: { "Cache-Control": "no-store" } });
    }

    let ping: Record<string, unknown> | null;
    try {
      ping = record(await rpc("ping"));
    } catch {
      return NextResponse.json({ available: false, runs: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    const methods = Array.isArray(ping?.methods) ? ping.methods : [];
    if (!methods.includes("status")) return NextResponse.json({ available: false, runs: [] }, { headers: { "Cache-Control": "no-store" } });
    const status = record(await rpc("status"));
    const snapshot = publicSnapshot(status?.asyncSnapshot);
    return NextResponse.json({
      available: true,
      generatedAt: Date.now(),
      controls: { steer: methods.includes("steer"), stop: methods.includes("stop") },
      runs: snapshot?.runs ?? [],
      omitted: snapshot?.omitted ?? { runs: 0, children: 0 },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      available: false,
      error: error instanceof Error ? error.message.slice(0, 300) : "pi-subagents RPC failed",
      runs: [],
    }, { status: rpcErrorStatus(error), headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId || sessionId.length > 4096) {
    return NextResponse.json({ error: "A valid sessionId is required" }, { status: 400 });
  }
  let body: Record<string, unknown> | null;
  try {
    body = record(await request.json());
  } catch {
    body = null;
  }
  if (!body || (body.action !== "steer" && body.action !== "stop")) {
    return NextResponse.json({ error: "action must be steer or stop" }, { status: 400 });
  }
  if (typeof body.runId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.runId)) {
    return NextResponse.json({ error: "Invalid runId" }, { status: 400 });
  }
  if (body.action === "steer" && (typeof body.message !== "string" || !body.message.trim() || body.message.length > 4000)) {
    return NextResponse.json({ error: "message must contain 1–4000 characters" }, { status: 400 });
  }
  const rpc = getPiSubagentsBridge(sessionId);
  if (!rpc) return NextResponse.json({ error: "pi-subagents is not active for this session" }, { status: 409 });

  try {
    await rpc(body.action, body.action === "steer"
      ? { id: body.runId, message: body.message }
      : { id: body.runId });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      error: rpcErrorMessage(error),
    }, { status: rpcErrorStatus(error), headers: { "Cache-Control": "no-store" } });
  }
}
