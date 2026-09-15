// Skeleton pro přechody mezi datově náročnými stránkami velína. Bez něj (žádné
// loading.tsx) navigace „zamrzla" na staré stránce, dokud nedoběhly všechny Supabase
// dotazy. Shimmer signalizuje živý stav a drží layout stabilní (bez skoku obsahu).

function Bar({ className = "" }: { className?: string }) {
  return <div className={`shimmer rounded-(--radius-sm) bg-(--color-surface-2) ${className}`} />;
}

export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Načítám…</span>

      {/* Hlavička */}
      <div className="mb-6 flex items-end justify-between gap-4">
        <div className="space-y-2.5">
          <Bar className="h-3 w-24" />
          <Bar className="h-7 w-64" />
        </div>
        <div className="hidden gap-6 sm:flex">
          <Bar className="h-12 w-20" />
          <Bar className="h-12 w-20" />
        </div>
      </div>

      {/* Mřížka karet */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="elev-1 space-y-4 rounded-(--radius-lg) border border-(--color-border-subtle) bg-(--color-surface-1) p-5"
          >
            <div className="flex items-center justify-between">
              <Bar className="h-4 w-32" />
              <Bar className="h-5 w-16 rounded-full" />
            </div>
            <Bar className="h-2 w-full rounded-full" />
            <div className="space-y-2">
              <Bar className="h-9 w-full" />
              <Bar className="h-9 w-full" />
            </div>
            <Bar className="h-2 w-full rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
