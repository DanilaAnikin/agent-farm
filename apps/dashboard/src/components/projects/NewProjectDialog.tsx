"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/app/actions/projects";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { formatUsd } from "@/lib/format";
import type { RepoMode } from "@/lib/types";

/** Výchozí rozpočty spočítané na serveru ze stropů farmy (viz farmBudgetDefaults). */
export interface NewProjectDefaults {
  projectDailyUsd: number;
  projectMonthlyUsd: number;
  farmDailyUsd: number;
  farmMonthlyUsd: number;
}

export function NewProjectDialog({
  trigger,
  defaults,
}: {
  trigger?: React.ReactNode;
  defaults: NewProjectDefaults;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [repoMode, setRepoMode] = useState<RepoMode>("new");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await createProject(formData);
      if (!res.ok) {
        setError(res.message ?? "Nepodařilo se založit projekt.");
        return;
      }
      setOpen(false);
      if (res.id) router.push(`/projects/${res.id}`);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>{trigger ?? <Button>Nový projekt</Button>}</DialogTrigger>
      <DialogContent
        title="Nový projekt"
        description="Jeden projekt na jednu věc — vlastní agenti, rozpočty a repozitář. Farma na něm pracuje sama, bez schvalování."
      >
        <form action={onSubmit} className="space-y-4">
          <Field label="Název" htmlFor="name">
            <Input id="name" name="name" required placeholder="Např. IG kanál o AI nástrojích" />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Typ" htmlFor="kind">
              <Select id="kind" name="kind" defaultValue="code">
                <option value="code">Kód (appka/CLI)</option>
                <option value="content">Obsah (reely/IG)</option>
                <option value="mixed">Smíšený</option>
              </Select>
            </Field>
            <Field label="Repozitář" htmlFor="repo_mode">
              <Select
                id="repo_mode"
                name="repo_mode"
                value={repoMode}
                onChange={(e) => setRepoMode(e.target.value as RepoMode)}
              >
                <option value="new">Nový (farma založí)</option>
                <option value="existing">Existující</option>
                <option value="none">Žádný</option>
              </Select>
            </Field>
          </div>

          {repoMode === "existing" ? (
            <>
              <Field label="URL repozitáře" htmlFor="repo_url">
                <Input id="repo_url" name="repo_url" placeholder="https://github.com/…" />
              </Field>
              <Field
                label="Jak appku spustit"
                htmlFor="env_recipe"
                hint="bez produkčních přístupových údajů (JSON nebo popis)"
              >
                <Textarea
                  id="env_recipe"
                  name="env_recipe"
                  placeholder='{ "setup": "supabase start", "env_example": ".env.example" }'
                />
              </Field>
            </>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Měsíční rozpočet (US$)" htmlFor="monthly_budget_usd">
              <Input
                id="monthly_budget_usd"
                name="monthly_budget_usd"
                type="number"
                min={0}
                max={defaults.farmMonthlyUsd}
                step="0.01"
                defaultValue={defaults.projectMonthlyUsd}
              />
            </Field>
            <Field label="Denní strop (US$)" htmlFor="daily_cap_usd">
              <Input
                id="daily_cap_usd"
                name="daily_cap_usd"
                type="number"
                min={0}
                max={defaults.farmDailyUsd}
                step="0.01"
                defaultValue={defaults.projectDailyUsd}
              />
            </Field>
          </div>
          <p className="text-xs text-[--color-muted]">
            farma: {formatUsd(defaults.farmDailyUsd, "cap")}/den · {formatUsd(defaults.farmMonthlyUsd, "cap")}/měsíc
            — strop projektu se dělí se stropem farmy a nesmí být vyšší.
          </p>

          {error ? <p role="alert" className="text-xs text-[--color-danger]">{error}</p> : null}

          <DialogFooter>
            <DialogClose>Zrušit</DialogClose>
            <Button type="submit" loading={pending}>
              Založit projekt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
