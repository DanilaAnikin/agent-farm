"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestPublish } from "@/app/actions/library";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field, Textarea } from "@/components/ui/Field";

export function PublishDialog({
  assetId,
  projectId,
  defaultCaption,
}: {
  assetId: string;
  projectId: string;
  defaultCaption?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [caption, setCaption] = useState(defaultCaption ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await requestPublish({ assetId, projectId, caption });
      if (!res.ok) {
        setError(res.message ?? "Nepodařilo se vytvořit žádost.");
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>
        <Button size="sm" variant="secondary">
          Publikovat na Instagram
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Publikovat na Instagram"
        description="Vytvoří žádost o publikaci a schválení. Publisher odešle až po schválení."
      >
        <Field label="Popisek (caption)" htmlFor="caption">
          <Textarea id="caption" value={caption} onChange={(e) => setCaption(e.target.value)} className="min-h-32" />
        </Field>
        <p className="mt-2 text-xs text-[--color-muted]">
          Povinné AI-disclosure přidá Publisher automaticky. Max 3 posty/den/účet.
        </p>
        {error ? <p className="mt-2 text-xs text-[--color-danger]">{error}</p> : null}
        <DialogFooter>
          <DialogClose>Zrušit</DialogClose>
          <Button loading={pending} onClick={submit}>
            Odeslat ke schválení
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
