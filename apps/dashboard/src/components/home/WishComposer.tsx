"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
    <div className="rounded-2xl border border-[--color-border-strong] bg-[--color-surface] p-4 shadow-sm sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[--color-brand-soft] text-sm text-[--color-brand]">
          ✦
        </span>
        <span className="text-sm font-medium text-[--color-muted]">
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
        className="w-full resize-y rounded-xl border border-[--color-border-strong] bg-[--color-surface-2] px-4 py-3 text-base text-[--color-fg] placeholder:text-[--color-muted] focus:border-[--color-accent] focus:outline-none focus:ring-1 focus:ring-[--color-accent]"
      />

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <span className="text-xs text-[--color-faint]">Kam:</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-9 min-w-40 rounded-lg border border-[--color-border-strong] bg-[--color-surface-2] px-3 text-sm text-[--color-fg] focus:border-[--color-accent] focus:outline-none"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NEW_PROJECT}>＋ Nový projekt…</option>
          </select>
          {creatingNew ? (
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Název nového projektu"
              className={cn(
                "h-9 min-w-44 flex-1 rounded-lg border bg-[--color-surface-2] px-3 text-sm text-[--color-fg] placeholder:text-[--color-muted] focus:outline-none",
                newName.trim() ? "border-[--color-border-strong]" : "border-[--color-accent]/50",
              )}
            />
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          {error ? <span className="text-xs text-[--color-danger]">{error}</span> : null}
          <span className="hidden text-xs text-[--color-faint] sm:inline">⌘⏎</span>
          <Button loading={pending} onClick={submit}>
            Poslat farmě
          </Button>
        </div>
      </div>
    </div>
  );
}
