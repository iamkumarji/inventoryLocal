import { Wordmark } from "@/components/shell/sidebar";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <Wordmark />
        <div className="max-w-md">
          <p className="type-signage text-[2.6rem] text-white">
            Plant, stores, purchasing and accounts on one ledger.
          </p>
          <p className="mt-4 text-sidebar-foreground/80">
            Every stock movement and every rupee posted once, approved by the right person, and traceable afterwards.
          </p>
        </div>
        {/* A single floor-marking line anchors the panel, as it would on a shop floor. */}
        <div aria-hidden className="h-[3px] w-24 bg-sidebar-primary" />
      </aside>
      <main className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-10 lg:hidden">
            <span className="inline-flex rounded-md bg-sidebar px-3 py-2">
              <Wordmark />
            </span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
