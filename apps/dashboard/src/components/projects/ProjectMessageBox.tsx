"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createWishFromText } from "@/app/actions/wishes";
import { updateManagerNote } from "@/app/actions/projects";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { cn } from "@/lib/cn";

type Mode = "wish" | "note";

/**
 * Paralela k Telegramu: napiš projektu z dashboardu.
 * - „Úkol" → založí přání (source='dashboard') → manažer ho vyzvedne.
 * - „Poznámka manažerovi" → uloží projects.manager_note (řídí příští doplnění práce).
 * Vše inline přes server actions, bez přechodu na jinou stránku.
 */
export function ProjectMessageBox({
  projectId,
  initialNote,
  compact = false,
  projectPaused = false,
}: {
  projectId: string;
  initialNote?: string | null;
  compact?: boolean;
  /** Pozastavený projekt: přání se uloží, ale počká — musí to být řečeno předem. */
  projectPaused?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("wish");
  const [wishText, setWishText] = useState("");
  const [note, setNote] = useState(initialNote ?? "");
  const [flash, setFlash] = useState<string | null>(null);
  const [odkaz, setOdkaz] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function send() {
    setError(null);
    setFlash(null);
    setOdkaz(null);
    startTransition(async () => {
      if (mode === "wish") {
        const text = wishText.trim();
        if (!text) {
          setError("Napiš, co má farma udělat.");
          return;
        }
        const res = await createWishFromText({ projectId, text });
        if (!res.ok) {
          setError(res.message ?? "Odeslání selhalo.");
          return;
        }
        setWishText("");
        setFlash(
          projectPaused
            ? "Uloženo — projekt je pozastavený, přání počká."
            : "Odesláno — manažer přání zpracuje v příštím kole.",
        );
        setOdkaz(res.link ?? null);
        router.refresh();
      } else {
        const res = await updateManagerNote(projectId, note);
        if (!res.ok) {
          setError(res.message ?? "Uložení selhalo.");
          return;
        }
        setFlash("Uloženo — projeví se v příštím kole.");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-2.5">
      <div className="inline-flex rounded-lg border border-(--color-border) bg-(--color-surface-2) p-0.5 text-xs">
        {(
          [
            { id: "wish", label: "Úkol" },
            { id: "note", label: "Poznámka manažerovi" },
          ] as { id: Mode; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setMode(t.id);
              setError(null);
              setFlash(null);
            }}
            className={cn(
              "rounded-md px-2.5 py-1 font-medium transition-colors",
              mode === t.id
                ? "bg-(--color-surface) text-(--color-fg)"
                : "text-(--color-muted) hover:text-(--color-fg)",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mode === "wish" && projectPaused ? (
        <p className="text-xs text-(--color-warn)">Projekt je pozastavený — přání počká.</p>
      ) : null}

      {mode === "wish" ? (
        <Textarea
          value={wishText}
          onChange={(e) => {
            setWishText(e.target.value);
            setFlash(null);
          }}
          placeholder="Např. „přidej přihlášení přes Google a nasaď náhled"
          className={compact ? "min-h-16" : "min-h-20"}
        />
      ) : (
        <Textarea
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setFlash(null);
          }}
          placeholder="Např. „teď se soustřeď na výkon, přestaň refaktorovat"
          className={compact ? "min-h-16" : "min-h-20"}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" loading={pending} onClick={send}>
          {mode === "wish" ? "Poslat farmě" : "Uložit poznámku"}
        </Button>
        {flash ? <span className="text-xs text-(--color-ok)">{flash}</span> : null}
        {odkaz ? (
          <Link href={odkaz} className="text-xs text-(--color-brand) hover:underline">
            Otevřít přání
          </Link>
        ) : null}
        {error ? <span className="text-xs text-(--color-danger)">{error}</span> : null}
      </div>
    </div>
  );
}
