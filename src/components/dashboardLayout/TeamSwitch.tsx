"use client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Logout01Icon as LogOut, Activity01Icon as Activity } from "hugeicons-react";
import { authClient } from "@/lib/auth-client";
import Image from "next/image";
import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";
import Swal from "sweetalert2";
import logo from "@/assets/logo.png"

export function TeamSwitcher({
  teams,
  user,
}: {
  teams: { name: string; logo: React.ElementType }[];
  user?: {
    name?: string;
    email?: string;
    avatar?: string;
    roleLabel?: string;
  };
}) {
  const [activeTeam] = React.useState(teams[0]);
  const displayName = user?.name ?? "Default User";
  const displayEmail = user?.email ?? "user@spidernode.com";
  const displayAvatar = user?.avatar ?? "https://github.com/shadcn.png";
  const displayFallback =
    displayName
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "U";

  const handleLogout = async () => {
    // 07-08 deletion release (AUTH-08): the Redux logout dispatch and the
    // legacy token-cookie removal died with the token mirror — sign-out is
    // the single authClient call (07-04 swap), then the redirect.
    toast.success("Logged out successfully!");
    await authClient.signOut();
    window.location.href = "/login";
  };

  const handleLogoutClick = async () => {
    const result = await Swal.fire({
      title: "Are you sure?",
      text: "Do you want to log out?",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Log Out",
      cancelButtonText: "Cancel",
      // THM-03: dialog tokens are same-value in both modes — dark rendering unchanged
      confirmButtonColor: "var(--primary)", // Red for the new theme
      cancelButtonColor: "var(--dialog-muted)",
      background: "var(--dialog-surface)",
      color: "var(--dialog-foreground)",
    });

    if (result.isConfirmed) {
      handleLogout();
    }
  };

  if (!activeTeam) {
    return null;
  }

  return (
    <div className="space-y-5">
      {/* Sidebar top logo */}
      <SidebarMenu>
        <SidebarMenuItem>
          <Link href={"/"} className="flex items-center gap-3 px-2 py-3">
            {/* <div className="flex aspect-square size-10 items-center justify-center rounded-lg bg-black text-primary shadow-sm">
              <Activity className="size-6" />
            </div> */}
            <Image src={logo} alt="Logo" width={50} height={50} className="w-12 h-12 object-contain" />
            <span className="text-xl font-bold tracking-tight text-white font-mono">
              Spider<span className="text-primary">Node</span>
            </span>
          </Link>
        </SidebarMenuItem>
      </SidebarMenu>

      {/* Footer user and logout */}
      <div className="absolute bottom-4 left-4 right-4">
        {/* <div className="mb-4 flex items-center gap-3 rounded-xl bg-white/70 p-2">
          <Avatar className="h-9 w-9">
            <AvatarImage src={displayAvatar} alt={displayName} />
            <AvatarFallback>{displayFallback}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-dialog-foreground">
              {displayName}
            </p>
            <p className="truncate text-[11px] text-muted-meta">
              {displayEmail}
            </p>
          </div>
        </div> */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleLogoutClick}
              className="h-auto justify-start gap-2 rounded-lg bg-transparent px-2 py-2 text-sm font-semibold text-danger-strong hover:bg-danger-strong/10 hover:text-danger-strong"
            >
              <LogOut className="w-4 h-4" />
              <span>Log out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>
    </div>
  );
}
