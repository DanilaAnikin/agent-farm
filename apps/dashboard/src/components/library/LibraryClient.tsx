"use client";

import { Images } from "lucide-react";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getAssetDownloadUrl, setAssetStatus } from "@/app/actions/library";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Select } from "@/components/ui/Field";
import { StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormMessage } from "@/components/ui/FormMessage";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { PublishDialog } from "@/components/library/PublishDialog";
import { MEDIA_STATUS_META } from "@/lib/constants";
import { formatBytes, formatDate, formatDuration, formatUsd } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { MediaAssetRow, MediaKind, MediaStatus } from "@/lib/types";

export interface AssetView {
  asset: MediaAssetRow;
  url: string | null;
  projectName: string;
}

const KIND_OPTIONS: { value: MediaKind | "all"; label: string }[] = [
  { value: "all", label: "Všechny typy" },
  { value: "reel", label: "Reely" },
  { value: "video_clip", label: "Video klipy" },
  { value: "image", label: "Obrázky" },
  { value: "music", label: "Hudba" },
  { value: "voiceover", label: "Voiceover" },
  { value: "thumbnail", label: "Náhledy" },
];

const STATUS_OPTIONS: { value: MediaStatus | "all"; label: string }[] = [
  { value: "all", label: "Všechny stavy" },
  { value: "generated", label: "Vygenerováno" },
  { value: "needs_review", label: "Ke kontrole" },
  { value: "selected", label: "Vybráno" },
  { value: "published", label: "Publikováno" },
  { value: "archived", label: "Archivováno" },
];

function MediaPreview({ view, className }: { view: AssetView; className?: string }) {
  const { asset, url } = view;
  if (!url) {
    return (
      <div className={cn("flex items-center justify-center bg-[--color-surface-2] text-[--color-faint]", className)}>
        bez náhledu
      </div>
    );
  }
  if (asset.kind === "video_clip" || asset.kind === "reel") {
    return <video src={url} controls className={cn("bg-black", className)} preload="metadata" />;
  }
  if (asset.kind === "music" || asset.kind === "voiceover") {
    return (
      <div className={cn("flex items-center justify-center bg-[--color-surface-2] p-3", className)}>
        <audio src={url} controls className="w-full" />
      </div>
    );
  }
  // image / thumbnail
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={asset.kind} className={cn("bg-black object-cover", className)} />;
}

