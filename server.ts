// bb-plugin-lanes — one place to see every model lane's headroom.
//
// bb natively tracks Claude Code and Codex subscription windows. It knows
// nothing about OpenCode Zen Go or OpenRouter, which is the gap this fills.
//
// The four lanes are NOT the same kind of thing, and the difference is the
// whole point of the display:
//
//   subscription (Claude, Codex, Zen Go) — a quota window that REFILLS.
//     Exhausting one costs you waiting until resetsAt. Zen Go is a $10/mo plan
//     with rolling/weekly/monthly caps, so it belongs here, not with OpenRouter.
//   metered (OpenRouter) — a balance that DEPLETES, with no auto-reload.
//     It does not throttle; it runs dry and the lane stops working.
//
// LiteLLM is deliberately absent. It is the router the Zen and OpenRouter
// traffic flows through, so showing it beside them would double-count. Its
// useful axis is attribution (which alias burned the budget), which needs
// per-lane virtual keys — a later iteration.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const SNAPSHOT_KEY = "snapshot";
const FETCH_TIMEOUT_MS = 20_000;

const windowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});

const laneSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["subscription", "metered"]),
  status: z.enum(["ok", "error", "unconfigured"]),
  planLabel: z.string().nullable(),
  windows: z.array(windowSchema),
  detail: z.string().nullable(),
});

const snapshotSchema = z.object({
  fetchedAt: z.string(),
  lanes: z.array(laneSchema),
});

type Lane = z.infer<typeof laneSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;

export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: snapshotSchema.nullable() },
  refresh: { input: z.null(), output: snapshotSchema },
});

/** Credentials come from bb's env store, read FILE FIRST and process.env only
 *  as a fallback.
 *
 *  The order matters and is not the obvious one: process.env is a snapshot
 *  taken when the server started, so after a key rotation it serves a revoked
 *  credential until the whole server restarts. env.json is the live file the
 *  user edits. Preferring process.env produced a 401 on OpenRouter minutes
 *  after a rotation while the file on disk was already correct. */
async function readKey(name: string): Promise<string> {
  try {
    const raw = await readFile(join(homedir(), ".bb", "env.json"), "utf8");
    const fromFile = (JSON.parse(raw)?.env ?? {})[name];
    if (fromFile) return fromFile;
  } catch {
    // fall through to the process environment
  }
  return process.env[name] ?? "";
}

