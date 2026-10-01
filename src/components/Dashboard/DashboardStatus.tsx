"use client";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAuthSession } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Activity01Icon as Activity, CheckmarkCircle02Icon as CheckCircle2, Clock01Icon as Clock, Copy01Icon as Copy, LinkSquare01Icon as ExternalLink, GlobeIcon as Globe, RefreshIcon as RefreshCw, CancelCircleIcon as XCircle } from "hugeicons-react";
import { Skeleton } from "@/components/ui/skeleton";

interface Monitor {
  id: number;
  name: string;
  url: string;
  status: string;
  uptimePercent: number;
  responseTime: number;
  lastChecked: string | null;
  interval: number;
}

interface StatusData {
  user: { id: string; name: string | null };
  monitors: Monitor[];
}

// 02-07 mounted-guard precedent (Pitfall 10): false during SSR and the
// hydration render, true afterwards. Expressed via useSyncExternalStore with
// a no-op subscribe because the repo lint forbids synchronous setState in
// effects.
const emptySubscribe = () => () => {};

export function DashboardStatus() {
  const { data: session, isPending } = useAuthSession();
  const status = isPending ? "loading" : session ? "authenticated" : "unauthenticated";
  const router = useRouter();
  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // UI-04 abort seam: the ref holds the controller of the latest
  // fetchStatus pass; unmount aborts it so no in-flight fetch — and no
  // post-abort error toast — outlives navigation.
  const statusPollAbortRef = useRef<AbortController | null>(null);
  // UI-04 timer discipline: the copied-reset timeout lives in a ref and is
  // cleared on unmount (it previously leaked past navigation); overlapping
  // clicks restart it.
  const copiedResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    return () => {
      statusPollAbortRef.current?.abort();
      if (copiedResetTimeoutRef.current) {
        clearTimeout(copiedResetTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login?callbackUrl=/dashboard/status");
    }
  }, [status, router]);

  const fetchStatus = useCallback(async () => {
    // New controller per pass (06-01 check-now abort pattern): signal on the
    // fetch, aborted re-check after each await before setState, unmount
    // aborts the latest pass via the ref.
    const abort = new AbortController();
    statusPollAbortRef.current = abort;
    try {
      const res = await fetch("/api/status", { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (!res.ok) {
        if (res.status === 401) { router.push("/login"); return; }
        throw new Error("Failed to fetch");
      }
      const data = await res.json();
      if (abort.signal.aborted) return;
      setData(data);
    } catch {
      if (abort.signal.aborted) return;
      toast.error("Failed to load status data.");
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (status === "authenticated") fetchStatus();
  }, [status, fetchStatus]);

  // Hydration-safe publicUrl derivation (UI-04 / Pitfall 10): the in-render
  // window check is gone — server HTML and the client's first render now
  // agree on the empty value, and the origin is derived post-mount behind
  // the 02-07 mounted guard. The copy handler and the display fallback
  // already tolerate the delayed value.
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const [publicUrl, setPublicUrl] = useState("");

  useEffect(() => {
    if (mounted && session?.user?.id) {
      setPublicUrl(`${window.location.origin}/status/${session.user.id}`);
    }
  }, [mounted, session?.user?.id]);

  const copyLink = () => {
    if (!publicUrl) return;
    navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    toast.success("Link copied to clipboard!");
    if (copiedResetTimeoutRef.current) {
      clearTimeout(copiedResetTimeoutRef.current);
    }
    copiedResetTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  if (status === "loading" || loading) {
    // Skeleton mirrors the loaded layout (D-28 — the shared tier-2 loading
    // pattern; this page previews the public status surface).
    return (
      <div className="min-h-screen bg-background p-4 sm:p-6">
        <div className="max-w-3xl mx-auto space-y-6" data-testid="dashboard-status-skeleton">
          <div className="space-y-2">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-3 w-80" />
          </div>
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
          <div className="space-y-3">
            <Skeleton className="h-4 w-44" />
            <div className="rounded-2xl border border-border divide-y divide-border">
              {[0, 1, 2].map((i) => (
                <div key={i} className="p-4 flex items-center justify-between gap-4">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-52" />
                  </div>
                  <Skeleton className="h-6 w-20 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const monitors = data?.monitors ?? [];
  const allUp = monitors.every((m) => m.status === "UP");
  const anyDown = monitors.some((m) => m.status === "DOWN");

  return (
    <div className="min-h-screen bg-background text-foreground p-4 sm:p-6">
      <div className="max-w-3xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-lg font-semibold text-foreground flex items-center gap-3">
            <Globe className="w-6 h-6 text-primary" />
            Your Status Page
          </h1>
          <p className="text-xs text-muted-meta mt-1 font-mono">
            Share this public URL so others can view your service health — no login required.
          </p>
        </div>

        {/* Public URL Share Card */}
        <div className="glass-panel rounded-2xl border border-primary/30 p-4 sm:p-5 bg-primary/5">
          <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">
            Your Public Status URL
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm text-foreground bg-muted rounded-xl px-3 py-2.5 truncate border border-border font-mono">
              {publicUrl || "Loading..."}
            </code>
            <button
              onClick={copyLink}
              className="p-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground transition-colors cursor-pointer flex-shrink-0"
              title="Copy link"
            >
              <Copy className="w-4 h-4" />
            </button>
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2.5 rounded-xl bg-secondary hover:bg-accent border border-border text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="Open status page"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
          {copied && (
            <p className="text-xs text-status-up mt-2 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" /> Copied!
            </p>
          )}
        </div>

        {/* Overall System Status */}
        <div
          className={`glass-panel rounded-2xl border p-5 flex items-center gap-4 ${
            anyDown
              ? "border-status-down/40 bg-status-down/5"
              : "border-status-up/30 bg-status-up/5"
          }`}
        >
          <div
            className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 transition-colors duration-200 ${
              anyDown ? "bg-status-down/20 text-status-down" : "bg-status-up/20 text-status-up"
            }`}
          >
            {anyDown ? <XCircle className="w-6 h-6" /> : <CheckCircle2 className="w-6 h-6" />}
          </div>
          <div>
            <p
              className={`text-lg font-semibold font-mono transition-colors duration-200 ${
                anyDown ? "text-status-down" : "text-status-up"
              }`}
            >
              {anyDown ? "PARTIAL OUTAGE" : allUp ? "ALL SYSTEMS OPERATIONAL" : "MONITORING..."}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {monitors.length} service{monitors.length !== 1 ? "s" : ""} monitored ·{" "}
              {monitors.filter((m) => m.status === "UP").length} online ·{" "}
              {monitors.filter((m) => m.status === "DOWN").length} down
            </p>
          </div>
          <button
            onClick={fetchStatus}
            className="ml-auto p-2 rounded-xl bg-secondary hover:bg-accent border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Monitor List Preview */}
        {monitors.length === 0 ? (
          <div className="glass-panel rounded-2xl border border-border p-12 text-center space-y-3">
            <Globe className="w-10 h-10 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">No active monitors to display.</p>
          </div>
        ) : (
          <div className="glass-panel rounded-2xl border border-border overflow-hidden">
            <div className="p-4 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">Live Status Preview</h2>
              <p className="text-xs text-muted-foreground mt-0.5">This is a preview of what visitors will see</p>
            </div>
            <div className="divide-y divide-border">
              {monitors.map((monitor) => {
                const isUp = monitor.status === "UP";
                const isDown = monitor.status === "DOWN";
                return (
                  <div
                    key={monitor.id}
                    className="p-4 flex items-center justify-between gap-4 hover:bg-accent/40 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-foreground truncate">
                          {monitor.name}
                        </span>
                        <a
                          href={monitor.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                      {/* Uptime/latency values carry the cyan emphasis — this
                          preview mirrors the public status surface (UI-SPEC
                          reserved accent item 2). */}
                      <div className="flex items-center gap-3 mt-1 text-xs font-mono text-muted-meta">
                        <span className="flex items-center gap-1">
                          <Activity className="w-3 h-3" />
                          <span className="text-accent-cyan" data-testid="status-uptime-value">
                            {monitor.uptimePercent?.toFixed(2) ?? "100.00"}% uptime
                          </span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <span className="text-accent-cyan" data-testid="status-latency-value">
                            {monitor.responseTime ?? 0}ms
                          </span>
                        </span>
                      </div>
                    </div>
                    <span
                      data-testid="status-preview-badge"
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border flex-shrink-0 transition-colors duration-200 ${
                        isUp
                          ? "bg-status-up/10 text-status-up border-status-up/30"
                          : isDown
                          ? "bg-status-down/10 text-status-down border-status-down/30"
                          : "border-border bg-muted text-muted-foreground"
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          isUp
                            ? "bg-status-up animate-status-pulse"
                            : isDown
                            ? "bg-status-down animate-alert-pulse"
                            : "bg-muted-foreground/50 animate-pulse"
                        }`}
                      />
                      {isUp ? "ONLINE" : isDown ? "OFFLINE" : "PENDING"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
