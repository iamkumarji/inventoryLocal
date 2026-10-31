"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { activeHref, visibleNavigation } from "@/lib/navigation";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5 text-white">
      <span aria-hidden className="grid size-7 place-items-center rounded-sm bg-sidebar-primary text-sidebar-primary-foreground">
        <span className="type-signage text-[0.95rem]" style={{ fontStretch: "100%" }}>O</span>
      </span>
      {!compact && (
        <span className="text-[1.05rem] font-bold tracking-tight" style={{ fontStretch: "115%" }}>
          OtabuPro
        </span>
      )}
    </span>
  );
}

export function SidebarNav({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { canAny, flag } = useSession();
  const sections = visibleNavigation(canAny, flag);
  const current = activeHref(pathname);

  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 pb-6">
      {sections.map((section) => (
        <div key={section.label} className="mt-5 first:mt-2">
          {!collapsed && <p className="px-3 pb-1.5 text-xs text-sidebar-foreground/60">{section.label}</p>}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = item.href === current;
              const link = (
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex h-9 items-center gap-3 rounded-md px-3 text-[0.875rem] text-sidebar-foreground transition-colors",
                    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-sidebar-ring",
                    active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                    collapsed && "justify-center px-0",
                  )}
                >
                  {active && (
                    // The floor marking: the one place yellow says "you are here".
                    <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-sm bg-sidebar-primary" />
                  )}
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              );
              return (
                <li key={item.href}>
                  {collapsed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{link}</TooltipTrigger>
                      <TooltipContent side="right">{item.label}</TooltipContent>
                    </Tooltip>
                  ) : (
                    link
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col bg-sidebar transition-[width] duration-150 lg:flex",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className={cn("flex h-14 items-center border-b border-sidebar-border", collapsed ? "justify-center" : "px-5")}>
        <Link href="/" aria-label="OtabuPro home" className="rounded-sm focus-visible:outline-sidebar-ring">
          <Wordmark compact={collapsed} />
        </Link>
      </div>
      <SidebarNav collapsed={collapsed} />
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="flex h-11 items-center gap-3 border-t border-sidebar-border px-5 text-sm text-sidebar-foreground/70 hover:text-white focus-visible:outline-sidebar-ring"
      >
        {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        {!collapsed && "Collapse"}
      </button>
    </aside>
  );
}
