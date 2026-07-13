"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ChevronDown, ArrowUp } from "lucide-react";
import { submitFarmWish } from "@/app/actions/wishes";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export interface ComposerProject {
  id: string;
  name: string;
}

const NEW_PROJECT = "__new__";

/**
 * THE primary action velína: „Řekni farmě, co má udělat".
 * Volný text + volba cíle: existující projekt, nebo rovnou nový.
 * Odeslání = přání source='dashboard' (manager smyčka ho vyzvedne).
 */
export function WishComposer({ projects }: { projects: ComposerProject[] }) {
  const router = useRouter();
  const hasProjects = projects.length > 0;
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string>(hasProjects ? (projects[0]?.id ?? NEW_PROJECT) : NEW_PROJECT);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const creatingNew = target === NEW_PROJECT;

  function submit() {
    setError(null);
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Napiš, co má farma udělat.");
      return;
    }
    startTransition(async () => {
      const res = await submitFarmWish({
        projectId: creatingNew ? undefined : target,
        newProjectName: creatingNew ? newName.trim() : undefined,
        text: trimmed,
      });
      if (!res.ok) {
        setError(res.message ?? "Odeslání selhalo.");
        return;
      }
      setText("");
      setNewName("");
      if (res.id) router.push(`/projects/${res.id}`);
      router.refresh();
    });
  }

  return (
    // Hero action — centrum gravitace velína: brand rámování + jemná záře + well.
    <div className="relative overflow-hidden rounded-[--radius-xl] border border-[--color-brand]/15 bg-[--color-surface-1] p-4 elev-1 sm:p-5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-24 h-40 bg-[radial-gradient(50%_100%_at_50%_100%,var(--color-brand-glow),transparent_70%)] opacity-40"
      />
      <div className="relative">
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-[--radius-sm] bg-[--color-brand-soft] text-[--color-brand]">
            <Sparkles className="size-4" />
          </span>
          <span className="t-body-strong text-[--color-fg]">
            Řekni farmě, co má udělat — zbytek zařídí agenti
          </span>
        </div>

        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          rows={3}
          placeholder="Např. „Postav mi appku na správu úkolů s přihlášením přes Google a nasaď preview…"
          className="ring-focus w-full resize-y rounded-[--radius-lg] border border-[--color-border] bg-[--color-bg-sunken] px-4 py-3 text-[15px] leading-relaxed text-[--color-fg] transition-colors placeholder:text-[--color-faint] focus:border-[--color-brand] focus:outline-none"
        />

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <span className="t-eyebrow">Kam</span>
            <div className="relative">
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                aria-label="Cílový projekt"
                className="ring-focus h-9 min-w-40 appearance-none rounded-[--radius-sm] border border-[--color-border] bg-[--color-surface-2] pl-3 pr-8 text-sm text-[--color-fg] focus:border-[--color-brand] focus:outline-none"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value={NEW_PROJECT}>+ Nový projekt…</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-[--color-tertiary]" />
            </div>
            {creatingNew ? (
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Název nového projektu"
                aria-label="Název nového projektu"
                className={cn(
                  "ring-focus h-9 min-w-44 flex-1 rounded-[--radius-sm] border bg-[--color-surface-2] px-3 text-sm text-[--color-fg] placeholder:text-[--color-faint] focus:outline-none",
                  newName.trim() ? "border-[--color-border]" : "border-[--color-brand]/50",
                )}
              />
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            {error ? <span className="text-xs text-[--color-danger]">{error}</span> : null}
            <kbd className="t-code hidden rounded border border-[--color-border] bg-[--color-bg-sunken] px-1.5 py-0.5 text-[--color-tertiary] sm:inline">
              ⌘⏎
            </kbd>
            <Button loading={pending} onClick={submit}>
              {!pending && <ArrowUp className="size-4" />} Poslat farmě
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
