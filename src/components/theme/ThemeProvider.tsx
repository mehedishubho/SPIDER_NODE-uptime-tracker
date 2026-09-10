"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

// THM-01 (D-24): defaultTheme="dark" keeps every existing user on today's
// app until they opt in — the "dark visually identical to today" constraint
// holds by default, not just after toggling.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
