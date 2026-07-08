import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { LibraryClient, type AssetView } from "@/components/library/LibraryClient";
import type { MediaAssetRow, ProjectRow } from "@/lib/types";

export const metadata = { title: "Knihovna — Perennial" };

export default async function LibraryPage() {
  const supabase = await createClient();

  const [{ data: assetsData }, { data: projectsData }] = await Promise.all([
    supabase
      .from("media_assets")
      .select("*")
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("projects").select("id, name"),
  ]);

  const assets = (assetsData as MediaAssetRow[] | null) ?? [];
  const projects = (projectsData as Pick<ProjectRow, "id" | "name">[] | null) ?? [];
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));

  // Podepsané URL pro náhledy/přehrávání (krátká platnost).
  const paths = assets.map((a) => a.storage_path).filter((p): p is string => Boolean(p));
  const urlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage.from("media").createSignedUrls(paths, 60 * 60);
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
    }
  }

  const views: AssetView[] = assets.map((asset) => ({
    asset,
    url: asset.storage_path ? (urlByPath.get(asset.storage_path) ?? null) : null,
    projectName: projectName.get(asset.project_id) ?? "Projekt",
  }));

  return (
    <>
      <RealtimeRefresh tables={["media_assets"]} throttleMs={2000} />
      <PageHeader
        title="Knihovna"
        description="Hotové reely, obrázky a hudba ke stažení nebo publikaci. Vyber víc a stáhni ZIP."
      />
      <LibraryClient assets={views} projects={projects} />
    </>
  );
}
