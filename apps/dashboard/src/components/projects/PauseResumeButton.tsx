"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hourglass, Pause, Play } from "lucide-react";
import { getResumePreview, resumeProject, setProjectStatus, type ResumePreview } from "@/app/actions/projects";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { FormMessage } from "@/components/ui/FormMessage";
import { formatDateShort, formatRelative } from "@/lib/format";
import { countLabel, TVARY } from "@/lib/plural";
import type { ProjectStatus } from "@/lib/types";

/**
 * Pozastavit / spustit projekt.
 *
 * - „Pozastavit" bez dialogu — zastavit utrácení musí jít na jeden klik.
 * - „Spustit" s dialogem: ukáže, kolik úkolů čeká a jak jsou staré, a jako
 *   výchozí nabídne archivaci fronty starší než 30 dní. Pozastavené projekty
 *   mají ve frontě úkoly ze srpna, které by se jinak rozjely nad dávno změněným
 *   repozitářem.
 * - Projekt v rolloutu (`stopped`) se nespouští ručně: zapne ho rollout sám po
 *   zdravotních branách.
 */
export function PauseResumeButton({
  projectId,
  status,
  size = "md",
}: {
  projectId: string;
  status: ProjectStatus;
  size?: "sm" | "md" | "lg";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ResumePreview | null>(null);
  const [archivovat, setArchivovat] = useState(true);

  if (status === "stopped") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-[--color-muted]"
        title="Postupný rollout zapíná projekty po jednom, když projdou zdravotní brány."
      >
        <Hourglass className="size-3.5 shrink-0" />
        Čeká v rolloutu (zapne se automaticky po zdravotních branách)
      </span>
    );
  }

  const isPaused = status === "paused";

  function pozastavit() {
    setError(null);
    startTransition(async () => {
      const res = await setProjectStatus(projectId, "paused");
      if (!res.ok) {
        // Bez zpětné vazby by neúspěšná pauza vypadala jako úspěch — uživatel by
        // si myslel, že drahý projekt zastavil, zatímco agenti dál pálí rozpočet.
        setError(res.message ?? "Pozastavení se nepodařilo.");
        return;
      }
      router.refresh();
    });
  }

  function otevritSpusteni() {
    setError(null);
    setPreview(null);
    setOpen(true);
    startTransition(async () => {
      const p = await getResumePreview(projectId);
      setPreview(p);
      setArchivovat(p.stale > 0);
    });
  }

  function spustit() {
    setError(null);
    startTransition(async () => {
      const res = await resumeProject(projectId, { archiveStale: archivovat && (preview?.stale ?? 0) > 0 });
      if (!res.ok) {
        setError(res.message ?? "Spuštění se nepodařilo.");
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        size={size}
        variant={isPaused ? "success" : "secondary"}
        loading={pending && !open}
        onClick={isPaused ? otevritSpusteni : pozastavit}
      >
        {isPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
        {isPaused ? "Spustit" : "Pozastavit"}
      </Button>
      {error && !open ? <FormMessage tone="error">{error}</FormMessage> : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Spustit projekt"
          description="Farma na projektu začne pracovat sama v příštím kole."
        >
          {!preview ? (
            <p className="text-sm text-[--color-muted]">Načítám frontu projektu…</p>
          ) : !preview.ok ? (
            <FormMessage tone="error">{preview.message ?? "Frontu se nepodařilo načíst."}</FormMessage>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-[--color-fg]">
                Ve frontě čeká {countLabel(preview.queued, TVARY.ukol)}
                {preview.oldestQueuedAt ? (
                  <>
                    , nejstarší z {formatDateShort(preview.oldestQueuedAt)} ({formatRelative(preview.oldestQueuedAt)})
                  </>
                ) : null}
                .
              </p>
              {preview.stale > 0 ? (
                <fieldset className="space-y-2">
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="fronta"
                      checked={archivovat}
                      onChange={() => setArchivovat(true)}
                      className="mt-1"
                    />
                    <span>
                      Archivovat {countLabel(preview.stale, TVARY.ukol)} starších než {preview.staleDays} dní a začít
                      od aktuálního stavu repozitáře
                      <span className="block text-xs text-[--color-muted]">
                        Doporučeno. Úkoly se nesmažou, jen se odloží jako historická fronta.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="fronta"
                      checked={!archivovat}
                      onChange={() => setArchivovat(false)}
                      className="mt-1"
                    />
                    <span>Pokračovat ve staré frontě</span>
                  </label>
                </fieldset>
              ) : null}
            </div>
          )}
          {error ? <FormMessage tone="error" className="mt-3">{error}</FormMessage> : null}
          <DialogFooter>
            <Button variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
              Zrušit
            </Button>
            <Button variant="success" loading={pending} disabled={!preview?.ok} onClick={spustit}>
              <Play className="size-4" /> Spustit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
