"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useAuthSession } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion, useReducedMotion } from "motion/react";
import { Alert01Icon as AlertTriangle, CheckmarkCircle02Icon as CheckCircle2, Clock01Icon as Clock, RefreshIcon as RefreshCw, ServerStack01Icon as ServerCrash, Shield01Icon as ShieldCheck, CancelCircleIcon as XCircle, Activity01Icon as Activity, LinkSquare01Icon as ExternalLink } from "hugeicons-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";

interface Monitor {
  id: number;
  name: string;
  url: string;
  status: string;
}

interface Incident {
  id: string;
  status: string;
  description: string | null;
  startedAt: string;
  resolvedAt: string | null;
  monitor: Monitor;
}

export function Incidents() {
  const { data, isPending } = useAuthSession();
  const status = isPending ? "loading" : data ? "authenticated" : "unauthenticated";
  const router = useRouter();
  const reduceMotion = useReducedMotion();

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login?callbackUrl=/dashboard/incidents");
    }
  }, [status, router]);

  const fetchIncidents = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch("/api/incidents");
      if (!res.ok) {
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        throw new Error("Failed to fetch incidents");
      }
      const data = await res.json();
      setIncidents(data.incidents || []);
    } catch (err) {
      console.error(err);
      toast.error("Failed to load incidents.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    if (status === "authenticated") {
      fetchIncidents();
    }
  }, [status, fetchIncidents]);

  if (status === "loading" || loading) {
    // Skeleton mirrors the loaded layout (D-28, UI-SPEC loading rows — the
    // shared tier-2 treatment, same pattern as tier-1 in 08-04).
    return (
      <div className="min-h-screen bg-background p-4 sm:p-6">
        <div className="max-w-5xl mx-auto space-y-6" data-testid="incidents-skeleton">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-6 w-44" />
              <Skeleton className="h-3 w-72" />
            </div>
            <Skeleton className="size-9 rounded-xl" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      </div>
    );
  }

  const ongoingIncidents = incidents.filter((i) => i.status === "ONGOING");
  const resolvedIncidents = incidents.filter((i) => i.status === "RESOLVED");

  const formatDuration = (start: string, end: string | null) => {
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date();
    const diffMs = endDate.getTime() - startDate.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m`;
    const diffHrs = Math.floor(diffMins / 60);
    const remainMins = diffMins % 60;
    if (diffHrs < 24) return `${diffHrs}h ${remainMins}m`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays}d ${diffHrs % 24}h`;
  };

  return (
    <div className="min-h-screen bg-background text-foreground p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground flex items-center gap-3">
              <ServerCrash className="w-6 h-6 text-primary" />
              Incident Log
            </h1>
            <p className="text-xs text-muted-meta mt-1 font-mono">
              Downtime events and resolutions across all your monitors
            </p>
          </div>
          <button
            onClick={() => fetchIncidents(true)}
            disabled={refreshing}
            className="p-2 rounded-xl bg-secondary hover:bg-accent border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer self-start sm:self-auto"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin text-primary" : ""}`} />
          </button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="glass-panel p-5 rounded-2xl border border-border">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs font-mono">TOTAL INCIDENTS</span>
              <AlertTriangle className="w-4 h-4 text-accent-gold" />
            </div>
            <div className="font-mono text-[28px] font-semibold leading-tight text-foreground">{incidents.length}</div>
            <p className="text-xs text-muted-foreground mt-1">All time</p>
          </div>

          <div className="glass-panel p-5 rounded-2xl border border-status-down/20">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs font-mono">ACTIVE NOW</span>
              <XCircle className="w-4 h-4 text-status-down" />
            </div>
            <div className="font-mono text-[28px] font-semibold leading-tight text-status-down">
              {ongoingIncidents.length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Ongoing outages</p>
          </div>

          <div className="glass-panel p-5 rounded-2xl border border-border">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs font-mono">RESOLVED</span>
              <ShieldCheck className="w-4 h-4 text-status-up" />
            </div>
            <div className="font-mono text-[28px] font-semibold leading-tight text-status-up">
              {resolvedIncidents.length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Successfully recovered</p>
          </div>
        </div>

        {/* Active Incidents Alert Banner */}
        {ongoingIncidents.length > 0 && (
          <div className="glass-panel rounded-2xl border border-status-down/40 p-4 flex items-center gap-3 bg-status-down/5">
            <div className="w-2 h-2 rounded-full bg-status-down animate-ping flex-shrink-0" />
            <p className="text-sm text-status-down font-medium">
              <span className="font-semibold">{ongoingIncidents.length} active incident{ongoingIncidents.length > 1 ? "s" : ""}</span>
              {" "}— your team has been notified via Telegram if configured.
            </p>
          </div>
        )}

        {/* Incidents List */}
        {incidents.length === 0 ? (
          <div className="glass-panel rounded-2xl border border-border p-16 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-status-up/10 border border-status-up/30 text-status-up flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">All Clear!</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              No incidents recorded yet. Your monitors are healthy and running smoothly.
            </p>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 mt-2 px-4 py-2 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition-all"
            >
              <Activity className="w-3.5 h-3.5" />
              View Monitors
            </Link>
          </div>
        ) : (
          <div className="glass-panel rounded-2xl border border-border overflow-hidden">
            <div className="p-4 sm:p-6 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">Incident Timeline</h2>
            </div>
            <div className="divide-y divide-border">
              {incidents.map((incident, index) => {
                const isOngoing = incident.status === "ONGOING";
                return (
                  <motion.div
                    key={incident.id}
                    className="p-4 sm:p-6 hover:bg-accent/40 transition-colors"
                    initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.25,
                      ease: "easeOut",
                      // 50ms stagger per item, capped at 8 (D-28 tier-2
                      // micro-interaction — same discipline as tier-1 08-04).
                      delay: reduceMotion ? 0 : Math.min(index, 8) * 0.05,
                    }}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-4 min-w-0">
                        <div
                          className={`mt-0.5 w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-colors duration-200 ${
                            isOngoing
                              ? "bg-status-down/10 text-status-down"
                              : "bg-status-up/10 text-status-up"
                          }`}
                        >
                          {isOngoing ? (
                            <XCircle className="w-4 h-4" />
                          ) : (
                            <CheckCircle2 className="w-4 h-4" />
                          )}
                        </div>
                        <div className="min-w-0">
                          {/* Monitor name + link — hover carries the cyan
                              emphasis (UI-SPEC reserved accent item 3). */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <Link
                              href={`/dashboard/monitor/${incident.monitor.id}`}
                              className="text-sm font-semibold text-foreground hover:text-accent-cyan transition-colors truncate"
                            >
                              {incident.monitor.name}
                            </Link>
                            <a
                              href={incident.monitor.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>

                          <p className="text-xs text-muted-foreground mt-1">
                            {incident.description || "Connection timeout or invalid status code."}
                          </p>

                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs font-mono text-muted-meta">
                            <span className="flex items-center gap-1.5">
                              <Clock className="w-3 h-3 text-muted-meta" />
                              Started: {new Date(incident.startedAt).toLocaleString()}
                            </span>
                            {!isOngoing && incident.resolvedAt && (
                              <span className="flex items-center gap-1.5 text-status-up/80">
                                <CheckCircle2 className="w-3 h-3" />
                                Resolved: {new Date(incident.resolvedAt).toLocaleString()}
                              </span>
                            )}
                            <span className="flex items-center gap-1.5 text-accent-gold/80">
                              <AlertTriangle className="w-3 h-3" />
                              Duration: {formatDuration(incident.startedAt, incident.resolvedAt)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Status badge */}
                      <span
                        data-testid="incident-badge"
                        className={`px-2.5 py-1 rounded-full border text-xs font-semibold tracking-wider flex-shrink-0 transition-colors duration-200 ${
                          isOngoing
                            ? "bg-status-down/10 border-status-down/30 text-status-down animate-pulse"
                            : "bg-status-up/10 border-status-up/30 text-status-up"
                        }`}
                      >
                        {isOngoing ? "ACTIVE" : "RESOLVED"}
                      </span>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
