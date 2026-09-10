import React from "react";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="relative min-h-screen bg-[#121212] text-slate-100">
      {/* Auth pages are pre-login — the theme must be settable there too
          (UI-SPEC placement: 24px inset, top-right) */}
      <div className="absolute top-6 right-6 z-50">
        <ThemeToggle />
      </div>
      {children}
    </div>
  );
}
