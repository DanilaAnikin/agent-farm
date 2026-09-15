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
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-(--color-accent)/50 disabled:opacity-50",
        checked ? "bg-(--color-accent)" : "bg-(--color-border-strong)",
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
        <div className="text-sm font-medium text-(--color-fg)">{title}</div>
        <p className="mt-0.5 text-xs text-(--color-muted)">{hint}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

/**
 * Autonomie projektu — popis SKUTEČNÉ politiky farmy. Žádné sliby o čekání na
 * „tap" nebo ručním schvalování: specifikace schvaluje autopilot, práci
 * kontrolují automatické brány (soudce, testy, QA) a nasazení hlídá kontrola
 * zdraví s návratem k předchozí verzi. Přepínače mění jen to, co orchestrátor
 * opravdu čte — dřívější „Autopilot práce" (autonomy.selfRun) nečetl nikdo,
 * převod návrhů na přání je jediné chování farmy.
 */
export function AutonomyControls({
  projectId,
  initial,
  trustMode,
}: {
  projectId: string;
  initial: ProjectAutonomy;
  /** projects.trust_mode — specifikace se schvalují automaticky. */
  trustMode: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `proactive` je v orchestrátoru výchozí zapnutý (vypíná ho jen explicitní false).
  const [proactive, setProactive] = useState(initial.proactive !== false);
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
      autoDeliver,
      deliverDailyCap: cap,
      ...overrides,
    };
  }

  return (
    <div>
      <ul className="mb-2 space-y-1 text-xs text-(--color-muted)">
        <li>
          <span className="text-(--color-fg)">Specifikace:</span>{" "}
          {trustMode ? "schvalují se automaticky." : "projekt má vypnutý autopilot specifikací (starší nastavení)."}
        </li>
        <li>
          <span className="text-(--color-fg)">Kontrola práce:</span> soudce, testy a QA — úkol je hotový až po
          sloučení do hlavní větve.
        </li>
        <li>
          <span className="text-(--color-fg)">Návrhy:</span> samy se zadávají jako přání a farma je odpracuje až do
          sloučení.
        </li>
        <li>
          <span className="text-(--color-fg)">Rozpočet:</span> hlídá ho strop projektu a rozpočtový hlídač farmy.
        </li>
      </ul>

      <div className="divide-y divide-(--color-border)">
        <Row
          title="Farma sama vybírá další práci"
          hint="Sleduje repozitář a stav projektu, navrhuje další krok a sama ho zadá jako přání. Duplicity a nápady, které repozitář nepodporuje, zahazuje. Vypnuto = farma v projektu sama novou práci nevybírá ani nezadává."
        >
          <Switch
            label="Farma sama vybírá další práci"
            checked={proactive}
            disabled={pending}
            onChange={(v) => {
              setProactive(v);
              persist(current({ proactive: v }));
            }}
          />
        </Row>

        <Row
          title="Automatické doručení"
          hint="Hotová práce se po úspěšném QA sama doručí — publikace a nasazení přes automatické brány (kontrola zdraví a návrat k předchozí verzi), do denního limitu."
        >
          <Switch
            label="Automatické doručení"
            checked={autoDeliver}
            disabled={pending}
            onChange={(v) => {
              setAutoDeliver(v);
              persist(current({ autoDeliver: v }));
            }}
          />
        </Row>

        {autoDeliver ? (
          <Row title="Denní limit doručení" hint="Kolik nevratných doručení denně smí projít; další se odloží.">
            <input
              type="number"
              min={0}
              step={1}
              value={cap}
              disabled={pending}
              aria-label="Denní limit doručení"
              onChange={(e) => setCap(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              onBlur={() => persist(current({ deliverDailyCap: cap }))}
              className="h-9 w-20 rounded-lg border border-(--color-border-strong) bg-(--color-surface-2) px-2.5 text-right text-sm tabular-nums text-(--color-fg) focus:border-(--color-accent) focus:outline-none focus:ring-1 focus:ring-(--color-accent) disabled:opacity-50"
            />
          </Row>
        ) : null}
      </div>

      <div className="mt-3 h-4 text-xs">
        {error ? (
          <span className="text-(--color-danger)">{error}</span>
        ) : flash ? (
          <span className="text-(--color-ok)">{flash}</span>
        ) : (
          <span className="text-(--color-faint)">Změny se ukládají hned.</span>
        )}
      </div>
    </div>
  );
}