export function LibraryClient({
  assets,
  projects,
}: {
  assets: AssetView[];
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<AssetView | null>(null);
  const [pending, startTransition] = useTransition();
  const [downloading, setDownloading] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<MediaStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return assets.filter((v) => {
      if (projectFilter !== "all" && v.asset.project_id !== projectFilter) return false;
      if (kindFilter !== "all" && v.asset.kind !== kindFilter) return false;
      if (statusFilter !== "all" && v.asset.status !== statusFilter) return false;
      return true;
    });
  }, [assets, projectFilter, kindFilter, statusFilter]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function downloadZip() {
    if (selected.size === 0) return;
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/zip";
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "ids";
    input.value = Array.from(selected).join(",");
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  }

  async function downloadOne(id: string) {
    // Dřív bez loading/disabled stavu → riziko dvojkliku a žádná chyba, když se signed
    // URL nepodařilo získat (nebo popup blokován).
    if (downloading) return;
    setDownloading(true);
    setActionError(null);
    try {
      const res = await getAssetDownloadUrl(id);
      if (res.ok && res.url) {
        const win = window.open(res.url, "_blank");
        if (!win) setActionError("Prohlížeč zablokoval otevření souboru — povol vyskakovací okna.");
      } else {
        setActionError(res.message ?? "Stažení se nepodařilo.");
      }
    } finally {
      setDownloading(false);
    }
  }

  function changeStatus(id: string, status: MediaStatus) {
    setActionError(null);
    setPendingStatus(status); // discriminator — ať spinner točí JEN klikané tlačítko
    startTransition(async () => {
      const res = await setAssetStatus(id, status);
      setPendingStatus(null);
      if (!res.ok) {
        // Dřív se výsledek ignoroval → dialog se zavřel jako by se povedlo.
        setActionError(res.message ?? "Změna stavu se nepodařila.");
        return;
      }
      setDetail(null);
      router.refresh();
    });
  }

  return (
    <>
      {/* Filtry a hromadné akce */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className="max-w-48">
          <option value="all">Všechny projekty</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="max-w-44">
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="max-w-44">
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-[--color-muted]">Vybráno {selected.size}</span>
          <Button size="sm" variant="secondary" disabled={selected.size === 0} onClick={downloadZip}>
            Stáhnout ZIP
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Images className="size-5" />}
          title="Knihovna je prázdná"
          description="Jakmile farma vygeneruje reely, obrázky nebo hudbu, objeví se tady ke stažení."
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((v) => (
            <Card key={v.asset.id} className="overflow-hidden">
              <div className="relative">
                <button className="block w-full" onClick={() => setDetail(v)}>
                  <MediaPreview view={v} className="aspect-square w-full" />
                </button>
                <label className="absolute left-2 top-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded bg-black/60">
                  <input
                    type="checkbox"
                    checked={selected.has(v.asset.id)}
                    onChange={() => toggle(v.asset.id)}
                    className="h-4 w-4"
                  />
                </label>
              </div>
              <CardBody className="space-y-1.5 p-3">
                <StatusBadge meta={MEDIA_STATUS_META[v.asset.status]} />
                <div className="flex items-center justify-between text-xs text-[--color-muted]">
                  <span className="truncate">{v.projectName}</span>
                  <span>{formatUsd(v.asset.cost_usd)}</span>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* Detail assetu */}
      <Dialog
        open={detail !== null}
        onOpenChange={(o) => {
          if (!o) {
            setDetail(null);
            setActionError(null);
          }
        }}
      >
        <DialogContent title="Detail assetu" className="max-w-2xl">
          {detail ? (
            <div className="space-y-4">
              <MediaPreview view={detail} className="max-h-80 w-full rounded-lg object-contain" />
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Meta label="Projekt" value={detail.projectName} />
                <Meta label="Typ" value={detail.asset.kind} />
                <Meta label="Stav" value={MEDIA_STATUS_META[detail.asset.status].label} />
                <Meta label="Cena" value={formatUsd(detail.asset.cost_usd)} />
                <Meta label="Model" value={String((detail.asset.meta?.["model"] as string) ?? "—")} />
                <Meta label="Velikost" value={formatBytes(detail.asset.size_bytes)} />
                <Meta label="Délka" value={formatDuration(detail.asset.duration_s)} />
                <Meta label="Vytvořeno" value={formatDate(detail.asset.created_at)} />
              </div>
              {typeof detail.asset.meta?.["prompt"] === "string" ? (
                <div>
                  <div className="text-xs text-[--color-muted]">Prompt</div>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{detail.asset.meta["prompt"] as string}</p>
                </div>
              ) : null}
              {detail.asset.meta?.["vlm_check"] ? (
                <div>
                  <div className="text-xs text-[--color-muted]">VLM kontrola</div>
                  <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-[--color-surface-2] p-2 text-xs">
                    {JSON.stringify(detail.asset.meta["vlm_check"], null, 2)}
                  </pre>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 border-t border-[--color-border] pt-4">
                <Button size="sm" loading={downloading} onClick={() => downloadOne(detail.asset.id)}>
                  Stáhnout
                </Button>
                <PublishDialog
                  assetId={detail.asset.id}
                  projectId={detail.asset.project_id}
                  defaultCaption={String((detail.asset.meta?.["caption"] as string) ?? "")}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  loading={pending && pendingStatus === "selected"}
                  disabled={pending}
                  onClick={() => changeStatus(detail.asset.id, "selected")}
                >
                  Označit jako použité
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending && pendingStatus === "archived"}
                  disabled={pending}
                  onClick={() => changeStatus(detail.asset.id, "archived")}
                >
                  Archivovat
                </Button>
                {actionError ? (
                  <FormMessage tone="error" className="w-full">
                    {actionError}
                  </FormMessage>
                ) : null}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-[--color-muted]">{label}</div>
      <div className="text-[--color-fg]">{value}</div>
    </div>
  );
}
