"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateProjectAutonomy } from "@/app/actions/autonomy";
import { cn } from "@/lib/cn";
import type { ProjectAutonomy } from "@/lib/types";

/** Přepínač (switch) ve stylu značky. */
function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[--color-accent]/50 disabled:opacity-50",
        checked ? "bg-[--color-accent]" : "bg-[--color-border-strong]",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  );
}

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-[--color-fg]">{title}</div>
        <p className="mt-0.5 text-xs text-[--color-muted]">{hint}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

/**
 * Ovládání autonomie projektu — UNIVERZÁLNÍ (o jakémkoliv výstupu, ne jen reely).
 * Uloží se hned po změně přes server action.
 */
export function AutonomyControls({
  projectId,
  initial,
}: {
  projectId: string;
  initial: ProjectAutonomy;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [proactive, setProactive] = useState(Boolean(initial.proactive));
  const [selfRun, setSelfRun] = useState(Boolean(initial.selfRun));
  const [autoDeliver, setAutoDeliver] = useState(Boolean(initial.autoDeliver));
  const [cap, setCap] = useState<number>(
    typeof initial.deliverDailyCap === "number" ? initial.deliverDailyCap : 1,
  );

  function persist(next: ProjectAutonomy) {
    setError(null);
    setFlash(null);
    startTransition(async () => {
      const res = await updateProjectAutonomy(projectId, next);
      if (!res.ok) {
        setError(res.message ?? "Uložení selhalo.");
        return;
      }
      setFlash("Uloženo");
      router.refresh();
    });
  }

  function current(overrides: Partial<ProjectAutonomy>): ProjectAutonomy {
    return {
      proactive,
      selfRun,
      autoDeliver,
      deliverDailyCap: cap,
      ...overrides,
    };
  }

  return (
    <div>
      <div className="divide-y divide-[--color-border]">
        <Row
          title="Proaktivní návrhy"
          hint="Farma sama sleduje projekt a navrhuje nejcennější další krok (co dál) — feature, oprava, test, automatizace, integrace, obsah, příležitost…"
        >
          <Switch
            checked={proactive}
            disabled={pending}
            onChange={(v) => {
              setProactive(v);
              persist(current({ proactive: v }));
            }}
          />
        </Row>

        <Row
          title="Autopilot exekuce"
          hint="Nejlepší návrhy se samy převedou na přání a farma je odpracuje od začátku do konce bez tvého zásahu."
        >
          <Switch
            checked={selfRun}
            disabled={pending}
            onChange={(v) => {
              setSelfRun(v);
              persist(current({ selfRun: v }));
            }}
          />
        </Row>

        <Row
          title="Auto-doručení"
          hint="Nevratné akce (např. zveřejnění hotového výstupu) se schválí samy do denního limitu — jinak počkají na tvůj tap. Produkční nasazení se schvaluje vždy ručně."
        >
          <Switch
            checked={autoDeliver}
            disabled={pending}
            onChange={(v) => {
              setAutoDeliver(v);
              persist(current({ autoDeliver: v }));
            }}
          />
        </Row>

        {autoDeliver ? (
          <Row
            title="Denní limit doručení"
            hint="Kolik nevratných doručení denně smí projít samo. Nad limit se čeká na tvé schválení."
          >
            <input
              type="number"
              min={0}
              step={1}
              value={cap}
              disabled={pending}
              onChange={(e) => setCap(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              onBlur={() => persist(current({ deliverDailyCap: cap }))}
              className="h-9 w-20 rounded-lg border border-[--color-border-strong] bg-[--color-surface-2] px-2.5 text-right text-sm tabular-nums text-[--color-fg] focus:border-[--color-accent] focus:outline-none focus:ring-1 focus:ring-[--color-accent] disabled:opacity-50"
            />
          </Row>
        ) : null}
      </div>

      <div className="mt-3 h-4 text-xs">
        {error ? (
          <span className="text-[--color-danger]">{error}</span>
        ) : flash ? (
          <span className="text-[--color-ok]">{flash}</span>
        ) : (
          <span className="text-[--color-faint]">Změny se ukládají hned.</span>
        )}
      </div>
    </div>
  );
}
