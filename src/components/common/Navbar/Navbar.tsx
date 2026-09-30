"use client";

import React, { useState } from "react";
import Link from "next/link";
import { authClient, useAuthSession } from "@/lib/auth-client";
import { Activity01Icon as Activity, GithubIcon as Github, DashboardSquare01Icon as LayoutDashboard, Login01Icon as LogIn, Logout01Icon as LogOut, Menu01Icon as Menu, Cancel01Icon as X } from "hugeicons-react";
import logo from "@/assets/logo.png"
import Image from "next/image";

export const Navbar = () => {
  const { data: session, isPending } = useAuthSession();
  const status = isPending ? "loading" : session ? "authenticated" : "unauthenticated";
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/80 backdrop-blur-md font-sans">
      <div className="w-full max-w-7xl mx-auto flex items-center justify-between px-4 sm:px-6 py-3.5">
        {/* Brand Logo */}
        <Link href="/" className="flex items-center gap-2.5 group">
          {/* <div className="p-2 rounded-xl bg-red-500/10 border border-red-500/30 text-primary group-hover:scale-105 transition-transform shadow-sm shadow-red-500/20">
            <Activity className="w-5 h-5" />
          </div> */}
          <Image src={logo} alt="Logo" width={50} height={50} className="w-12 h-12 object-contain" />
          <span className="text-xl font-bold tracking-tight text-foreground font-heading">
            Spider<span className="text-primary">Node</span>
          </span>
        </Link>

        {/* Desktop Nav Actions */}
        <div className="hidden md:flex items-center gap-4">
          <Link
            href="https://github.com/rakibutsho/uptime-tracker"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg border border-border hover:border-muted-foreground/40 bg-secondary/60 text-muted-foreground hover:text-foreground text-xs font-medium transition-all"
          >
            <Github className="w-4 h-4" />
            <span>Star on GitHub</span>
          </Link>

          {status === "loading" ? (
            <div className="w-24 h-8 bg-muted/60 rounded-lg animate-pulse" />
          ) : session ? (
            <div className="flex items-center gap-3">
              <Link
                href="/dashboard"
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary hover:bg-red-500 text-primary-foreground text-xs font-bold transition-all shadow-md shadow-red-500/20"
              >
                <LayoutDashboard className="w-4 h-4" />
                <span>Dashboard</span>
              </Link>
              <button
                onClick={async () => {
                  await authClient.signOut();
                  window.location.href = "/";
                }}
                className="p-2 rounded-xl bg-secondary border border-border text-muted-foreground hover:text-rose-400 transition-colors cursor-pointer"
                title="Sign Out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <Link
              href="/login"
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary hover:bg-red-500 text-primary-foreground text-xs font-bold transition-all shadow-md shadow-red-500/20"
            >
              <LogIn className="w-4 h-4" />
              <span>Sign In</span>
            </Link>
          )}
        </div>

        {/* Mobile menu trigger */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden p-2 rounded-lg bg-secondary border border-border text-muted-foreground"
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden border-b border-border bg-background px-4 py-4 space-y-3">
          <a
            href="https://github.com/rakibutsho/uptime-tracker"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-secondary text-muted-foreground text-sm font-medium"
          >
            <Github className="w-4 h-4" />
            <span>Star on GitHub</span>
          </a>

          {session ? (
            <div className="space-y-2">
              <Link
                href="/dashboard"
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-bold text-sm"
              >
                <LayoutDashboard className="w-4 h-4" />
                <span>Go to Dashboard</span>
              </Link>
              <button
                onClick={async () => {
                  await authClient.signOut();
                  window.location.href = "/";
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20 text-sm font-medium"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </button>
            </div>
          ) : (
            <Link
              href="/login"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-bold text-sm"
            >
              <LogIn className="w-4 h-4" />
              <span>Sign In</span>
            </Link>
          )}
        </div>
      )}
    </header>
  );
};
