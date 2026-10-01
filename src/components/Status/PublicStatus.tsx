"use client";

import React, { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Activity01Icon as Activity, Alert01Icon as AlertTriangle, CheckmarkCircle02Icon as CheckCircle2, Clock01Icon as Clock, LinkSquare01Icon as ExternalLink, GlobeIcon as Globe, CancelCircleIcon as XCircle } from "hugeicons-react";
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

interface Incident {
  id: string;
  status: string;
  description: string | null;
  startedAt: string;
  monitor: { name: string };
}

interface StatusData {
  user: { id: string; name: string | null };
  monitors: Monitor[];
  recentIncidents: Incident[];
}

export function PublicStatus() {
  const params = useParams();
  const id = params.id as string; // Changed from userId to id

  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // UI-04 abort seam: the ref holds the active read's controller; unmount
  // (or an id change) aborts it so no in-flight fetch — and no post-abort
  // state write — outlives navigation.
  const publicStatusAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // New controller per pass (06-01 check-now abort pattern): signal on the
    // fetch, aborted re-check after each await before setState, unmount
    // aborts via the ref. This surface reads once per id (no interval) —
    // the abort discipline still applies to the load fetch.
    const abort = new AbortController();
    publicStatusAbortRef.current = abort;
    const fetchData = async () => {
      try {
        const res = await fetch(`/api/status/${id}`, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        if (res.status === 404) { setNotFound(true); return; }
        if (!res.ok) throw new Error("Failed to fetch");
        const data = await res.json();
        if (abort.signal.aborted) return;
        setData(data);
      } catch {
        if (abort.signal.aborted) return;
        setNotFound(true);
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    if (id) fetchData();
    return () => abort.abort();
  }, [id]);

  if (loading) {
    // Skeleton mirrors the loaded layout (D-28, UI-SPEC loading rows — the
    // public status spinner+text loader retired with the 08-09 tier-2 sweep).
    return (
      <div
        className="max-w-3xl mx-auto px-4 py-10 space-y-8 min-h-[80vh]"
        data-testid="public-status-skeleton"
      >
        <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-4">
          <Skeleton className="size-16 rounded-full mx-auto" />
          <Skeleton className="h-7 w-72 mx-auto" />
          <Skeleton className="h-4 w-56 mx-auto" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <div className="rounded-2xl border border-border divide-y divide-border">
            {[0, 1, 2].map((i) => (
              <div key={i} className="p-4 sm:p-5 flex items-center justify-between gap-4">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-6 w-24 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center text-center px-4">
        <div className="space-y-4">
          <Globe className="w-12 h-12 text-muted-foreground mx-auto" />
          <h1 className="text-[28px] font-semibold text-foreground">Status Page Not Found</h1>
          <p className="text-muted-foreground text-sm">This status page does not exist or has been removed.</p>
        </div>
      </div>
    );
  }

  const { user, monitors, recentIncidents } = data;
  const allUp = monitors.every((m) => m.status === "UP");
  const anyDown = monitors.some((m) => m.status === "DOWN");
  const ownerName = user.name ?? "SpiderNode User";

  return (
    <div className="text-foreground">
      {/* Top nav bar (only if we want an extra header, but since this is in commonLayout, the main Navbar is already there. So let's just make it a clean header inside the content) */}
      <div className="border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-card border border-primary/50 flex items-center justify-center">
              <Activity className="w-4 h-4 text-primary" />
            </div>
            <span className="font-semibold text-foreground text-sm">SpiderNode</span>
          </div>
          <span className="text-xs text-muted-meta font-mono">{ownerName}&apos;s Status Page</span>
        </div>
      </div>

      <main className="max-w-3xl mx-auto px-4 py-10 space-y-8 min-h-[80vh]">

        {/* Overall Status Banner */}
        <div
          className={`rounded-2xl border p-6 text-center ${
            anyDown
              ? "border-status-down/40 bg-status-down/5"
              : "border-status-up/30 bg-status-up/5"
          }`}
        >
          <div
            className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 transition-colors duration-200 ${
              anyDown ? "bg-status-down/20 text-status-down" : "bg-status-up/20 text-status-up"
            }`}
          >
            {anyDown ? <XCircle className="w-8 h-8" /> : <CheckCircle2 className="w-8 h-8" />}
          </div>
          <h1
            className={`text-[28px] font-semibold font-mono leading-tight mb-1 transition-colors duration-200 ${
              anyDown ? "text-status-down" : "text-status-up"
            }`}
          >
            {anyDown
              ? "PARTIAL OUTAGE"
              : allUp
              ? "ALL SYSTEMS OPERATIONAL"
              : "MONITORING..."}
          </h1>
          <p className="text-sm text-muted-foreground">
            {monitors.length} service{monitors.length !== 1 ? "s" : ""} monitored ·{" "}
            {monitors.filter((m) => m.status === "UP").length} online ·{" "}
            {monitors.filter((m) => m.status === "DOWN").length} down
          </p>
          <p className="text-xs text-muted-meta mt-3 font-mono">
            Last updated: {new Date().toLocaleString()}
          </p>
        </div>

        {/* Active Incidents */}
        {recentIncidents.length > 0 && (
          <div className="space-y-3">
            <h2 className="font-mono text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-status-down" />
              Active Incidents
            </h2>
            {recentIncidents.map((incident) => (
              <div
                key={incident.id}
                className="rounded-xl border border-status-down/30 bg-status-down/5 p-4 flex items-start gap-3"
              >
                <div className="w-2 h-2 rounded-full bg-status-down animate-ping mt-1.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-status-down">{incident.monitor.name} is down</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{incident.description || "Service is unreachable."}</p>
                  <p className="text-xs text-muted-meta mt-1 font-mono flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Since {new Date(incident.startedAt).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Services */}
        <div className="space-y-3">
          <h2 className="font-mono text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Globe className="w-4 h-4 text-muted-foreground" />
            Services
          </h2>
          {monitors.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card p-8 text-center text-muted-foreground text-sm">
              No services are currently being monitored.
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-card overflow-hidden divide-y divide-border">
              {monitors.map((monitor) => {
                const isUp = monitor.status === "UP";
                const isDown = monitor.status === "DOWN";
                return (
                  <div
                    key={monitor.id}
                    className="p-4 sm:p-5 flex items-center justify-between gap-4 hover:bg-accent/40 transition-colors"
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
                          className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                      {/* Uptime/latency values carry the cyan emphasis (UI-SPEC
                          reserved accent item 2) — the light-mode cyan text
                          variant applies automatically through the token. */}
                      <div className="flex items-center gap-3 mt-1 text-xs font-mono text-muted-meta">
                        <span className="flex items-center gap-1">
                          <Activity className="w-3 h-3" />
                          <span className="text-accent-cyan" data-testid="public-uptime-value">
                            {monitor.uptimePercent?.toFixed(2) ?? "100.00"}%
                          </span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <span className="text-accent-cyan" data-testid="public-latency-value">
                            {monitor.responseTime ?? 0}ms
                          </span>
                        </span>
                        {monitor.lastChecked && (
                          <span>
                            checked {new Date(monitor.lastChecked).toLocaleTimeString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <span
                      data-testid="public-status-badge"
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
                      {isUp ? "Operational" : isDown ? "Down" : "Pending"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-muted-meta font-mono pb-4">
          Powered by{" "}
          <span className="text-primary font-semibold">SpiderNode</span> — Real-time Uptime Monitoring
        </div>
      </main>
    </div>
  );
}
