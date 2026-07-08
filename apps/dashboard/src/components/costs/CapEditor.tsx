"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateProjectCap } from "@/app/actions/projects";
import { setFarmSetting } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
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
  const [caps, setCaps] = useState<Record<string, number>>(
    Object.fromEntries(projects.map((p) => [p.id, p.daily_cap_usd])),
  );
  const [farmLlm, setFarmLlm] = useState(farmDailyCap);
  const [farmMedia, setFarmMedia] = useState(farmMediaCap);

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
            <Button
              size="sm"
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  await setFarmSetting("farm_daily_cap_usd", farmLlm);
                  await setFarmSetting("farm_daily_media_cap_usd", farmMedia);
                  router.refresh();
                })
              }
            >
              Uložit farmové stropy
            </Button>
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
                  <span className="min-w-0 truncate text-sm">{p.name}</span>
                  <div className="flex items-center gap-2">
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
                      loading={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await updateProjectCap(p.id, caps[p.id] ?? p.daily_cap_usd);
                          router.refresh();
                        })
                      }
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
