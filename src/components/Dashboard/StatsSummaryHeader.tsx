"use client";

import React from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Activity01Icon as Activity,
  ArrowUpRight01Icon as TrendingUp,
  GlobeIcon as Globe,
  Shield01Icon as ShieldCheck,
} from "hugeicons-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Stats summary header (D-25): aggregates of the ALREADY-LOADED monitors data
// only — count, UP/DOWN distribution, average uptime of the displayed lifetime
// values, and the existing average latency. No new endpoint, no windowed
// values (D-24). Cyan accent is reserved per the UI-SPEC Color contract for
// the uptime-percentage emphasis only; data values render in JetBrains Mono.

export interface StatsMonitor {
  isActive: boolean;
  status: string; // 'UP' | 'DOWN' | 'UNKNOWN' | 'PENDING'
  responseTime: number;
  uptimePercent: number;
}

interface StatsSummaryHeaderProps {
  monitors: StatsMonitor[];
}

// Entrance: staggered fade-in-up (D-28) with a reduced-motion static
// fallback — useReducedMotion mounts the cards directly in their final state.
const listVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.25, ease: "easeOut" as const },
  },
};

export function StatsSummaryHeader({ monitors }: StatsSummaryHeaderProps) {
  const reduceMotion = useReducedMotion();

  // Fleet aggregates — active monitors carry the status semantics (same
  // denominators the previous metrics bar used); the count caption keeps the
  // zero-one-many "Total {n} listed" form.
  const activeMonitors = monitors.filter((m) => m.isActive);
  const totalMonitors = activeMonitors.length;
  const upMonitors = activeMonitors.filter((m) => m.status === "UP").length;
  const downMonitors = activeMonitors.filter((m) => m.status === "DOWN").length;
  const operationalStatus =
    downMonitors === 0 ? "ALL OPERATIONAL" : `${downMonitors} DEGRADED`;

  // Average uptime of the displayed lifetime values (no windowed math — D-24).
  // Mirror of the previous health card's convention: an empty fleet reads as
  // fully healthy (100.00%).
  const avgUptime =
    totalMonitors > 0
      ? (
          activeMonitors.reduce((acc, m) => acc + (m.uptimePercent || 0), 0) /
          totalMonitors
        ).toFixed(2)
      : "100.00";

  const avgLatency =
    activeMonitors.length > 0
      ? Math.round(
          activeMonitors.reduce((acc, m) => acc + (m.responseTime || 0), 0) /
            activeMonitors.length,
        )
      : 0;

  const stats = [
    {
      id: "total",
      label: "TOTAL MONITORS",
      value: `${totalMonitors}`,
      caption: `Total ${monitors.length} listed`,
      icon: Globe,
      valueClass: "text-foreground",
    },
    {
      id: "status",
      label: "STATUS OVERVIEW",
      value: operationalStatus,
      caption: `${upMonitors} UP • ${downMonitors} DOWN`,
      icon: Activity,
      valueClass:
        downMonitors === 0 ? "text-status-up" : "text-status-down",
    },
    {
      id: "uptime",
      label: "AVG UPTIME",
      value: `${avgUptime}%`,
      caption: "Mean lifetime uptime",
      icon: ShieldCheck,
      // Cyan accent — the UI-SPEC reserved-list emphasis for uptime values.
      valueClass: "text-accent-cyan",
    },
    {
      id: "latency",
      label: "AVG LATENCY",
      value: `${avgLatency}ms`,
      caption: "Average global ping",
      icon: TrendingUp,
      valueClass: "text-foreground",
    },
  ];

  return (
    <motion.section
      variants={listVariants}
      initial={reduceMotion ? false : "hidden"}
      animate="visible"
      aria-label="Fleet stats summary"
      data-testid="stats-summary-header"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <motion.div key={stat.id} variants={cardVariants}>
            <Card className="h-full gap-2 py-5">
              <CardHeader className="px-5">
                <CardDescription className="flex items-center justify-between text-xs font-mono uppercase tracking-wider">
                  <span>{stat.label}</span>
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                </CardDescription>
                <CardTitle
                  data-testid={`stat-${stat.id}`}
                  className={`font-mono text-[28px] font-semibold leading-tight ${stat.valueClass}`}
                >
                  {stat.value}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-5 text-xs text-muted-foreground">
                {stat.caption}
              </CardContent>
            </Card>
          </motion.div>
        );
      })}
    </motion.section>
  );
}
