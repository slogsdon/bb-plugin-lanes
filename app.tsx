// bb-plugin-lanes — frontend entry.
//
// One card showing every model lane's headroom. The visual language encodes the
// distinction the backend draws: subscription lanes show a window that REFILLS
// (so a reset countdown is the useful number), while the metered lane shows a
// balance that DEPLETES (so remaining dollars are, and a countdown would be a
// lie — nothing refills it).
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Window = { label: string; usedPercent: number; resetsAt: string | null };
type Lane = {
  id: string;
  name: string;
  kind: "subscription" | "metered";
  status: "ok" | "error" | "unconfigured";
  planLabel: string | null;
  windows: Window[];
  detail: string | null;
};
type Snapshot = { fetchedAt: string; lanes: Lane[] };

/** Compact "2h 14m" / "3d 4h". Returns null once the reset is in the past — a
 *  stale window is better shown as nothing than as a negative countdown. */
function untilReset(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** Semantic tokens only — the host theme supplies the palette, and hardcoded
 *  colors would break under a custom theme or in dark mode. */
function barTone(percent: number): string {
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-primary";
  return "bg-primary/60";
}

function WindowRow({ window: w, metered }: { window: Window; metered: boolean }) {
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  const left = untilReset(w.resetsAt);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{w.label}</span>
        <span className="tabular-nums">
          {pct.toFixed(0)}%
          {left ? (
            <span className="text-muted-foreground"> · resets in {left}</span>
          ) : metered ? null : (
            <span className="text-muted-foreground"> · no reset reported</span>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${barTone(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function LaneRow({ lane }: { lane: Lane }) {
  return (
    <div className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{lane.name}</span>
        <span className="text-xs text-muted-foreground">
          {lane.planLabel ?? lane.kind}
        </span>
      </div>

      {lane.status !== "ok" ? (
        <p className="text-xs text-destructive">
          {lane.status === "unconfigured" ? "Not configured" : "Unavailable"}
          {lane.detail ? ` — ${lane.detail}` : ""}
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {lane.windows.map((w) => (
              <WindowRow key={w.label} window={w} metered={lane.kind === "metered"} />
            ))}
          </div>
          {lane.detail ? (
            <p className="text-xs text-muted-foreground">{lane.detail}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function LanesSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cached snapshot on mount so the card paints immediately; the backend's
  // 5-minute schedule keeps it current without the UI polling.
  useEffect(() => {
    let cancelled = false;
    rpc
      .call("snapshot")
      .then((s) => {
        if (!cancelled) setSnapshot(s as Snapshot | null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  const refresh = useCallback(() => {
    setBusy(true);
    setError(null);
    rpc
      .call("refresh")
      .then((s) => setSnapshot(s as Snapshot))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  }, [rpc]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Lanes</CardTitle>
        <Button size="sm" variant="outline" onClick={refresh} disabled={busy}>
          {busy ? "Checking…" : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {snapshot === null && !error ? (
          <p className="text-xs text-muted-foreground">No reading yet.</p>
        ) : null}
        {snapshot?.lanes.map((lane) => (
          <LaneRow key={lane.id} lane={lane} />
        ))}
        {snapshot ? (
          <p className="pt-1 text-xs text-muted-foreground">
            Updated {new Date(snapshot.fetchedAt).toLocaleTimeString()}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "lanes",
    title: "Lanes",
    component: LanesSection,
  });
});
