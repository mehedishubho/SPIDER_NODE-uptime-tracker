"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { useAuthSession } from "@/lib/auth-client";
import { useRouter, useParams } from "next/navigation";
import { toast } from "sonner";
import { Activity01Icon as Activity, ArrowLeft01Icon as ArrowLeft, Clock01Icon as Clock, GlobeIcon as Globe, Loading01Icon as Loader2, Alert01Icon as AlertTriangle, CheckmarkCircle02Icon as CheckCircle2, CancelCircleIcon as XCircle, ArrowUpRight01Icon as TrendingUp, ServerStack01Icon as ServerCrash } from "hugeicons-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

interface Ping {
  id: string;
  status: string;
  responseTime: number;
  createdAt: string;
}

interface Incident {
  id: string;
  status: string;
  description: string;
  startedAt: string;
  resolvedAt: string | null;
}

interface MonitorDetails {
  id: number;
  name: string;
  url: string;
  status: string;
  lastChecked: string | null;
  createdAt: string;
  isActive: boolean;
  interval: number;
  responseTime: number;
  uptimePercent: number;
  pings: Ping[];
  incidents: Incident[];
}

export function MonitorDetails() {
  const { data: session, isPending } = useAuthSession();
  const status = isPending ? "loading" : session ? "authenticated" : "unauthenticated";
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [monitor, setMonitor] = useState<MonitorDetails | null>(null);
  const [loading, setLoading] = useState(true);

  // UI-04 abort seam: the ref holds the controller of the latest
  // fetchDetails pass; unmount aborts it so no in-flight details fetch —
  // and no post-abort error toast or console noise — outlives navigation.
  const detailsPollAbortRef = useRef<AbortController | null>(null);

  // Protect route
  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login?callbackUrl=/dashboard/monitor/" + id);
    }
  }, [status, router, id]);

  const fetchDetails = useCallback(async () => {
    // New controller per pass (06-01 check-now abort pattern): signal on the
    // fetch, aborted re-check after each await before setState, unmount
    // aborts the latest pass via the ref.
    const abort = new AbortController();
    detailsPollAbortRef.current = abort;
    try {
      const res = await fetch(`/api/monitors/${id}/details`, {
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      if (!res.ok) {
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        if (res.status === 404) {
          toast.error("Monitor not found");
          router.push("/dashboard");
          return;
        }
        throw new Error("Failed to fetch monitor details");
      }
      const data = await res.json();
      if (abort.signal.aborted) return;
      setMonitor(data.monitor);
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error(err);
      toast.error("Failed to load details.");
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    if (status === "authenticated" && id) {
      fetchDetails();

      const interval = setInterval(() => {
        fetchDetails();
      }, 30000); // 30s refresh

      // UI-04: unmount aborts any in-flight details fetch — no late
      // setState and no aborted-rejection noise outlives the component.
      return () => {
        clearInterval(interval);
        detailsPollAbortRef.current?.abort();
      };
    }
  }, [status, id, fetchDetails]);

  if (status === "loading" || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-8 animate-spin text-primary" />
          <span className="font-mono text-xs text-muted-foreground">
            Loading Monitor Data...
          </span>
        </div>
      </div>
    );
  }

  if (!monitor) return null;

  // Chart preparation
  // Reverse pings to show oldest to newest (left to right)
  const chartPings = [...monitor.pings].reverse().slice(-50); // Show last 50

  return (
    <div className="min-h-screen bg-background p-4 text-foreground sm:p-6 lg:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">

        {/* Top Header */}
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="icon"
              asChild
              aria-label="Back to dashboard"
            >
              <Link href="/dashboard">
                <ArrowLeft className="size-5" />
              </Link>
            </Button>
            <div className="min-w-0">
              <h1
                title={monitor.name}
                className="flex min-w-0 items-center gap-3 text-lg font-semibold text-foreground"
              >
                <span className="truncate">{monitor.name}</span>
                <span
                  data-testid="detail-status-badge"
                  className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-xs font-semibold ${
                    !monitor.isActive
                      ? "border-border bg-muted text-muted-foreground"
                      : monitor.status === "UP"
                      ? "border-status-up/30 bg-status-up/10 text-status-up"
                      : monitor.status === "DOWN"
                      ? "border-status-down/30 bg-status-down/10 text-status-down"
                      : "border-border bg-muted text-muted-foreground"
                  }`}
                >
                  <span
                    className={`size-2 rounded-full ${
                      !monitor.isActive
                        ? "bg-muted-foreground/50"
                        : monitor.status === "UP"
                        ? "bg-status-up animate-status-pulse"
                        : "bg-status-down"
                    }`}
                  />
                  {!monitor.isActive ? "PAUSED" : monitor.status}
                </span>
              </h1>
              <a
                href={monitor.url}
                target="_blank"
                rel="noreferrer"
                title={monitor.url}
                className="mt-1 flex max-w-md items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Globe className="size-3.5 shrink-0" />
                <span className="truncate">{monitor.url}</span>
              </a>
            </div>
          </div>

          <div className="flex items-center gap-6 rounded-xl border border-border bg-secondary/50 p-3 text-sm">
            <div className="flex flex-col">
              <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                Check Interval
              </span>
              <span className="font-mono text-foreground">{monitor.interval} minutes</span>
            </div>
            <Separator orientation="vertical" className="h-8" />
            <div className="flex flex-col">
              <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                Last Checked
              </span>
              <span className="font-mono text-foreground">
                {monitor.lastChecked ? new Date(monitor.lastChecked).toLocaleTimeString() : "Never"}
              </span>
            </div>
          </div>
        </div>

        {/* Metrics Overview */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="gap-2 py-5">
            <CardHeader className="px-5">
              <CardDescription className="flex items-center justify-between text-xs font-mono uppercase tracking-wider">
                <span>OVERALL UPTIME</span>
                <Activity className="size-4 text-muted-foreground" aria-hidden />
              </CardDescription>
              <CardTitle
                data-testid="detail-uptime"
                className={`font-mono text-[28px] font-semibold leading-tight ${
                  monitor.uptimePercent < 95 ? "text-status-down" : "text-status-up"
                }`}
              >
                {monitor.uptimePercent ? monitor.uptimePercent.toFixed(2) : 100}%
              </CardTitle>
            </CardHeader>
          </Card>

          <Card className="gap-2 py-5">
            <CardHeader className="px-5">
              <CardDescription className="flex items-center justify-between text-xs font-mono uppercase tracking-wider">
                <span>AVG RESPONSE TIME</span>
                <TrendingUp className="size-4 text-muted-foreground" aria-hidden />
              </CardDescription>
              <CardTitle
                data-testid="detail-latency"
                className="font-mono text-[28px] font-semibold leading-tight text-foreground"
              >
                {monitor.responseTime || 0}ms
              </CardTitle>
            </CardHeader>
          </Card>

          <Card className="gap-2 py-5">
            <CardHeader className="px-5">
              <CardDescription className="flex items-center justify-between text-xs font-mono uppercase tracking-wider">
                <span>TOTAL INCIDENTS</span>
                <AlertTriangle className="size-4 text-muted-foreground" aria-hidden />
              </CardDescription>
              <CardTitle
                data-testid="detail-incidents"
                className="font-mono text-[28px] font-semibold leading-tight text-accent-gold"
              >
                {monitor.incidents.length}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        {/* Response Time Chart (Bar Chart visualization) */}
        <Card className="gap-4 py-5">
          <CardHeader className="px-5">
            <CardTitle className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <Activity className="size-5 text-muted-foreground" aria-hidden />
              Response Time History (Last 50 checks)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5">
            <div className="relative flex h-48 w-full items-end gap-1 overflow-hidden border-b border-border pb-2">
              {chartPings.length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center font-mono text-xs text-muted-foreground">
                  No ping data available yet.
                </div>
              ) : (
                chartPings.map((ping) => {
                  // max height for 1000ms
                  const heightPercent = Math.min(100, Math.max(5, (ping.responseTime / 1000) * 100));
                  const isDown = ping.status === "DOWN";

                  return (
                    <div
                      key={ping.id}
                      title={`${ping.responseTime}ms at ${new Date(ping.createdAt).toLocaleTimeString()}`}
                      className={`group relative min-w-[4px] flex-1 cursor-crosshair rounded-t-sm transition-all hover:opacity-80 ${
                        // Status-colored data rides the status tokens: DOWN
                        // bars status-down, UP bars status-up (primary red is
                        // reserved for CTAs/brand per the UI-SPEC Color row).
                        isDown ? "bg-status-down" : "bg-status-up"
                      }`}
                      style={{ height: `${isDown ? 10 : heightPercent}%` }}
                    >
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded border border-border bg-popover px-2 py-1 text-xs text-popover-foreground opacity-0 transition-opacity group-hover:opacity-100">
                        {isDown ? "OFFLINE" : `${ping.responseTime}ms`}
                        <div className="mt-0.5 text-xs text-muted-foreground">{new Date(ping.createdAt).toLocaleTimeString()}</div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </CardContent>
        </Card>

        {/* Incident History — Card composition; the block structure (icon +
            title + description + started/resolved timestamps + ACTIVE/
            RESOLVED badge) is the 08-07 post-mortem mount point and stays */}
        <Card className="gap-0 py-0">
          <CardHeader className="p-4 sm:p-6">
            <CardTitle className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <ServerCrash className="size-5 text-muted-foreground" aria-hidden />
              Incident History
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Recent downtime events and their duration.
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="p-0">
            {monitor.incidents.length === 0 ? (
              <div className="flex flex-col items-center gap-3 p-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-full border border-border bg-secondary text-status-up">
                  <CheckCircle2 className="size-6" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">Clean History</h3>
                <p className="text-xs text-muted-foreground">
                  No incidents recorded for this monitor.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4 p-4 sm:p-6">
                {monitor.incidents.map((incident) => {
                  const isOngoing = incident.status === "ONGOING";

                  return (
                    <Card key={incident.id} data-testid="incident-block" className="gap-3 py-4">
                      <CardHeader className="gap-2 px-4">
                        <CardTitle className="flex items-center gap-3 text-sm font-semibold text-foreground">
                          <span
                            className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
                              isOngoing
                                ? "bg-status-down/10 text-status-down"
                                : "bg-status-up/10 text-status-up"
                            }`}
                          >
                            {isOngoing ? <XCircle className="size-4" /> : <CheckCircle2 className="size-4" />}
                          </span>
                          {isOngoing ? "Downtime Ongoing" : "Downtime Resolved"}
                        </CardTitle>
                        <CardDescription className="line-clamp-2 text-xs text-muted-foreground">
                          {incident.description || "Connection timeout or invalid status code."}
                        </CardDescription>
                        <CardAction>
                          <span
                            data-testid="incident-status-badge"
                            className={`inline-flex items-center rounded border px-2.5 py-1 font-mono text-xs font-semibold tracking-wider ${
                              isOngoing
                                ? "border-status-down/30 bg-status-down/10 text-status-down"
                                : "border-status-up/30 bg-status-up/10 text-status-up"
                            }`}
                          >
                            {isOngoing ? "ACTIVE" : "RESOLVED"}
                          </span>
                        </CardAction>
                      </CardHeader>
                      <CardContent className="flex flex-wrap items-center gap-4 px-4 font-mono text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <Clock className="size-3" />
                          Started: {new Date(incident.startedAt).toLocaleString()}
                        </span>
                        {!isOngoing && incident.resolvedAt && (
                          <span className="flex items-center gap-1.5 text-status-up">
                            <Activity className="size-3" />
                            Resolved: {new Date(incident.resolvedAt).toLocaleString()}
                          </span>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
