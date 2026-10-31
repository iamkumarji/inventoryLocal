"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api/client";
import { rememberPerson } from "@/lib/api/production";
import { cn } from "@/lib/utils";

/** The `@word` being typed at the caret, if any. */
function mentionAt(text: string, caret: number): { start: number; term: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(before);
  if (!match) return null;
  return { start: caret - match[2].length - 1, term: match[2] };
}

/**
 * Comment box with @mention suggestions from the colleague directory. Choosing a person inserts
 * `@email`, which the API resolves to a mention (and notifies them if they can read the record).
 */
export function MentionInput({ id, value, onChange, placeholder, disabled }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; term: string } | null>(null);
  const [term, setTerm] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setTerm(mention?.term ?? ""), 200);
    return () => clearTimeout(t);
  }, [mention]);
  const results = useQuery({
    queryKey: ["directory", term],
    queryFn: () => unwrap(api.GET("/api/v1/identity/directory/", { params: { query: { search: term } } })),
    enabled: mention !== null && term.length >= 2,
  });
  const options = mention && term.length >= 2 ? (results.data ?? []) : [];

  const choose = (person: { id: string; full_name: string; email: string }) => {
    if (!mention) return;
    rememberPerson(person);
    const caret = ref.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, mention.start)}@${person.email} ${value.slice(caret)}`;
    onChange(next);
    setMention(null);
    const pos = mention.start + person.email.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        id={id}
        rows={3}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls={`${id}-mentions`}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setMention(mentionAt(e.target.value, e.target.selectionStart ?? e.target.value.length));
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (!options.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % options.length); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length); }
          else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(options[active]!); }
          else if (e.key === "Escape") setMention(null);
        }}
        onBlur={() => setTimeout(() => setMention(null), 150)}
      />
      {options.length > 0 && (
        <ul id={`${id}-mentions`} role="listbox" aria-label="People to mention"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {options.map((p, index) => (
            <li key={p.id} role="option" aria-selected={index === active}
              className={cn("cursor-pointer rounded-sm px-2 py-2 text-sm", index === active && "bg-accent")}
              onMouseDown={(e) => { e.preventDefault(); choose(p); }}>
              <span className="block font-medium">{p.full_name}</span>
              <span className="block text-xs text-muted-foreground">{p.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const MENTION_RE = /(@[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/** Comment text with @mentions highlighted. */
export function CommentBody({ body }: { body: string }) {
  const parts = body.split(MENTION_RE);
  return (
    <p className="text-sm break-words whitespace-pre-wrap">
      {parts.map((part, i) =>
        i % 2 === 1 ? <span key={i} className="rounded-sm bg-status-info/10 px-1 font-medium text-status-info">{part}</span> : part,
      )}
    </p>
  );
}
