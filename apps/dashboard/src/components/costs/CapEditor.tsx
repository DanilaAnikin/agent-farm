"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateProjectCap } from "@/app/actions/projects";
import { setFarmSetting } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";

interface ProjectCap {
  id: string;
  name: string;
  daily_cap_usd: number;
}

export function CapEditor({
  projects,
  isAdmin,
  farmDailyCap,
  farmMediaCap,
}: {
  projects: ProjectCap[];
  isAdmin: boolean;
  farmDailyCap: number;
  farmMediaCap: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Který řádek se právě ukládá — aby spinner točilo JEN klikané tlačítko (dřív jeden
  // sdílený `pending` točil všechna tlačítka najednou, jako by se ukládalo vše).
  const [savingId, setSavingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<
    Record<string, { tone: "success" | "error"; text: string } | undefined>
  >({});
  const [caps, setCaps] = useState<Record<string, number>>(
    Object.fromEntries(projects.map((p) => [p.id, p.daily_cap_usd])),
  );
  const [farmLlm, setFarmLlm] = useState(farmDailyCap);
  const [farmMedia, setFarmMedia] = useState(farmMediaCap);

  function run(id: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    setSavingId(id);
    setFeedback((f) => ({ ...f, [id]: undefined }));
    startTransition(async () => {
      const res = await fn();
      setSavingId(null);
      setFeedback((f) => ({
        ...f,
        [id]: res.ok
          ? { tone: "success", text: "Uloženo." }
          : { tone: "error", text: res.message ?? "Uložení se nepodařilo." },
      }));
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {isAdmin ? (
        <Card>
          <CardHeader title="Farmové stropy (admin)" description="Propíše se do LiteLLM přes orchestrátor." />
          <CardBody className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-[--color-muted]">
              Denní LLM strop (USD)
              <Input
                type="number"
                step="1"
                value={farmLlm}
                onChange={(e) => setFarmLlm(Number(e.target.value))}
                className="mt-1 max-w-32"
              />
            </label>
            <label className="text-xs text-[--color-muted]">
              Denní media strop (USD)
              <Input
                type="number"
                step="1"
                value={farmMedia}
                onChange={(e) => setFarmMedia(Number(e.target.value))}
                className="mt-1 max-w-32"
              />
            </label>
            <div className="flex flex-col gap-1">
              <Button
                size="sm"
                loading={pending && savingId === "farm"}
                disabled={pending && savingId !== "farm"}
                onClick={() =>
                  run("farm", async () => {
                    const a = await setFarmSetting("farm_daily_cap_usd", farmLlm);
                    if (!a.ok) return a;
                    return setFarmSetting("farm_daily_media_cap_usd", farmMedia);
                  })
                }
              >
                Uložit farmové stropy
              </Button>
              {feedback.farm ? (
                <FormMessage tone={feedback.farm.tone}>{feedback.farm.text}</FormMessage>
              ) : null}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Denní stropy projektů" description="Změna se hned promítne do dispatch loopu." />
        <CardBody>
          {projects.length === 0 ? (
            <p className="text-sm text-[--color-muted]">Žádné projekty.</p>
          ) : (
            <ul className="space-y-2">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                  <div className="flex items-center gap-2">
                    {feedback[p.id] ? (
                      <FormMessage tone={feedback[p.id]!.tone}>{feedback[p.id]!.text}</FormMessage>
                    ) : null}
                    <Input
                      type="number"
                      step="0.5"
                      value={caps[p.id] ?? p.daily_cap_usd}
                      onChange={(e) => setCaps((c) => ({ ...c, [p.id]: Number(e.target.value) }))}
                      className="max-w-28"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={pending && savingId === p.id}
                      disabled={pending && savingId !== p.id}
                      onClick={() => run(p.id, () => updateProjectCap(p.id, caps[p.id] ?? p.daily_cap_usd))}
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
