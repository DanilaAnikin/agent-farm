import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import { NewWishForm } from "@/components/wishes/NewWishForm";
import { capsFromState, getFarmRunState } from "@/lib/server/farm-state";
import type { ProjectRow } from "@/lib/types";

export const metadata = { title: "Nové přání" };

export default async function NewWishPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, kind")
    .eq("id", id)
    .maybeSingle<Pick<ProjectRow, "id" | "name" | "kind">>();
  if (!project) notFound();
  const caps = capsFromState((await getFarmRunState()).state);

  return (
    <>
      <PageHeader
        title="Nové přání"
        description={
          <Link href={`/projects/${id}`} className="hover:text-(--color-fg)">
            ← {project.name}
          </Link>
        }
      />
      <NewWishForm
        projectId={id}
        projectKind={project.kind}
        userId={user.id}
        farmCaps={{ dailyUsd: caps.dailyUsd, monthlyUsd: caps.monthlyUsd }}
      />
    </>
  );
}
