"use client";

import { useQuery } from "@tanstack/react-query";
import { LogOut, Moon, ShieldCheck, Sun, User } from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { api, unwrap } from "@/lib/api/client";
import { visibleNavigation } from "@/lib/navigation";
import { useSession } from "@/lib/session";

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function CommandPalette({ open, onOpenChange, onSignOut }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignOut: () => void;
}) {
  const router = useRouter();
  const { canAny, flag, can, isOperator } = useSession();
  const { resolvedTheme, setTheme } = useTheme();
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 250);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const users = useQuery({
    queryKey: ["palette", "users", term],
    queryFn: () => unwrap(api.GET("/api/v1/identity/users/", { params: { query: { search: term, page_size: 5 } } })),
    enabled: open && term.length >= 2 && can("identity.user.read"),
  });

  const go = (href: string) => {
    onOpenChange(false);
    setSearch("");
    router.push(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search" description="Jump to a page or find a record">
      <CommandInput placeholder="Jump to a page, or search people…" value={search} onValueChange={setSearch} />
      <CommandList>
        <CommandEmpty>No matches. Try a page name like “roles” or a person’s name.</CommandEmpty>
        {/* People first: a name typed into search is almost always a person, not a page. */}
        {users.data && users.data.results.length > 0 && (
          <CommandGroup heading="People">
            {users.data.results.map((u) => (
              <CommandItem key={u.id} value={`person ${u.full_name} ${u.email}`} onSelect={() => go(`/admin/users/${u.id}`)}>
                <User aria-hidden />
                <span>{u.full_name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{u.email}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {visibleNavigation(canAny, flag, isOperator).map((section) => (
          <CommandGroup key={section.label} heading={section.label}>
            {section.items.map((item) => (
              <CommandItem key={item.href} value={`${item.label} ${item.keywords ?? ""}`} onSelect={() => go(item.href)}>
                <item.icon aria-hidden />
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandGroup heading="Account">
          <CommandItem value="account security mfa password sessions" onSelect={() => go("/account/security")}>
            <ShieldCheck aria-hidden />
            Account security
          </CommandItem>
          <CommandItem
            value="switch theme dark light"
            onSelect={() => {
              setTheme(resolvedTheme === "dark" ? "light" : "dark");
              onOpenChange(false);
            }}
          >
            {resolvedTheme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
            Switch to {resolvedTheme === "dark" ? "light" : "dark"} theme
          </CommandItem>
          <CommandItem value="sign out log out" onSelect={onSignOut}>
            <LogOut aria-hidden />
            Sign out
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
