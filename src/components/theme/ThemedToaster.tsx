"use client";

import { useTheme } from "next-themes";
import { Toaster } from "sonner";

// THM-02: the Toaster follows the RESOLVED theme (system collapses to
// light/dark). Every prop except theme is frozen exactly as the previous
// server-rendered <Toaster richColors position="top-right" theme="dark" />.
// resolvedTheme is undefined during SSR/hydration — the ternary renders
// "dark" on both sides of hydration, so no mismatch (Pitfall 8).
export function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      richColors
      position="top-right"
      theme={resolvedTheme === "light" ? "light" : "dark"}
    />
  );
}
