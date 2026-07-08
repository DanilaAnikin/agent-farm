import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { supabaseServiceRoleKey, supabaseUrl } from "@/lib/env";
import { setGlobalPause } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { KillSwitch } from "@/components/ui/KillSwitch";
import { InviteForm } from "@/components/admin/InviteForm";
import { UserRow } from "@/components/admin/UserRow";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { AGENT_STATUS_META } from "@/lib/constants";
import { formatDate, formatRelative } from "@/lib/format";
import type { AgentRow, InviteRow, ProfileRow } from "@/lib/types";

// Mrtvý heartbeat = starší než 3 min (viz reconciliation v OVERVIEW §5.2).
const STALE_HEARTBEAT_MS = 3 * 60 * 1000;

export const metadata = { title: "Administrace — Perennial" };

export default async function AdminPage() {
  await requireAdmin();
  const supabase = await createClient();

  const [{ data: profilesData }, { data: invitesData }, { data: agentsData }, { data: settingsData }] =
    await Promise.all([
      supabase.from("profiles").select("*").order("created_at", { ascending: true }),
      supabase.from("invites").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("agents").select("*").order("last_heartbeat", { ascending: false }).limit(100),
      supabase.from("farm_settings").select("key, value"),
    ]);

  const profiles = (profilesData as ProfileRow[] | null) ?? [];
  const invites = (invitesData as InviteRow[] | null) ?? [];

  // Skutečné e-maily uživatelů (profiles je nemají) přes admin API — jen pro admina.
  // Bez service-role klíče spadneme na zkrácené user_id (žádný pád stránky).
  const emailById = new Map<string, string>();
  try {
    const adminClient = createSupabaseAdmin(supabaseUrl(), supabaseServiceRoleKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userList } = await adminClient.auth.admin.listUsers({ perPage: 200 });
    for (const u of userList?.users ?? []) if (u.email) emailById.set(u.id, u.email);
  } catch {
    // service-role key chybí → fallback níže
  }
  const agents = (agentsData as AgentRow[] | null) ?? [];
  const settings = new Map((settingsData as { key: string; value: unknown }[] | null)?.map((s) => [s.key, s.value]) ?? []);
  const globalPause = Boolean(settings.get("global_pause"));

  const now = Date.now();
  const liveAgents = agents.filter((a) => a.status === "busy").length;
  const staleAgents = agents.filter(
    (a) => now - new Date(a.last_heartbeat).getTime() > STALE_HEARTBEAT_MS,
  ).length;

  return (
    <>
      <RealtimeRefresh tables={["agents", "farm_settings", "profiles", "invites"]} throttleMs={2000} />
      <PageHeader title="Administrace" description="Uživatelé, stropy, agenti a globální kill switch." />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Kill switch */}
        <Card className="lg:col-span-1">
          <CardHeader title="Globální kill switch" description="Pozastaví celou farmu (čte orchestrátor před každým dispatch)." />
          <CardBody className="flex justify-center py-6">
            <KillSwitch initialPaused={globalPause} onToggle={setGlobalPause} />
          </CardBody>
        </Card>

        {/* Zdraví */}
        <Card className="lg:col-span-2">
          <CardHeader title="Zdraví služeb" description="Rychlý přehled běhu farmy." />
          <CardBody>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Uživatelé" value={profiles.length} />
              <Stat label="Aktivní agenti" value={liveAgents} tone={liveAgents > 0 ? "ok" : "default"} />
              <Stat label="Mrtvé heartbeaty" value={staleAgents} tone={staleAgents > 0 ? "warn" : "default"} />
              <Stat label="Stav farmy" value={globalPause ? "Pauza" : "Běží"} tone={globalPause ? "warn" : "ok"} />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Uživatelé + stropy */}
      <Card className="mt-6">
        <CardHeader title="Uživatelé a stropy" description="Per-user denní stropy (LLM + média) a role." action={<InviteForm />} />
        <CardBody className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Uživatel</TH>
                <TH>Role</TH>
                <TH>LLM strop/den</TH>
                <TH>Media strop/den</TH>
                <TH className="text-right">Akce</TH>
              </TR>
            </THead>
            <TBody>
              {profiles.map((p) => (
                <UserRow
                  key={p.user_id}
                  userId={p.user_id}
                  displayName={p.display_name}
                  email={emailById.get(p.user_id) ?? p.user_id.slice(0, 8) + "…"}
                  role={p.role}
                  dailyCap={p.daily_cap_usd}
                  mediaCap={p.daily_media_cap_usd}
                />
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      {/* Pozvánky */}
      <Card className="mt-6">
        <CardHeader title="Pozvánky" description="Registrace je jen na pozvánku." />
        <CardBody className="p-0">
          {invites.length === 0 ? (
            <p className="px-5 py-4 text-sm text-[--color-muted]">Zatím žádné pozvánky.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>E-mail</TH>
                  <TH>Stav</TH>
                  <TH>Vytvořeno</TH>
                </TR>
              </THead>
              <TBody>
                {invites.map((i) => (
                  <TR key={i.id}>
                    <TD>{i.email}</TD>
                    <TD>
                      {i.used_at ? <Badge tone="neutral">Použito</Badge> : <Badge tone="ok" dot>Aktivní</Badge>}
                    </TD>
                    <TD className="text-xs text-[--color-muted]">{formatDate(i.created_at)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* Agenti */}
      <Card className="mt-6">
        <CardHeader title="Registr agentů" description="Napříč všemi uživateli a projekty." />
        <CardBody className="p-0">
          {agents.length === 0 ? (
            <p className="px-5 py-4 text-sm text-[--color-muted]">Žádní registrovaní agenti.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Role</TH>
                  <TH>Model</TH>
                  <TH>Stav</TH>
                  <TH>Poslední heartbeat</TH>
                </TR>
              </THead>
              <TBody>
                {agents.map((a) => (
                  <TR key={a.id}>
                    <TD>{a.role}</TD>
                    <TD className="text-xs">{a.model ?? "—"}</TD>
                    <TD>
                      <StatusBadge meta={AGENT_STATUS_META[a.status]} dot />
                    </TD>
                    <TD className="text-xs text-[--color-muted]">{formatRelative(a.last_heartbeat)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  );
}
