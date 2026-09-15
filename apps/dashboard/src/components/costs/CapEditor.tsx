"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateProjectCap } from "@/app/actions/projects";
import { setFarmSetting } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Field, MoneyInput } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { parseDecimalInput } from "@/lib/admin-guards";
import { formatUsd } from "@/lib/format";

interface ProjectCap {
  id: string;
  name: string;
  daily_cap_usd: number;
}

type Feedback = { tone: "success" | "error"; text: string };

function doPole(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : "";
}

/** Pole → číslo, nebo česká chyba. Prázdno se odmítá (není to „0"). */
function precti(label: string, raw: string): { ok: true; value: number } | { ok: false; text: string } {
  const n = parseDecimalInput(raw);
  if (n === null) return { ok: false, text: `${label}: vyplň částku.` };
  if (Number.isNaN(n)) return { ok: false, text: `${label}: zadej číslo, např. 0,60.` };
  if (n < 0) return { ok: false, text: `${label}: částka nesmí být záporná.` };
  return { ok: true, value: n };
}

export function CapEditor({
  projects,
  isAdmin,
  farmDailyCap,
  farmMediaCap,
  farmMonthlyCap,
}: {
  projects: ProjectCap[];
  isAdmin: boolean;
  farmDailyCap: number;
  farmMediaCap: number;
  farmMonthlyCap: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Který řádek se právě ukládá — aby spinner točilo JEN klikané tlačítko (dřív jeden
  // sdílený `pending` točil všechna tlačítka najednou, jako by se ukládalo vše).
  const [savingId, setSavingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback | undefined>>({});
  const [caps, setCaps] = useState<Record<string, string>>(
    Object.fromEntries(projects.map((p) => [p.id, doPole(p.daily_cap_usd)])),
  );
  const [farmMonth, setFarmMonth] = useState(doPole(farmMonthlyCap));
  const [farmLlm, setFarmLlm] = useState(doPole(farmDailyCap));
  const [farmMedia, setFarmMedia] = useState(doPole(farmMediaCap));

  function run(id: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    setSavingId(id);
    setFeedback((f) => ({ ...f, [id]: undefined }));
    startTransition(async () => {
      const res = await fn();
      setSavingId(null);
      setFeedback((f) => ({
        ...f,
        [id]: res.ok
          ? { tone: "success", text: res.message ?? "Uloženo." }
          : { tone: "error", text: res.message ?? "Uložení se nepodařilo." },
      }));
      if (res.ok) router.refresh();
    });
  }

  function saveFarm() {
    const polozky = [
      { key: "farm_monthly_cap_usd", label: "Měsíční strop farmy", raw: farmMonth },
      { key: "farm_daily_cap_usd", label: "Denní strop farmy (modely)", raw: farmLlm },
      { key: "farm_daily_media_cap_usd", label: "Denní strop médií", raw: farmMedia },
    ] as const;
    const hodnoty: { key: (typeof polozky)[number]["key"]; value: number; label: string }[] = [];
    for (const p of polozky) {
      const v = precti(p.label, p.raw);
      if (!v.ok) {
        setFeedback((f) => ({ ...f, farm: { tone: "error", text: v.text } }));
        return;
      }
      hodnoty.push({ key: p.key, value: v.value, label: p.label });
    }
    const nuly = hodnoty.filter((h) => h.value === 0);
    if (nuly.length > 0) {
      const ok = window.confirm(
        `${nuly.map((n) => n.label).join(", ")}: 0 = farma nebude utrácet a práce se zastaví. Opravdu uložit?`,
      );
      if (!ok) return;
    }
    run("farm", async () => {
      for (const h of hodnoty) {
        const res = await setFarmSetting(h.key, h.value);
        if (!res.ok) return { ok: false, message: `${h.label}: ${res.message ?? "uložení se nepodařilo."}` };
      }
      return { ok: true, message: "Uloženo. Platí okamžitě." };
    });
  }

  function saveProject(p: ProjectCap) {
    const v = precti("Strop projektu", caps[p.id] ?? "");
    if (!v.ok) {
      setFeedback((f) => ({ ...f, [p.id]: { tone: "error", text: v.text } }));
      return;
    }
    if (v.value === 0 && !window.confirm(`0 = projekt ${p.name} nebude utrácet. Opravdu uložit?`)) return;
    run(p.id, () => updateProjectCap(p.id, v.value));
  }

  return (
    <div className="space-y-4">
      {isAdmin ? (
        <Card>
          <CardHeader
            title="Stropy farmy"
            description="Platí okamžitě — čte ho rozpočtová brána před každým voláním modelu i orchestrátor."
          />
          <CardBody className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Měsíční strop farmy" htmlFor="cap_month" hint="max 50 US$">
                <MoneyInput id="cap_month" value={farmMonth} onChange={(e) => setFarmMonth(e.target.value)} />
              </Field>
              <Field label="Denní strop farmy (modely)" htmlFor="cap_day" hint="max 5 US$">
                <MoneyInput id="cap_day" value={farmLlm} onChange={(e) => setFarmLlm(e.target.value)} />
              </Field>
              <Field label="Denní strop médií (obrázky, hlas)" htmlFor="cap_media" hint="max 5 US$">
                <MoneyInput id="cap_media" value={farmMedia} onChange={(e) => setFarmMedia(e.target.value)} />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                loading={pending && savingId === "farm"}
                disabled={pending && savingId !== "farm"}
                onClick={saveFarm}
              >
                Uložit stropy farmy
              </Button>
              {feedback.farm ? <FormMessage tone={feedback.farm.tone}>{feedback.farm.text}</FormMessage> : null}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Denní stropy projektů"
          description={`Omezují práci workerů daného projektu a platí hned v plánovači úkolů. Celkově vždy platí strop farmy (${formatUsd(farmDailyCap, "cap")}/den).`}
        />
        <CardBody>
          {projects.length === 0 ? (
            <p className="text-sm text-[--color-muted]">Žádné projekty.</p>
          ) : (
            <ul className="space-y-2">
              {projects.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {feedback[p.id] ? (
                      <FormMessage tone={feedback[p.id]!.tone}>{feedback[p.id]!.text}</FormMessage>
                    ) : null}
                    <MoneyInput
                      value={caps[p.id] ?? ""}
                      onChange={(e) => setCaps((c) => ({ ...c, [p.id]: e.target.value }))}
                      wrapperClassName="w-32"
                      aria-label={`Denní strop projektu ${p.name}`}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={pending && savingId === p.id}
                      disabled={pending && savingId !== p.id}
                      onClick={() => saveProject(p)}
                    >
                      Uložit
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
