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
import { Activity01Icon as Activity, PlusSignIcon as Plus, RefreshIcon as RefreshCw, Delete02Icon as Trash2, LinkSquare01Icon as ExternalLink, Logout01Icon as LogOut, Shield01Icon as ShieldCheck, GlobeIcon as Globe, Clock01Icon as Clock, ArrowUpRight01Icon as TrendingUp, Loading01Icon as Loader2, Edit02Icon as Edit2, EcoPowerIcon as Power } from "hugeicons-react";
import Link from "next/link";

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
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <span className="text-xs text-slate-400 font-mono">
            Loading Dashboard...
          </span>
        </div>
      </div>
    );
  }

  // Calculate Metrics
  const activeMonitors = monitors.filter((m) => m.isActive);
  const totalMonitors = activeMonitors.length;
  const upMonitors = activeMonitors.filter((m) => m.status === "UP").length;
  const downMonitors = activeMonitors.filter((m) => m.status === "DOWN").length;
  const healthPercentage =
    totalMonitors > 0 ? Math.round((upMonitors / totalMonitors) * 100) : 100;
  const operationalStatus =
    downMonitors === 0 ? "ALL OPERATIONAL" : `${downMonitors} DEGRADED`;

  const avgLatency =
    activeMonitors.length > 0
      ? Math.round(
          activeMonitors.reduce((acc, m) => acc + (m.responseTime || 0), 0) /
            activeMonitors.length,
        )
      : 0;

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
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header Bar */}
        <div className="glass-panel p-4 sm:p-6 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border border-slate-800">
          <div className="flex items-center gap-4">
            {userImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={userImage}
                alt={userName}
                className="w-12 h-12 rounded-xl object-cover ring-2 ring-primary/40"
              />
            ) : (
              <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-center text-primary font-mono font-bold text-lg red-glow">
                {userInitials}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-white">{userName}</h1>
                <span className="px-2 py-0.5 rounded-md bg-red-500/10 text-primary text-[10px] font-mono font-semibold border border-red-500/20">
                  PRO MONITOR
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                {userEmail}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
            <Link
              href="/dashboard/profile"
              className="px-3.5 py-2.5 rounded-xl glass-panel hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white text-xs font-semibold transition-colors cursor-pointer"
            >
              Profile
            </Link>

            <button
              onClick={() => setIsAddModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary hover:bg-red-400 text-primary-foreground font-bold text-xs transition-all shadow-lg shadow-red-500/20 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add Monitor</span>
            </button>

            <button
              onClick={async () => {
                await authClient.signOut();
                window.location.href = "/login";
              }}
              className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-rose-400 text-xs font-semibold transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>

        {/* Metrics Overview Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="glass-panel p-5 rounded-2xl border border-slate-800 animate-fade-in-up delay-75 card-hover">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs font-mono">ACTIVE MONITORS</span>
              <Globe className="w-4 h-4 text-primary" />
            </div>
            <div className="text-3xl font-extrabold font-mono text-white transition-number">
              {totalMonitors}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Total {monitors.length} listed
            </p>
          </div>

          <div className="glass-panel p-5 rounded-2xl border border-slate-800 animate-fade-in-up delay-150 card-hover">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs font-mono">SYSTEM HEALTH</span>
              <ShieldCheck className="w-4 h-4 text-status-up" />
            </div>
            <div className="text-3xl font-extrabold font-mono text-status-up transition-number">
              {healthPercentage}%
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Operational target 99.9%
            </p>
          </div>

          <div className="glass-panel p-5 rounded-2xl border border-slate-800 animate-fade-in-up delay-225 card-hover">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs font-mono">STATUS OVERVIEW</span>
              <Activity className="w-4 h-4 text-primary" />
            </div>
            <div
              className={`text-xl font-extrabold font-mono transition-number ${
                downMonitors === 0 ? "text-status-up" : "text-rose-500"
              }`}
            >
              {operationalStatus}
            </div>
            <p className="text-[11px] text-slate-500 mt-1 transition-number">
              {upMonitors} UP • {downMonitors} DOWN
            </p>
          </div>

          <div className="glass-panel p-5 rounded-2xl border border-slate-800 animate-fade-in-up delay-300 card-hover">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs font-mono">AVG LATENCY</span>
              <TrendingUp className="w-4 h-4 text-red-400" />
            </div>
            <div className="text-3xl font-extrabold font-mono text-primary transition-number">
              {avgLatency}ms
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Average global ping
            </p>
          </div>
        </div>

        {/* Monitor Table Section */}
        <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden animate-fade-in-up" style={{ animationDelay: '400ms' }}>
          <div className="p-4 sm:p-6 border-b border-slate-800/80 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">
                Monitored Services
              </h2>
              <p className="text-xs text-slate-400">
                Real-time HTTP health check monitors linked to your account
              </p>
            </div>
            <button
              onClick={fetchMonitors}
              disabled={loadingMonitors}
              className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
              title="Refresh List"
            >
              <RefreshCw
                className={`w-4 h-4 ${loadingMonitors ? "animate-spin text-primary" : ""}`}
              />
            </button>
          </div>

          {loadingMonitors && monitors.length === 0 ? (
            <div className="p-12 text-center text-slate-500 font-mono text-xs flex flex-col items-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span>Fetching status records...</span>
            </div>
          ) : monitors.length === 0 ? (
            <div className="p-12 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-slate-900 border border-slate-800 text-slate-500 flex items-center justify-center mx-auto">
                <Globe className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-semibold text-slate-300">
                No Monitors Found
              </h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                You haven&apos;t added any endpoints yet. Click &quot;Add
                Monitor&quot; above to start tracking your website or API.
              </p>
              <button
                onClick={() => setIsAddModalOpen(true)}
                className="mt-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-bold shadow-md shadow-red-500/20 hover:scale-105 transition-transform cursor-pointer"
              >
                + Add Your First Monitor
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs">
                <thead className="bg-slate-900/80 border-b border-slate-800 text-slate-400 uppercase tracking-wider text-[11px]">
                  <tr>
                    <th className="py-3.5 px-4 sm:px-6">Status & Latency</th>
                    <th className="py-3.5 px-4 sm:px-6">Site Name & URL</th>
                    <th className="py-3.5 px-4 sm:px-6">Uptime</th>
                    <th className="py-3.5 px-4 sm:px-6">Last Checked</th>
                    <th className="py-3.5 px-4 sm:px-6 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {monitors.map((monitor, index) => {
                    let statusColor =
                      "bg-slate-500/10 text-slate-400 border-slate-500/30";
                    let dotColor = "bg-slate-500";
                    let label = "PAUSED";
                    let isDown = false;

                    if (monitor.isActive) {
                      if (monitor.status === "UP") {
                        statusColor =
                          "bg-emerald-500/10 text-status-up border-emerald-500/30";
                        dotColor = "bg-status-up animate-status-pulse";
                        label = "ONLINE";
                      } else if (monitor.status === "DOWN") {
                        statusColor =
                          "bg-rose-500/10 text-rose-400 border-rose-500/30";
                        dotColor = "bg-rose-500 animate-alert-pulse";
                        label = "OFFLINE";
                        isDown = true;
                      } else {
                        statusColor =
                          "bg-slate-500/10 text-slate-400 border-slate-500/30";
                        dotColor = "bg-slate-400";
                        label = "PENDING";
                      }
                    }

                    return (
                      <tr
                        key={monitor.id}
                        className={`transition-all duration-200 animate-fade-in-up hover:bg-slate-800/40 hover:-translate-y-[1px] ${!monitor.isActive ? "opacity-60" : ""} ${isDown ? "border-l-4 border-l-status-down bg-status-down/5 shadow-[inset_4px_0_10px_rgba(239,68,68,0.1)]" : ""}`}
                        style={{ animationDelay: `${index * 50 + 400}ms` }}
                      >
                        {/* Status & Latency Badge */}
                        <td className="py-4 px-4 sm:px-6 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${statusColor}`}
                            >
                              <span
                                className={`w-2 h-2 rounded-full ${dotColor}`}
                              />
                              {label}
                            </span>
                            {monitor.isActive && (
                              <span className={`text-[10px] ml-1 font-mono transition-number ${isDown ? "text-rose-400" : "text-slate-400"}`}>
                                {monitor.responseTime || 0} ms
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Site Name */}
                        <td className="py-4 px-4 sm:px-6">
                          <Link href={`/dashboard/monitor/${monitor.id}`}>
                            <div className="font-semibold text-slate-200 font-sans text-sm mb-1 hover:text-primary transition-colors cursor-pointer">
                              {monitor.name}
                            </div>
                          </Link>
                          <a
                            href={monitor.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-slate-400 hover:text-primary transition-colors text-[10px]"
                          >
                            <span>{monitor.url}</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </td>

                        {/* Uptime */}
                        <td className="py-4 px-4 sm:px-6">
                          <div
                            className={`font-semibold transition-number ${monitor.uptimePercent < 95 ? "text-rose-400" : "text-status-up"}`}
                          >
                            {monitor.uptimePercent
                              ? monitor.uptimePercent.toFixed(2)
                              : 100}
                            %
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {monitor.interval || 5}m interval
                          </div>
                        </td>

                        {/* Last Checked */}
                        <td className="py-4 px-4 sm:px-6 text-slate-400">
                          <span className="flex items-center gap-1.5 text-slate-400">
                            <Clock className="w-3.5 h-3.5 text-slate-500" />
                            {monitor.lastChecked
                              ? new Date(
                                  monitor.lastChecked,
                                ).toLocaleTimeString()
                              : "Never"}
                          </span>
                        </td>

                        {/* Actions */}
                        <td className="py-4 px-4 sm:px-6 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-2">
                            {/* Toggle Pause/Resume */}
                            <button
                              onClick={() => handleToggleActive(monitor)}
                              disabled={togglingId === monitor.id}
                              className={`p-2 rounded-lg border transition-colors cursor-pointer disabled:opacity-50 ${
                                monitor.isActive
                                  ? "bg-slate-900 border-slate-800 text-slate-400 hover:text-amber-400"
                                  : "bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20"
                              }`}
                              title={
                                monitor.isActive
                                  ? "Pause Monitor"
                                  : "Resume Monitor"
                              }
                            >
                              {togglingId === monitor.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Power className="w-3.5 h-3.5" />
                              )}
                            </button>

                            {/* Manual Check */}
                            <button
                              onClick={() => handleCheckMonitor(monitor.id)}
                              disabled={
                                checkingId === monitor.id || !monitor.isActive
                              }
                              className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-primary transition-colors cursor-pointer disabled:opacity-50"
                              title={
                                checkingId === monitor.id
                                  ? "Checking…"
                                  : "Re-check endpoint status"
                              }
                              aria-label={
                                checkingId === monitor.id
                                  ? "Checking…"
                                  : "Re-check endpoint status"
                              }
                            >
                              <RefreshCw
                                className={`w-3.5 h-3.5 ${
                                  checkingId === monitor.id
                                    ? "animate-spin text-primary"
                                    : ""
                                }`}
                              />
                            </button>

                            {/* Edit */}
                            <button
                              onClick={() => openEditModal(monitor)}
                              className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
                              title="Edit Monitor"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>

                            {/* Delete — opens the confirm alert-dialog; the
                                DELETE fetch fires only on its confirm action */}
                            <button
                              onClick={() =>
                                setDeleteTarget({
                                  id: monitor.id,
                                  name: monitor.name,
                                })
                              }
                              disabled={deletingId === monitor.id}
                              className="p-2 rounded-lg bg-slate-900 hover:bg-rose-950/60 border border-slate-800 text-slate-400 hover:text-rose-400 transition-colors cursor-pointer disabled:opacity-50"
                              title="Delete Monitor"
                            >
                              {deletingId === monitor.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
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

          <form onSubmit={handleCreateMonitor} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Monitor Name
              </label>
              <input
                type="text"
                value={newMonitorName}
                onChange={(e) => setNewMonitorName(e.target.value)}
                placeholder="e.g. Primary API Gateway"
                required
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-100 text-sm focus:border-primary outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Target URL
              </label>
              <input
                type="url"
                value={newMonitorUrl}
                onChange={(e) => setNewMonitorUrl(e.target.value)}
                placeholder="https://api.example.com/health"
                required
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-100 text-sm focus:border-primary outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Check Interval
              </label>
              <select
                value={newMonitorInterval}
                onChange={(e) =>
                  setNewMonitorInterval(Number(e.target.value))
                }
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-100 text-sm focus:border-primary outline-none"
              >
                <option value={1}>Every 1 minute</option>
                <option value={5}>Every 5 minutes</option>
                <option value={10}>Every 10 minutes</option>
                <option value={30}>Every 30 minutes</option>
                <option value={60}>Every 60 minutes</option>
              </select>
            </div>

            <div className="pt-2 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-5 py-2 rounded-xl bg-primary hover:bg-red-400 text-primary-foreground text-xs font-bold transition-all shadow-md shadow-red-500/20 cursor-pointer flex items-center gap-2 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>Create Monitor</span>
                )}
              </button>
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

          <form onSubmit={handleEditMonitor} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Monitor Name
              </label>
              <input
                type="text"
                value={editMonitorName}
                onChange={(e) => setEditMonitorName(e.target.value)}
                placeholder="e.g. Primary API Gateway"
                required
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-100 text-sm focus:border-primary outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Target URL
              </label>
              <input
                type="url"
                value={editMonitorUrl}
                onChange={(e) => setEditMonitorUrl(e.target.value)}
                placeholder="https://api.example.com/health"
                required
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-100 text-sm focus:border-primary outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Check Interval
              </label>
              <select
                value={editMonitorInterval}
                onChange={(e) =>
                  setEditMonitorInterval(Number(e.target.value))
                }
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-100 text-sm focus:border-primary outline-none"
              >
                <option value={1}>Every 1 minute</option>
                <option value={5}>Every 5 minutes</option>
                <option value={10}>Every 10 minutes</option>
                <option value={30}>Every 30 minutes</option>
                <option value={60}>Every 60 minutes</option>
              </select>
            </div>

            <div className="pt-2 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setIsEditModalOpen(false);
                  setEditingMonitor(null);
                }}
                className="px-4 py-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isUpdating}
                className="px-5 py-2 rounded-xl bg-primary hover:bg-red-400 text-primary-foreground text-xs font-bold transition-all shadow-md shadow-red-500/20 cursor-pointer flex items-center gap-2 disabled:opacity-50"
              >
                {isUpdating ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Updating...</span>
                  </>
                ) : (
                  <span>Save Changes</span>
                )}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
