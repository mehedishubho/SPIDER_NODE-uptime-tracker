"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { ComputerIcon, Moon02Icon, Sun03Icon } from "hugeicons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// D-23: single button cycling Light → Dark → System (persisted by
// next-themes in the localStorage "theme" key). Icon + tooltip + aria-label
// reflect the SELECTED theme, not the resolved one.
const CYCLE = ["light", "dark", "system"] as const;

type SelectedTheme = (typeof CYCLE)[number];

const LABELS: Record<SelectedTheme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

// UI-SPEC Interaction Contract: 36px target (documented sub-44px exception,
// desktop-first dashboard), 18px icon, muted styling, focus ring from
// --ring. Icon names follow hugeicons-react@0.4.x exports (Sun03 = the
// sunlight glyph, Computer = the monitor glyph).
const ICONS: Record<SelectedTheme, typeof Sun03Icon> = {
  light: Sun03Icon,
  dark: Moon02Icon,
  system: ComputerIcon,
};

const emptySubscribe = () => () => {};

// Hydration guard (Pitfall 8): false during SSR and the hydration render,
// true afterwards — useTheme() is undefined on the server, so pre-mount we
// render a layout-stable placeholder of the same size. Expressed via
// useSyncExternalStore because the repo lint forbids synchronous setState
// inside effects.
function useMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

export function ThemeToggle() {
  const mounted = useMounted();
  const { theme, setTheme } = useTheme();

  if (!mounted) {
    return <span className="inline-block size-9" aria-hidden="true" />;
  }

  const current: SelectedTheme = (CYCLE as readonly string[]).includes(
    theme ?? "dark"
  )
    ? (theme as SelectedTheme)
    : "dark";
  const next = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length];
  const Icon = ICONS[current];

  // TooltipProvider is required per Radix — the auth surface has no global
  // provider (same per-instance composition as sidebar.tsx).
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setTheme(next)}
            aria-label={`Switch theme (current: ${LABELS[current]})`}
            className="inline-flex size-9 items-center justify-center outline-none transition-colors text-muted-foreground hover:text-foreground focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon className="size-4.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{`Theme: ${LABELS[current]}`}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
