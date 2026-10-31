"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Building2, CheckCheck, ClipboardCheck, Inbox, ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { PageHeader, Section } from "@/components/erp/page-header";
import { ApprovalStatus } from "@/components/erp/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/erp/states";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api/client";
import { useInbox } from "@/lib/api/hooks";
import { ago, dateTime, money } from "@/lib/format";
import { useSession } from "@/lib/session";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function UnreadNotifications() {
  const unread = useQuery({
    queryKey: ["notifications", "list", "home"],
    queryFn: () => unwrap(api.GET("/api/v1/notifications/", { params: { query: { unread: true, page_size: 5 } } })),
  });
  return (
    <Section title="Unread notifications"
      actions={<Button variant="ghost" size="sm" asChild><Link href="/notifications">All</Link></Button>}>
      {unread.isLoading ? <RowsSkeleton rows={3} /> : unread.error ? <ErrorState error={unread.error} /> :
        unread.data!.results.length === 0 ? (
          <EmptyState title="You're up to date" />
        ) : (
          <ul className="divide-y">
            {unread.data!.results.map((n) => (
              <li key={n.id} className="px-5 py-3">
                {n.link ? <Link href={n.link} className="font-medium hover:underline">{n.title}</Link> : <p className="font-medium">{n.title}</p>}
                <p className="text-xs text-muted-foreground">{ago(n.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
    </Section>
  );
}

function MfaLine() {
  const { me } = useSession();
  return (
    <div className="flex items-start gap-2">
      {me.mfa.enrolled ? (
        <ShieldCheck className="mt-0.5 size-4 text-status-approved" aria-hidden />
      ) : (
        <ShieldAlert className="mt-0.5 size-4 text-status-pending" aria-hidden />
      )}
      <dd>
        {me.mfa.enrolled ? "Two-step verification is on." : "Two-step verification is off."}{" "}
        <Link href="/account/security" className="underline underline-offset-4">Manage</Link>
      </dd>
    </div>
  );
}

/**
 * Platform operators run the hosting platform. They belong to no organization and hold no tenant
 * permissions, so tenant work queues (approvals, requests) would only answer 403: show what they can use.
 */
function OperatorHome() {
  const { me } = useSession();
  const firstName = me.user.full_name.split(" ")[0];
  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description="You're signed in as a platform operator. You administer organizations on this installation; you don't work inside any of them."
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Section title="Platform console" description="Create organizations, and suspend or reactivate them.">
          <div className="flex flex-col items-start gap-3 px-5 py-5">
            <p className="max-w-[60ch] text-sm text-muted-foreground">
              Every platform action asks for a fresh two-step verification code, because it changes who can sign in across the whole installation.
            </p>
            <Button asChild>
              <Link href="/platform"><Building2 aria-hidden /> Open organizations <ArrowRight aria-hidden /></Link>
            </Button>
          </div>
        </Section>
        <div className="grid content-start gap-6">
          <UnreadNotifications />
          <Section title="Your account">
            <dl className="grid gap-3 px-5 py-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Signed in as</dt>
                <dd className="mt-0.5 break-all">{me.user.email}</dd>
              </div>
              <MfaLine />
            </dl>
          </Section>
        </div>
      </div>
    </>
  );
}

export function HomeView() {
  const { isOperator } = useSession();
  return isOperator ? <OperatorHome /> : <TenantHome />;
}

function TenantHome() {
  const { me, activeCompany } = useSession();
  const inbox = useInbox();
  const mine = useQuery({
    queryKey: ["approvals", "mine", "recent"],
    queryFn: () => unwrap(api.GET("/api/v1/approvals/requests/", { params: { query: { mine: true, page_size: 5 } } })),
  });
  const firstName = me.user.full_name.split(" ")[0];

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={activeCompany ? `Working in ${activeCompany.name}.` : "You don't have access to a company yet."}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          <Section
            title="Waiting for your decision"
            description="Requests where you approve the current step."
            actions={inbox.data && inbox.data.length > 0 && (
              <Button variant="outline" size="sm" asChild><Link href="/approvals">Open approvals</Link></Button>
            )}
          >
            {inbox.isLoading ? <RowsSkeleton rows={3} /> : inbox.error ? <ErrorState error={inbox.error} onRetry={inbox.refetch} /> :
              inbox.data!.length === 0 ? (
                <EmptyState icon={CheckCheck} title="Nothing needs your approval" description="New requests appear here and in your notifications." />
              ) : (
                <ul className="divide-y">
                  {inbox.data!.slice(0, 6).map((r) => (
                    <li key={r.id}>
                      <Link href={`/approvals/${r.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-accent/60">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{r.title}</p>
                          <p className="truncate text-sm text-muted-foreground">
                            {r.document_label} {r.document_number} by {r.requested_by.full_name}, step {r.current_step_name}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="num font-medium">{money(r.amount, r.currency || "INR")}</p>
                          <p className="text-xs text-muted-foreground">waiting {ago(r.submitted_at).replace(" ago", "")}</p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
          </Section>

          <Section title="Your requests" description="The latest approvals you asked for."
            actions={<Button variant="ghost" size="sm" asChild><Link href="/approvals?tab=mine">See all</Link></Button>}>
            {mine.isLoading ? <RowsSkeleton rows={3} /> : mine.error ? <ErrorState error={mine.error} onRetry={mine.refetch} /> :
              mine.data!.results.length === 0 ? (
                <EmptyState icon={Inbox} title="You haven't submitted anything for approval" />
              ) : (
                <ul className="divide-y">
                  {mine.data!.results.map((r) => (
                    <li key={r.id}>
                      <Link href={`/approvals/${r.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-accent/60">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{r.title}</p>
                          <p className="text-sm text-muted-foreground">Submitted {dateTime(r.submitted_at)}</p>
                        </div>
                        <ApprovalStatus status={r.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
          </Section>
        </div>

        <div className="grid content-start gap-6">
          <UnreadNotifications />

          <Section title="Your access">
            <dl className="grid gap-3 px-5 py-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Roles</dt>
                <dd className="mt-0.5">{me.roles.length ? me.roles.join(", ") : "None yet. Ask an administrator for access."}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Companies</dt>
                <dd className="mt-0.5">{me.companies.map((c) => c.name).join(", ") || "None"}</dd>
              </div>
              <MfaLine />
            </dl>
          </Section>

          {me.permissions.codes.length === 0 && (
            <Section>
              <EmptyState icon={ClipboardCheck} title="No modules assigned yet"
                description="Your account works, but no role gives it access to any area. An administrator can grant access under Access grants." />
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
