"use client";

import { SidebarTrigger } from "../ui/sidebar";
import { NavUser } from "./NavUser";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

const AppHeader = () => {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 bg-background/80 backdrop-blur-md border-b border-border px-6 sticky top-0 z-50">
      {/* Left Side */}
      <div className="flex items-center gap-4">
        <SidebarTrigger className="-ml-1 text-muted-foreground hover:text-foreground transition-colors" />
      </div>

      {/* Right Side */}
      <div className="flex items-center gap-3">
        <ThemeToggle />
        <NavUser />
      </div>
    </header>
  );
};

export default AppHeader;
