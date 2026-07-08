"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/app/actions/projects";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import type { RepoMode } from "@/lib/types";

export function NewProjectDialog({ trigger }: { trigger?: React.ReactNode }) {
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
      <DialogContent title="Nový projekt" description="Jeden projekt na jednu věc — vlastní agenti, rozpočty a repo.">
        <form action={onSubmit} className="space-y-4">
          <Field label="Název" htmlFor="name">
            <Input id="name" name="name" required placeholder="Např. IG kanál o AI nástrojích" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
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
                label="Env recipe"
                htmlFor="env_recipe"
                hint="jak appku spustit bez produkčních credentials (JSON nebo popis)"
              >
                <Textarea
                  id="env_recipe"
                  name="env_recipe"
                  placeholder='{ "setup": "supabase start", "env_example": ".env.example" }'
                />
              </Field>
            </>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Měsíční rozpočet (USD)" htmlFor="monthly_budget_usd">
              <Input id="monthly_budget_usd" name="monthly_budget_usd" type="number" step="1" defaultValue={200} />
            </Field>
            <Field label="Denní strop (USD)" htmlFor="daily_cap_usd">
              <Input id="daily_cap_usd" name="daily_cap_usd" type="number" step="0.5" defaultValue={3} />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-[--color-muted]">
            <input type="checkbox" name="trust_mode" className="h-4 w-4 rounded border-[--color-border-strong] bg-[--color-surface-2]" />
            Trust mode — přeskočit schvalování specifikací
          </label>

          {error ? <p className="text-xs text-[--color-danger]">{error}</p> : null}

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