async function getJson(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Zen rejects some default user agents outright (403) while accepting any
    // ordinary one, so always send a real identifier.
    const res = await fetch(url, {
      headers: { "User-Agent": "bb-plugin-lanes/0.1", ...headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function errorLane(id: string, name: string, kind: Lane["kind"], detail: string): Lane {
  return { id, name, kind, status: "error", planLabel: null, windows: [], detail };
}

async function nativeLanes(bb: BbPluginApi): Promise<Lane[]> {
  const spec: Array<[string, string]> = [
    ["claudeCode", "Claude Code"],
    ["codex", "Codex"],
  ];
  try {
    const usage = (await bb.sdk.system.usageLimits()) as Record<string, any>;
    return spec.flatMap(([key, name]) => {
      const p = usage?.[key];
      // A provider that is not installed is not a lane — omit rather than
      // render a permanently empty row.
      if (!p || p.status === "not_installed") return [];
      if (p.status !== "ok") {
        return [errorLane(key, name, "subscription", `provider reported "${p.status}"`)];
      }
      return [{
        id: key,
        name,
        kind: "subscription" as const,
        status: "ok" as const,
        planLabel: p.planLabel ?? null,
        windows: (p.windows ?? []).map((w: any) => ({
          label: w.label,
          usedPercent: w.usedPercent,
          resetsAt: w.resetsAt ?? null,
        })),
        detail: null,
      }];
    });
  } catch (err) {
    return spec.map(([key, name]) =>
      errorLane(key, name, "subscription", `bb usage lookup failed: ${(err as Error).message}`),
    );
  }
}

async function zenLane(): Promise<Lane> {
  const key = await readKey("OPENCODE_API_KEY");
  if (!key) {
    return { id: "opencode-go", name: "OpenCode Go", kind: "subscription",
      status: "unconfigured", planLabel: null, windows: [],
      detail: "no OPENCODE_API_KEY in bb's env store" };
  }
  try {
    const data = await getJson("https://opencode.ai/zen/go/v1/usage", {
      Authorization: `Bearer ${key}`,
    });
    const order = ["rolling", "weekly", "monthly"];
    const usage = (data as any)?.usage ?? {};
    const windows = order
      .filter((k) => usage[k])
      .map((k) => ({
        label: k === "rolling" ? "Rolling (5h)" : k[0].toUpperCase() + k.slice(1),
        usedPercent: Number(usage[k].percent ?? 0),
        resetsAt: usage[k].resetsAt ?? null,
      }));
    return { id: "opencode-go", name: "OpenCode Go", kind: "subscription",
      status: "ok", planLabel: "Go", windows, detail: null };
  } catch (err) {
    return errorLane("opencode-go", "OpenCode Go", "subscription", (err as Error).message);
  }
}

async function openRouterLane(): Promise<Lane> {
  const key = await readKey("OPENROUTER_API_KEY");
  if (!key) {
    return { id: "openrouter", name: "OpenRouter", kind: "metered",
      status: "unconfigured", planLabel: null, windows: [],
      detail: "no OPENROUTER_API_KEY in bb's env store" };
  }
  try {
    const data = await getJson("https://openrouter.ai/api/v1/credits", {
      Authorization: `Bearer ${key}`,
    });
    const total = Number((data as any)?.data?.total_credits ?? 0);
    const used = Number((data as any)?.data?.total_usage ?? 0);
    const left = total - used;
    // Rendered as a window for visual consistency, but resetsAt is null on
    // purpose: this balance does not refill on its own.
    return {
      id: "openrouter",
      name: "OpenRouter",
      kind: "metered",
      status: "ok",
      planLabel: "pay-as-you-go",
      windows: [{
        label: "Balance consumed",
        usedPercent: total > 0 ? (used / total) * 100 : 0,
        resetsAt: null,
      }],
      detail: `$${left.toFixed(2)} of $${total.toFixed(2)} left — no auto-reload`,
    };
  } catch (err) {
    return errorLane("openrouter", "OpenRouter", "metered", (err as Error).message);
  }
}

export default async function plugin(bb: BbPluginApi) {
  async function collect(): Promise<Snapshot> {
    const [native, zen, openrouter] = await Promise.all([
      nativeLanes(bb),
      zenLane(),
      openRouterLane(),
    ]);
    const snapshot: Snapshot = {
      fetchedAt: new Date().toISOString(),
      lanes: [...native, zen, openrouter],
    };
    await bb.storage.kv.set(SNAPSHOT_KEY, snapshot);
    return snapshot;
  }

  bb.rpc.register(rpcContract, {
    snapshot: async () => (await bb.storage.kv.get<Snapshot>(SNAPSHOT_KEY)) ?? null,
    refresh: () => collect(),
  });

  // Every 5 minutes is well inside every window here; the shortest is Zen's
  // 5-hour rolling cap.
  bb.background.schedule("poll", "*/5 * * * *", async () => {
    await collect();
  });

  bb.cli.register({
    name: "lanes",
    summary: "Model lane headroom across every provider",
    commands: [
      { name: "status", summary: "Show current headroom", usage: "bb lanes [status] [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      // Always read fresh for the CLI: an agent asking about headroom is about
      // to make a routing decision on the answer.
      const snap = await collect();
      if (json) return { exitCode: 0, stdout: JSON.stringify(snap, null, 2) };
      const lines = snap.lanes.map((lane) => {
        if (lane.status !== "ok") return `${lane.name}: ${lane.status} — ${lane.detail ?? ""}`;
        const worst = lane.windows.reduce(
          (acc, w) => (w.usedPercent > acc.usedPercent ? w : acc),
          lane.windows[0] ?? { label: "-", usedPercent: 0, resetsAt: null },
        );
        const head = `${lane.name} (${lane.planLabel ?? lane.kind})`;
        const body = lane.windows.length
          ? `${worst.usedPercent.toFixed(0)}% used [${worst.label}]` +
            (worst.resetsAt ? `, resets ${worst.resetsAt}` : "")
          : "no windows reported";
        return `${head}: ${body}${lane.detail ? ` — ${lane.detail}` : ""}`;
      });
      return { exitCode: 0, stdout: lines.join("\n") };
    },
  });

  // Populate immediately so the homepage is not blank until the first cron tick.
  void collect().catch((err) => bb.log.error(`initial poll failed: ${err.message}`));

  bb.log.info("lanes ready");
}
