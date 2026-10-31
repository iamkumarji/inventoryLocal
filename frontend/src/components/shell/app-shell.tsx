"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronsUpDown, LogOut, Menu, Monitor, Moon, Search, ShieldCheck, Sun } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api/client";
import { initials } from "@/lib/format";
import { useSession } from "@/lib/session";

import { CommandPalette } from "./command-palette";
import { NotificationBell } from "./notification-bell";
import { useRealtime } from "./realtime";
import { Sidebar, SidebarNav, Wordmark } from "./sidebar";

const COLLAPSE_KEY = "erp.sidebarCollapsed";

function CompanySwitcher() {
  const { me, activeCompany, switchCompany } = useSession();
  if (me.companies.length <= 1) {
    return activeCompany ? (
      <span className="hidden items-center gap-2 text-sm text-muted-foreground md:flex">
        <Building2 className="size-4" aria-hidden />
        {activeCompany.name}
      </span>
    ) : null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="max-w-56 gap-2" aria-label="Switch company">
          <Building2 aria-hidden />
          <span className="truncate">{activeCompany?.name ?? "Choose company"}</span>
          <ChevronsUpDown className="opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Working in</DropdownMenuLabel>
        {me.companies.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => switchCompany(c.id)}>
            <span className="flex-1 truncate">{c.name}</span>
            <span className="text-xs text-muted-foreground">{c.code}</span>
            {c.id === activeCompany?.id && <Check aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ onSignOut }: { onSignOut: () => void }) {
  const { me } = useSession();
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full">
          <span className="grid size-8 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
            {initials(me.user.full_name)}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="font-medium">{me.user.full_name}</p>
          <p className="truncate text-xs text-muted-foreground">{me.user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account/security">
            <ShieldCheck aria-hidden /> Account security
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light"><Sun aria-hidden /> Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark"><Moon aria-hidden /> Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system"><Monitor aria-hidden /> Match device</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut}>
          <LogOut aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // The shell only renders client-side (after /auth/me loads), so reading storage here can't mismatch hydration.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const toggle = () => {
    setCollapsed((value) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, value ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !value;
    });
  };

  const navigate = useCallback((href: string) => router.push(href), [router]);
  useRealtime(navigate);

  const signOut = useMutation({
    mutationFn: () => api.POST("/api/v1/auth/logout/"),
    onSettled: () => {
      queryClient.clear();
      router.replace("/login");
    },
  });

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 border-none bg-sidebar p-0 text-sidebar-foreground">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-14 items-center border-b border-sidebar-border px-5">
            <Wordmark />
          </div>
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 w-full max-w-sm items-center gap-2 rounded-md border bg-card px-3 text-sm text-muted-foreground hover:border-input"
          >
            <Search className="size-4" aria-hidden />
            <span className="flex-1 text-left">Search or jump to…</span>
            <kbd className="hidden rounded-sm border bg-muted px-1.5 text-[0.7rem] sm:inline">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <CompanySwitcher />
            <NotificationBell />
            <UserMenu onSignOut={() => signOut.mutate()} />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onSignOut={() => signOut.mutate()} />
    </div>
  );
}
