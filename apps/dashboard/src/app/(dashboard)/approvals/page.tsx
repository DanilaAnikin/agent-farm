import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { ApprovalActions } from "@/components/approvals/ApprovalActions";
import { APPROVAL_TYPE_META } from "@/lib/constants";
import { formatRelative } from "@/lib/format";
import type { ApprovalRow, ProjectRow } from "@/lib/types";

export const metadata = { title: "Schvalování — Perennial" };

function ApprovalPreview({ approval }: { approval: ApprovalRow }) {
  const p = approval.payload ?? {};
  if (approval.type === "spec") {
    const text = typeof p["spec_content"] === "string" ? (p["spec_content"] as string) : null;
    return text ? (
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[--color-surface-2] p-3 text-xs">
        {text}
      </pre>
    ) : (
      <p className="mt-2 text-xs text-[--color-muted]">Náhled specifikace k dispozici v detailu přání.</p>
    );
  }
  if (approval.type === "publish") {
    const caption = typeof p["caption"] === "string" ? (p["caption"] as string) : "";
    return (
      <div className="mt-2 rounded-md bg-[--color-surface-2] p-3 text-xs">
        <div className="text-[--color-faint]">Popisek k publikaci:</div>
        <p className="mt-1 whitespace-pre-wrap">{caption || "—"}</p>
      </div>
    );
  }
  if (approval.type === "deploy_prod") {
    const diff = typeof p["diff"] === "string" ? (p["diff"] as string) : null;
    return diff ? (
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[--color-surface-2] p-3 font-mono text-xs">
        {diff}
      </pre>
    ) : (
      <p className="mt-2 text-xs text-[--color-muted]">Produkční deploy — zkontroluj cíl a health check.</p>
    );
  }
  if (approval.type === "config_change") {
    return (
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[--color-surface-2] p-3 font-mono text-xs">
        {JSON.stringify(p, null, 2)}
      </pre>
    );
  }
  return null;
}

export default async function ApprovalsPage() {
  const supabase = await createClient();

  const [{ data: approvalsData }, { data: projectsData }] = await Promise.all([
    supabase
      .from("approvals")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    supabase.from("projects").select("id, name"),
  ]);

  const approvals = (approvalsData as ApprovalRow[] | null) ?? [];
  const projects = (projectsData as Pick<ProjectRow, "id" | "name">[] | null) ?? [];
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));

  return (
    <>
      <RealtimeRefresh tables={["approvals"]} throttleMs={1500} />
      <PageHeader
        title="Schvalování"
        description="Nevratné akce čekají na tvé jedno ťuknutí — spec, publikace, produkční deploy."
      />

      {approvals.length === 0 ? (
        <EmptyState icon="✓" title="Nic nečeká" description="Žádná schválení k rozhodnutí. Farma běží dál." />
      ) : (
        <div className="space-y-4">
          {approvals.map((a) => (
            <Card key={a.id}>
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge meta={APPROVAL_TYPE_META[a.type]} />
                      {a.project_id ? (
                        <span className="text-sm text-[--color-muted]">
                          {projectName.get(a.project_id) ?? "Projekt"}
                        </span>
                      ) : null}
                      <span className="text-xs text-[--color-faint]">{formatRelative(a.created_at)}</span>
                    </div>
                    <ApprovalPreview approval={a} />
                    {a.expires_at ? (
                      <p className="mt-2 text-xs text-[--color-faint]">Vyprší {formatRelative(a.expires_at)}</p>
                    ) : null}
                  </div>
                  <ApprovalActions approvalId={a.id} />
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
