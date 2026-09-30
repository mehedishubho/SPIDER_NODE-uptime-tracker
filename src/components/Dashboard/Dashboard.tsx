"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { authClient, useAuthSession } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { pollMonitorCheckResult } from "@/lib/check-now-poll";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PlusSignIcon as Plus, RefreshIcon as RefreshCw, Delete02Icon as Trash2, LinkSquare01Icon as ExternalLink, Logout01Icon as LogOut, GlobeIcon as Globe, Clock01Icon as Clock, Loading01Icon as Loader2, Edit02Icon as Edit2, EcoPowerIcon as Power, MoreVerticalIcon as MoreVertical } from "hugeicons-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatsSummaryHeader } from "./StatsSummaryHeader";

interface Monitor {
  id: number;
  name: string;
  url: string;
  status: string; // 'UP' | 'DOWN' | 'UNKNOWN' | 'PENDING'
  lastChecked: string | null;
  createdAt: string;
  isActive: boolean;
  interval: number;
  responseTime: number;
  uptimePercent: number;
}

export function Dashboard() {
  const { data: session, isPending } = useAuthSession();
  const status = isPending ? "loading" : session ? "authenticated" : "unauthenticated";
  const router = useRouter();
  // D-28: prefers-reduced-motion gates every entrance animation on this
  // surface — reduced-motion users mount directly in the final state.
  const reduceMotion = useReducedMotion();

  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [loadingMonitors, setLoadingMonitors] = useState(true);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  // Delete-confirm dialog: the pending monitor (id + name) the open
  // alert-dialog targets — null = closed. The DELETE fetch fires only from
  // the dialog's confirm action (UI-SPEC destructive-confirmation contract).
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);

  // Add Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newMonitorName, setNewMonitorName] = useState("");
  const [newMonitorUrl, setNewMonitorUrl] = useState("");
  const [newMonitorInterval, setNewMonitorInterval] = useState(5);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Edit Modal State
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingMonitor, setEditingMonitor] = useState<Monitor | null>(null);
  const [editMonitorName, setEditMonitorName] = useState("");
  const [editMonitorUrl, setEditMonitorUrl] = useState("");
  const [editMonitorInterval, setEditMonitorInterval] = useState(5);
  const [isUpdating, setIsUpdating] = useState(false);

  // Protect route
  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login?callbackUrl=/dashboard");
    }
  }, [status, router]);

  // UI-04 abort seams: every fetch this component starts is abortable and
  // aborted on unmount, so no in-flight request — and no post-abort error
  // toast or console noise — outlives navigation. The monitors-poll ref
  // holds the controller of the latest fetchMonitors pass; the action ref
  // covers the mutation/check handlers. Catches treat an aborted rejection
  // as a silent no-op (the robustness spec pins zero console errors on
  // navigate-away).
  const monitorsPollAbortRef = useRef<AbortController | null>(null);
  const actionAbortRef = useRef<AbortController | null>(null);

  // Fetch monitors — returns the list so the check-now poll can reuse the
  // same read (D-01: poll monitor data, never job state).
  const fetchMonitors = useCallback(async (): Promise<Monitor[]> => {
    // New controller per pass (06-01 check-now abort pattern): signal on the
    // fetch, aborted re-check after each await before setState, unmount
    // aborts the latest pass via the ref.
    const abort = new AbortController();
    monitorsPollAbortRef.current = abort;
    try {
      const res = await fetch("/api/monitors", { signal: abort.signal });
      if (abort.signal.aborted) return [];
      if (!res.ok) {
        if (res.status === 401) {
          router.push("/login");
          return [];
        }
        let errorMsg = "Failed to fetch monitors";
        try {
          const errData = await res.json();
          if (errData.details) errorMsg += `: ${errData.details}`;
        } catch {
          // Non-JSON error body — the generic message stands.
        }
        throw new Error(errorMsg);
      }
      const data = await res.json();
      if (abort.signal.aborted) return [];
      const list: Monitor[] = data.monitors || [];
      setMonitors(list);
      return list;
    } catch (err) {
      if (abort.signal.aborted) return [];
      console.error(err);
      toast.error("Failed to load monitors.");
      return [];
    } finally {
      if (!abort.signal.aborted) setLoadingMonitors(false);
    }
  }, [router]);

  useEffect(() => {
    if (status === "authenticated") {
      fetchMonitors();

      // Auto-refresh every 30 seconds
      const interval = setInterval(() => {
        fetchMonitors();
      }, 30000);

      // UI-04: unmount aborts any in-flight poll pass — no fetch, no late
      // setState, and no aborted-rejection noise outlives the component.
      return () => {
        clearInterval(interval);
        monitorsPollAbortRef.current?.abort();
      };
    }
  }, [status, fetchMonitors]);

  // Create Monitor
  const handleCreateMonitor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMonitorName.trim() || !newMonitorUrl.trim()) {
      toast.error("Please provide both name and URL.");
      return;
    }

    setIsSubmitting(true);
    const abort = new AbortController();
    actionAbortRef.current = abort;
    try {
      const res = await fetch("/api/monitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newMonitorName,
          url: newMonitorUrl,
          interval: newMonitorInterval,
        }),
        signal: abort.signal,
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to create monitor.");
        return;
      }

      toast.success("Monitor added successfully!");
      setNewMonitorName("");
      setNewMonitorUrl("");
      setNewMonitorInterval(5);
      setIsAddModalOpen(false);
      fetchMonitors();
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error(err);
      toast.error("An error occurred while creating monitor.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Open Edit Modal
  const openEditModal = (monitor: Monitor) => {
    setEditingMonitor(monitor);
    setEditMonitorName(monitor.name);
    setEditMonitorUrl(monitor.url);
    setEditMonitorInterval(monitor.interval || 5);
    setIsEditModalOpen(true);
  };

  // Update Monitor
  const handleEditMonitor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMonitor) return;

    if (!editMonitorName.trim() || !editMonitorUrl.trim()) {
      toast.error("Please provide both name and URL.");
      return;
    }

    setIsUpdating(true);
    const abort = new AbortController();
    actionAbortRef.current = abort;
    try {
      const res = await fetch(`/api/monitors/${editingMonitor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editMonitorName,
          url: editMonitorUrl,
          interval: editMonitorInterval,
        }),
        signal: abort.signal,
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to update monitor.");
        return;
      }

      toast.success("Monitor updated successfully!");
      setIsEditModalOpen(false);
      setEditingMonitor(null);
      fetchMonitors();
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error(err);
      toast.error("An error occurred while updating monitor.");
    } finally {
      setIsUpdating(false);
    }
  };

  // Abort any in-flight check poll or action fetch on unmount — neither the
  // poll loop nor a request may ever outlive the component (UI-SPEC timer
  // discipline, UI-04 abort seams).
  const checkPollAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      checkPollAbortRef.current?.abort();
      actionAbortRef.current?.abort();
    };
  }, []);

  // Re-check single monitor status: enqueue + 202 + poll (D-01..D-06). The
  // route never executes the check; this handler never reads job state —
  // completion is the row's lastChecked advancing past the enqueue time.
  const handleCheckMonitor = async (id: number) => {
    setCheckingId(id);
    const abort = new AbortController();
    checkPollAbortRef.current = abort;
    try {
      const res = await fetch(`/api/monitors/${id}/check`, {
        method: "POST",
        signal: abort.signal,
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After")) || 30;
        toast.error(`You're checking too often — try again in ${retryAfter}s`);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}) as { error?: string });
        toast.error(data.error || "Failed to ping monitor.");
        return;
      }
      const { queuedAt } = (await res.json()) as { jobId: string; queuedAt: number };
      const monitor = await pollMonitorCheckResult<Monitor>({
        monitorId: id,
        queuedAt,
        fetchMonitors,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      if (!monitor) {
        // D-04 quiet handoff: the job may still land — never an error, never
        // a re-enqueue; the periodic refresh surfaces the result.
        toast.info("Still checking — the result will appear when ready");
        return;
      }
      if (monitor.status === "DOWN") {
        toast.error(`${monitor.name}: DOWN (${monitor.responseTime}ms)`);
      } else {
        toast.success(`${monitor.name}: UP (${monitor.responseTime}ms)`);
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error(err);
      toast.error("Error pinging monitor.");
    } finally {
      setCheckingId(null);
    }
  };

  // Toggle Active Status
  const handleToggleActive = async (monitor: Monitor) => {
    setTogglingId(monitor.id);
    const abort = new AbortController();
    actionAbortRef.current = abort;
    try {
      const res = await fetch(`/api/monitors/${monitor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isActive: !monitor.isActive,
        }),
        signal: abort.signal,
      });

      if (res.ok) {
        toast.success(monitor.isActive ? "Monitor paused" : "Monitor resumed");
        fetchMonitors();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to toggle monitor.");
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error(err);
      toast.error("Error toggling monitor.");
    } finally {
      setTogglingId(null);
    }
  };

  // Delete monitor — invoked ONLY by the confirm action of the delete
  // alert-dialog (the native confirm call retired with UI-02/D-34).
  const handleDeleteMonitor = async (id: number, name: string) => {
    setDeletingId(id);
    const abort = new AbortController();
    actionAbortRef.current = abort;
    try {
      const res = await fetch(`/api/monitors/${id}`, {
        method: "DELETE",
        signal: abort.signal,
      });
      if (res.ok) {
        toast.success(`Monitor "${name}" deleted.`);
        setMonitors((prev) => prev.filter((m) => m.id !== id));
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete monitor.");
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error(err);
      toast.error("Error deleting monitor.");
    } finally {
      setDeletingId(null);
    }
  };

  if (
    status === "loading" ||
    (status === "unauthenticated" && loadingMonitors)
  ) {
    // Skeleton mirrors the loaded layout (D-28, UI-SPEC loading rows): stats
    // cards + the list-card shell — no spinner, no copy.
    return (
      <div className="min-h-screen bg-background p-4 text-foreground sm:p-6 lg:p-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-8" data-testid="dashboard-skeleton">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="gap-2 py-5">
                <CardHeader className="px-5">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-8 w-24" />
                </CardHeader>
                <CardContent className="px-5">
                  <Skeleton className="h-3 w-32" />
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="gap-0 py-0">
            <CardHeader className="p-4 sm:p-6">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-3 w-72" />
            </CardHeader>
            <Separator />
            <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-6 w-24 rounded-full" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="size-8" />
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Get User Initials fallback
  const userName = session?.user?.name || "Developer";
  const userEmail = session?.user?.email || "";
  const userImage = session?.user?.image;
  const userInitials = userName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .substring(0, 2)
    .toUpperCase();

  return (
    <div className="min-h-screen bg-background text-foreground p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        {/* Header Bar */}
        <div className="glass-panel flex flex-col items-start justify-between gap-4 rounded-2xl border border-border p-4 sm:flex-row sm:items-center sm:p-6">
          <div className="flex items-center gap-4">
            {userImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={userImage}
                alt={userName}
                className="size-12 rounded-xl object-cover ring-2 ring-primary/40"
              />
            ) : (
              <div className="red-glow flex size-12 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 font-mono text-lg font-semibold text-primary">
                {userInitials}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold text-foreground">{userName}</h1>
                <span className="rounded-md border border-primary/20 bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
                  PRO MONITOR
                </span>
              </div>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                {userEmail}
              </p>
            </div>
          </div>

          <div className="flex w-full items-center justify-end gap-3 sm:w-auto">
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/profile">Profile</Link>
            </Button>

            <Button size="sm" onClick={() => setIsAddModalOpen(true)}>
              <Plus className="size-4" />
              Add Monitor
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={async () => {
                await authClient.signOut();
                window.location.href = "/login";
              }}
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </Button>
          </div>
        </div>

        {/* Stats Summary Header (D-25) — aggregates of the loaded monitors */}
        <StatsSummaryHeader monitors={monitors} />

        {/* Monitor List Card (shadcn Card shell — denser 12px row rhythm,
            sticky column headers within the card, staggered row entrances) */}
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          <Card className="gap-0 py-0">
            <CardHeader className="p-4 sm:p-6">
              <CardTitle className="text-lg font-semibold text-foreground">
                Monitored Services
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground">
                Real-time HTTP health check monitors linked to your account
              </CardDescription>
              <CardAction>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={fetchMonitors}
                  disabled={loadingMonitors}
                  title="Refresh List"
                  aria-label="Refresh List"
                >
                  <RefreshCw
                    className={`size-4 ${loadingMonitors ? "animate-spin text-primary" : ""}`}
                  />
                </Button>
              </CardAction>
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              {loadingMonitors && monitors.length === 0 ? (
                // First list load renders skeleton rows shaped like the
                // loaded rows (D-28) — the spinner+text loader retired.
                <div className="flex flex-col gap-4 p-4 sm:p-6" data-testid="list-skeleton">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-4">
                      <Skeleton className="h-6 w-24 rounded-full" />
                      <div className="flex flex-1 flex-col gap-1.5">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-3 w-56" />
                      </div>
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="size-8" />
                    </div>
                  ))}
                </div>
              ) : monitors.length === 0 ? (
                <div className="flex flex-col items-center gap-3 p-12 text-center">
                  <div className="flex size-12 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground">
                    <Globe className="size-6" />
                  </div>
                  <h3 className="text-sm font-semibold text-foreground">
                    No Monitors Found
                  </h3>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    You haven&apos;t added any endpoints yet. Click &quot;Add
                    Monitor&quot; above to start tracking your website or API.
                  </p>
                  <Button
                    className="mt-2"
                    onClick={() => setIsAddModalOpen(true)}
                  >
                    + Add Your First Monitor
                  </Button>
                </div>
              ) : (
                <div className="overflow-x-auto sm:overflow-x-visible">
                  <table className="w-full text-left font-mono text-xs">
                    {/* Sticky column headers: top-16 clears the h-16 AppHeader;
                        overflow stays visible above sm so page scroll drives
                        the stickiness (overflow-x-auto is retained on small
                        viewports per the UI-SPEC). */}
                    <thead className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="sticky top-16 z-10 rounded-tl-xl border-b border-border bg-secondary px-4 py-3 sm:px-6">
                          Status &amp; Latency
                        </th>
                        <th className="sticky top-16 z-10 border-b border-border bg-secondary px-4 py-3 sm:px-6">
                          Site Name &amp; URL
                        </th>
                        <th className="sticky top-16 z-10 border-b border-border bg-secondary px-4 py-3 sm:px-6">
                          Uptime
                        </th>
                        <th className="sticky top-16 z-10 border-b border-border bg-secondary px-4 py-3 sm:px-6">
                          Last Checked
                        </th>
                        <th className="sticky top-16 z-10 rounded-tr-xl border-b border-border bg-secondary px-4 py-3 text-right sm:px-6">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {monitors.map((monitor, index) => {
                        const isActive = monitor.isActive;
                        const isUp = isActive && monitor.status === "UP";
                        const isDown = isActive && monitor.status === "DOWN";

                        const statusColor = isUp
                          ? "border-status-up/30 bg-status-up/10 text-status-up"
                          : isDown
                            ? "border-status-down/30 bg-status-down/10 text-status-down"
                            : "border-border bg-muted text-muted-foreground";
                        const dotColor = isUp
                          ? "bg-status-up animate-status-pulse"
                          : isDown
                            ? "bg-status-down animate-alert-pulse"
                            : "bg-muted-foreground/50";
                        const label = !isActive
                          ? "PAUSED"
                          : isUp
                            ? "ONLINE"
                            : isDown
                              ? "OFFLINE"
                              : "PENDING";

                        return (
                          <motion.tr
                            key={monitor.id}
                            data-testid="monitor-row"
                            className={`transition-colors hover:bg-accent/40 ${!isActive ? "opacity-60" : ""} ${isDown ? "border-l-4 border-l-status-down bg-status-down/5 shadow-[inset_4px_0_10px_rgba(239,68,68,0.1)]" : ""}`}
                            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{
                              duration: 0.25,
                              ease: "easeOut",
                              // 50ms stagger per item, capped at 8 — items past
                              // the cap share one delay and appear together.
                              delay: reduceMotion
                                ? 0
                                : Math.min(index, 8) * 0.05,
                            }}
                          >
                            {/* Status & Latency Badge */}
                            <td className="whitespace-nowrap px-4 py-3 sm:px-6">
                              <div className="flex items-center gap-2">
                                {/* Status-change crossfade (D-28): the pill
                                    swaps through a 200ms fade keyed on the
                                    status label; reduced motion swaps
                                    instantly (duration 0). */}
                                <AnimatePresence mode="wait" initial={false}>
                                  <motion.span
                                    key={label}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={{
                                      duration: reduceMotion ? 0 : 0.2,
                                    }}
                                    className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusColor}`}
                                  >
                                    <span
                                      className={`size-2 rounded-full ${dotColor}`}
                                    />
                                    {label}
                                  </motion.span>
                                </AnimatePresence>
                                {isActive && (
                                  <span
                                    className={`ml-1 font-mono text-xs transition-number ${isDown ? "text-status-down" : "text-muted-foreground"}`}
                                  >
                                    {monitor.responseTime || 0} ms
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* Site Name */}
                            <td className="px-4 py-3 sm:px-6">
                              <Link href={`/dashboard/monitor/${monitor.id}`}>
                                <span
                                  title={monitor.name}
                                  className="mb-1 block max-w-[240px] cursor-pointer truncate font-sans text-sm font-semibold text-foreground transition-colors hover:text-accent-cyan"
                                >
                                  {monitor.name}
                                </span>
                              </Link>
                              <a
                                href={monitor.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={monitor.url}
                                className="inline-flex max-w-[240px] items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                              >
                                <span className="truncate">{monitor.url}</span>
                                <ExternalLink className="size-3 shrink-0" />
                              </a>
                            </td>

                            {/* Uptime */}
                            <td className="px-4 py-3 sm:px-6">
                              <div
                                className={`font-semibold transition-number ${monitor.uptimePercent < 95 ? "text-status-down" : "text-status-up"}`}
                              >
                                {monitor.uptimePercent
                                  ? monitor.uptimePercent.toFixed(2)
                                  : 100}
                                %
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {monitor.interval || 5}m interval
                              </div>
                            </td>

                            {/* Last Checked */}
                            <td className="px-4 py-3 text-muted-foreground sm:px-6">
                              <span className="flex items-center gap-1.5">
                                <Clock className="size-3.5" />
                                {monitor.lastChecked
                                  ? new Date(
                                      monitor.lastChecked,
                                    ).toLocaleTimeString()
                                  : "Never"}
                              </span>
                            </td>

                            {/* Actions — dropdown-menu overflow (denser rows) */}
                            <td className="whitespace-nowrap px-4 py-3 text-right sm:px-6">
                              <DropdownMenu>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        className="text-muted-foreground hover:text-foreground"
                                        aria-label="Row actions"
                                        title="More actions"
                                        data-testid="row-actions"
                                      >
                                        <MoreVertical className="size-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                  </TooltipTrigger>
                                  <TooltipContent>More actions</TooltipContent>
                                </Tooltip>
                                <DropdownMenuContent align="end" className="w-48">
                                  <DropdownMenuItem
                                    onClick={() => handleToggleActive(monitor)}
                                    disabled={togglingId === monitor.id}
                                  >
                                    <Power className="size-4" />
                                    {monitor.isActive
                                      ? "Pause Monitor"
                                      : "Resume Monitor"}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() =>
                                      handleCheckMonitor(monitor.id)
                                    }
                                    disabled={
                                      checkingId === monitor.id || !monitor.isActive
                                    }
                                  >
                                    <RefreshCw
                                      className={`size-4 ${checkingId === monitor.id ? "animate-spin text-primary" : ""}`}
                                    />
                                    Re-check endpoint status
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => openEditModal(monitor)}
                                  >
                                    <Edit2 className="size-4" />
                                    Edit Monitor
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  {/* Delete — opens the confirm alert-dialog;
                                      the DELETE fetch fires only on its confirm
                                      action */}
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onClick={() =>
                                      setDeleteTarget({
                                        id: monitor.id,
                                        name: monitor.name,
                                      })
                                    }
                                    disabled={deletingId === monitor.id}
                                  >
                                    <Trash2 className="size-4" />
                                    Delete Monitor
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </td>
                          </motion.tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Delete Monitor confirm (UI-SPEC destructive-confirmation copy) */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete monitor</AlertDialogTitle>
            <AlertDialogDescription>
              {`This permanently deletes "${deleteTarget?.name}" and its check history. This can't be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = deleteTarget;
                setDeleteTarget(null);
                if (target) handleDeleteMonitor(target.id, target.name);
              }}
            >
              Delete Monitor
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Monitor dialog (shadcn Dialog — one dialog system, UI-02) */}
      <Dialog open={isAddModalOpen} onOpenChange={setIsAddModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add New Monitor</DialogTitle>
            <DialogDescription>
              Configure a target URL for automated 24/7 uptime monitoring.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreateMonitor} className="flex flex-col gap-4">
            <div>
              <label
                htmlFor="new-monitor-name"
                className="mb-1.5 block text-xs text-muted-foreground"
              >
                Monitor Name
              </label>
              <Input
                id="new-monitor-name"
                type="text"
                value={newMonitorName}
                onChange={(e) => setNewMonitorName(e.target.value)}
                placeholder="e.g. Primary API Gateway"
                required
              />
            </div>

            <div>
              <label
                htmlFor="new-monitor-url"
                className="mb-1.5 block text-xs text-muted-foreground"
              >
                Target URL
              </label>
              <Input
                id="new-monitor-url"
                type="url"
                value={newMonitorUrl}
                onChange={(e) => setNewMonitorUrl(e.target.value)}
                placeholder="https://api.example.com/health"
                required
              />
            </div>

            <div>
              <label
                htmlFor="new-monitor-interval"
                className="mb-1.5 block text-xs text-muted-foreground"
              >
                Check Interval
              </label>
              <select
                id="new-monitor-interval"
                value={newMonitorInterval}
                onChange={(e) =>
                  setNewMonitorInterval(Number(e.target.value))
                }
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value={1}>Every 1 minute</option>
                <option value={5}>Every 5 minutes</option>
                <option value={10}>Every 10 minutes</option>
                <option value={30}>Every 30 minutes</option>
                <option value={60}>Every 60 minutes</option>
              </select>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsAddModalOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>Create Monitor</span>
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Monitor dialog (shadcn Dialog — one dialog system, UI-02) */}
      <Dialog
        open={isEditModalOpen && editingMonitor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setIsEditModalOpen(false);
            setEditingMonitor(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Monitor</DialogTitle>
            <DialogDescription>
              Update configuration for {editingMonitor?.name}.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleEditMonitor} className="flex flex-col gap-4">
            <div>
              <label
                htmlFor="edit-monitor-name"
                className="mb-1.5 block text-xs text-muted-foreground"
              >
                Monitor Name
              </label>
              <Input
                id="edit-monitor-name"
                type="text"
                value={editMonitorName}
                onChange={(e) => setEditMonitorName(e.target.value)}
                placeholder="e.g. Primary API Gateway"
                required
              />
            </div>

            <div>
              <label
                htmlFor="edit-monitor-url"
                className="mb-1.5 block text-xs text-muted-foreground"
              >
                Target URL
              </label>
              <Input
                id="edit-monitor-url"
                type="url"
                value={editMonitorUrl}
                onChange={(e) => setEditMonitorUrl(e.target.value)}
                placeholder="https://api.example.com/health"
                required
              />
            </div>

            <div>
              <label
                htmlFor="edit-monitor-interval"
                className="mb-1.5 block text-xs text-muted-foreground"
              >
                Check Interval
              </label>
              <select
                id="edit-monitor-interval"
                value={editMonitorInterval}
                onChange={(e) =>
                  setEditMonitorInterval(Number(e.target.value))
                }
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value={1}>Every 1 minute</option>
                <option value={5}>Every 5 minutes</option>
                <option value={10}>Every 10 minutes</option>
                <option value={30}>Every 30 minutes</option>
                <option value={60}>Every 60 minutes</option>
              </select>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsEditModalOpen(false);
                  setEditingMonitor(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isUpdating}>
                {isUpdating ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    <span>Updating...</span>
                  </>
                ) : (
                  <span>Save Changes</span>
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
