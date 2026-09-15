import { AlertTriangle, Bot, Mail } from "lucide-react";
import { createClient as createSupabaseAdmin, type SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { supabaseServiceRoleKey, supabaseUrl } from "@/lib/env";
import { setGlobalPause } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardFooter, CardHeader, Stat } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { KillSwitch } from "@/components/ui/KillSwitch";
import { InviteForm, InviteRowActions } from "@/components/admin/InviteForm";
import { UserRow } from "@/components/admin/UserRow";
import { RealtimeRefresh } from "@/components/RealtimeRefresh";
import { AGENT_ROLE_META, AGENT_STATUS_META } from "@/lib/constants";
import { capFromSetting, farmState, isFarmPaused, pauseLabel } from "@/lib/farm-state";
import { getBudgetSnapshot } from "@/lib/server/farm-state";
import {
  AGENT_HIDE_AFTER_MS,
  agentHealthSummary,
  effectiveUserCaps,
  inviteState,
  isAgentListed,
  modelLabel,
  type InviteState,
} from "@/lib/admin-guards";
import { formatDate, formatNumber, formatRelative, formatUsd } from "@/lib/format";
import type { Tone } from "@/lib/constants";
import type { AgentRow, InviteRow, ProfileRow } from "@/lib/types";

export const metadata = { title: "Administrace — Perennial" };

const AGENT_LIMIT = 100;

const INVITE_META: Record<InviteState, { label: string; tone: Tone }> = {
  active: { label: "Aktivní", tone: "ok" },
  used: { label: "Použito", tone: "neutral" },
  revoked: { label: "Zrušeno", tone: "neutral" },
  expired: { label: "Vypršela", tone: "warn" },
};

// Servisní klient se vytváří JEDNOU za život procesu, ne při každém renderu.
let adminClient: SupabaseClient | null = null;
function servisniKlient(): SupabaseClient {
  if (!adminClient) {
    adminClient = createSupabaseAdmin(supabaseUrl(), supabaseServiceRoleKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return adminClient;
}

/**
 * Skutečné e-maily uživatelů (profiles je nemají) přes admin API. Stránkuje, dokud
 * nenajde všechny profily. Selhání se NESPOLKNE: zaloguje se a karta ukáže varování.
 */
async function nactiEmaily(pocetProfilu: number): Promise<{ emails: Map<string, string>; chyba: string | null }> {
  const emails = new Map<string, string>();
  const perPage = 200;
  try {
    const klient = servisniKlient();
    for (let page = 1; page <= 50; page++) {
      const { data, error } = await klient.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const users = data?.users ?? [];
      for (const u of users) if (u.email) emails.set(u.id, u.email);
      if (users.length < perPage || emails.size >= pocetProfilu) break;
    }
    return { emails, chyba: null };
  } catch (err) {
    console.error("[admin] e-maily uživatelů se nepodařilo načíst:", err instanceof Error ? err.message : err);
    const chybiKlic = !process.env.SUPABASE_SERVICE_ROLE_KEY;
    return {
      emails,
      chyba: chybiKlic
        ? "E-maily se nepodařilo načíst — chybí servisní klíč."
        : "E-maily se nepodařilo načíst — admin API Supabase neodpovědělo.",
    };
  }
}

export default async function AdminPage() {
  const me = await requireAdmin();
  const supabase = await createClient();
  const now = new Date();
  const skrytPred = new Date(now.getTime() - AGENT_HIDE_AFTER_MS).toISOString();

  const [profilesRes, invitesRes, agentsRes, agentsTotalRes, settingsRes, budgetRes] = await Promise.all([
    supabase.from("profiles").select("*").order("created_at", { ascending: true }),
    supabase.from("invites").select("*").order("created_at", { ascending: false }).limit(50),
    // Jen neukončení agenti (nebo ukončení za posledních 24 h) — dřív tu byla stovka mrtvých řádků.
    supabase
      .from("agents")
      .select("*", { count: "exact" })
      .or(`status.neq.dead,last_heartbeat.gte."${skrytPred}"`)
      .order("last_heartbeat", { ascending: false })
      .limit(AGENT_LIMIT),
    supabase.from("agents").select("id", { count: "exact", head: true }),
    // Vypínač zapisuje `owner_pause`, hlídače `global_pause` — číst se musí oba,
    // jinak pilulka po kliknutí na „Zastavit vše" ukazovala „Běží".
    supabase
      .from("farm_settings")
      .select("key, value")
      .in("key", [
        "global_pause",
        "owner_pause",
        "pause_source",
        "budget_block",
        "farm_daily_cap_usd",
      ]),
    getBudgetSnapshot(),
  ]);

  const profiles = (profilesRes.data as ProfileRow[] | null) ?? [];
  const invites = (invitesRes.data as InviteRow[] | null) ?? [];
  const agents = ((agentsRes.data as AgentRow[] | null) ?? []).filter((a) => isAgentListed(a, now));
  const agentsNeukoncenych = agentsRes.count ?? agents.length;
  const agentsCelkem = agentsTotalRes.count ?? agentsNeukoncenych;
  const skryto = Math.max(0, agentsCelkem - agentsNeukoncenych);

  const { emails, chyba: emailChyba } = await nactiEmaily(profiles.length);

  const settings = new Map(
    ((settingsRes.data as { key: string; value: unknown }[] | null) ?? []).map((s) => [s.key, s.value]),
  );
  const pauseInput = {
    owner_pause: settings.get("owner_pause"),
    global_pause: settings.get("global_pause"),
    pause_source: settings.get("pause_source"),
    budget_block: settings.get("budget_block"),
    guard_ready: budgetRes.snapshot.ready,
  };
  const stav = farmState(pauseInput, now);
  const ownerPaused = Boolean(pauseInput.owner_pause);
  const farmaStoji = isFarmPaused(pauseInput) || stav.paused;
  const zdrojPauzy = ownerPaused
    ? "vypínač majitele"
    : Boolean(pauseInput.global_pause)
      ? pauseLabel(pauseInput.pause_source)
      : stav.code === "budget"
        ? "rozpočet"
        : "—";
  const farmDailyCap = capFromSetting(settings.get("farm_daily_cap_usd"), 0.6);
  const dnesFarma = budgetRes.snapshot.day_counted ?? budgetRes.snapshot.day_settled;

  const zdravi = agentHealthSummary(agents, now);

  return (
    <>
      {/* Realtime může mlčet (publikace, síť) — stránka se na něj nespoléhá, čísla jsou ze serveru. */}
      <RealtimeRefresh tables={["agents", "farm_settings", "profiles", "invites"]} throttleMs={2000} />
      <PageHeader title="Administrace" description="Uživatelé, stropy, agenti a nouzové zastavení farmy." />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader
            title="Nouzové zastavení farmy"
            description="Vypínač majitele. Orchestrátor ho čte před každým přidělením úkolu a žádný hlídač ho sám nezruší."
          />
          <CardBody className="flex justify-center py-6">
            <KillSwitch
              initialPaused={ownerPaused}
              onToggle={setGlobalPause}
              mode={ownerPaused ? "owner" : farmaStoji ? "auto" : "running"}
              labelPaused="Farmu drží vypínač majitele"
              labelActive={farmaStoji ? stav.title : "Farma běží"}
              detail={farmaStoji ? stav.detail : undefined}
            />
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Zdraví služeb" description="Rychlý přehled běhu farmy." />
          <CardBody>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Stav farmy" value={farmaStoji ? "Stojí" : "Běží"} hint={stav.title} tone={farmaStoji ? "warn" : "ok"} />
              <Stat label="Zdroj pauzy" value={<span className="text-base">{zdrojPauzy}</span>} />
              <Stat
                label="Dnešní útrata farmy"
                value={dnesFarma === null ? "—" : formatUsd(dnesFarma)}
                hint={`z ${formatUsd(farmDailyCap, "cap")}/den (UTC)`}
              />
              <Stat label="Živí agenti" value={zdravi.live} hint="tepou do 3 min" tone={zdravi.live > 0 ? "ok" : "default"} />
              <Stat label="Právě pracují" value={zdravi.working} />
              <Stat
                label="Agenti bez tepu"
                value={zdravi.silent}
                hint="tváří se živě, ale netepou"
                tone={zdravi.silent > 0 ? "warn" : "default"}
              />
            </div>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Uživatelé a stropy"
          description="Denní stropy uživatelů (jazykové modely + média) a role. Stropy uživatele platí vedle stropů farmy; váže nižší."
        />
        {emailChyba ? (
          <div role="alert" className="flex items-center gap-2 border-b border-[--color-border-subtle] bg-[--color-warn-bg] px-5 py-2.5 text-sm text-[--color-warn]">
            <AlertTriangle className="size-4 shrink-0" />
            {emailChyba}
          </div>
        ) : null}
        <CardBody className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Uživatel</TH>
                <TH>Role</TH>
                <TH>Jazykové modely (US$/den)</TH>
                <TH>Média (US$/den)</TH>
                <TH className="text-right">Akce</TH>
              </TR>
            </THead>
            <TBody>
              {profiles.map((p) => {
                const caps = effectiveUserCaps(p);
                return (
                  <UserRow
                    key={p.user_id}
                    userId={p.user_id}
                    displayName={p.display_name}
                    email={emails.get(p.user_id) ?? `${p.user_id.slice(0, 8)}…`}
                    role={p.role}
                    isSelf={p.user_id === me.id}
                    effectiveDailyCap={caps.dailyCapUsd}
                    effectiveMediaCap={caps.dailyMediaCapUsd}
                    sourceLabel={caps.sourceLabel}
                    overrideDaily={typeof p.caps_override?.dailyCapUsd === "number" ? p.caps_override.dailyCapUsd : null}
                    overrideMedia={
                      typeof p.caps_override?.dailyMediaCapUsd === "number" ? p.caps_override.dailyMediaCapUsd : null
                    }
                  />
                );
              })}
            </TBody>
          </Table>
        </CardBody>
        <CardFooter className="t-meta">
          Uložený strop je ruční přepis plánu a nikdy nepřekročí strop farmy. Druhou pojistkou je LiteLLM max_budget
          (druhá pojistka, platí nižší z obou).
        </CardFooter>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Pozvánky" description="Registrace je jen na pozvánku. Pozvánka platí 7 dní; časy v Europe/Prague." />
        <CardBody className="border-b border-[--color-border-subtle]">
          <InviteForm />
        </CardBody>
        <CardBody className={invites.length === 0 ? undefined : "p-0"}>
          {invites.length === 0 ? (
            <EmptyState
              icon={<Mail className="size-5" />}
              title="Zatím žádné pozvánky."
              description="Zadej e-mail výš a pošli pozvanému vygenerovaný odkaz."
              className="py-8"
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>E-mail</TH>
                  <TH>Stav</TH>
                  <TH>Vytvořeno</TH>
                  <TH>Platí do</TH>
                  <TH className="text-right">Akce</TH>
                </TR>
              </THead>
              <TBody>
                {invites.map((i) => {
                  const s = inviteState(i, now);
                  return (
                    <TR key={i.id}>
                      <TD>{i.email}</TD>
                      <TD>
                        <StatusBadge meta={INVITE_META[s]} dot={s === "active"} />
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-[--color-muted]">{formatDate(i.created_at)}</TD>
                      <TD className="whitespace-nowrap text-xs text-[--color-muted]">
                        {i.expires_at ? formatDate(i.expires_at) : "bez omezení"}
                      </TD>
                      <TD className="text-right">
                        {s === "active" ? <InviteRowActions inviteId={i.id} token={i.token} email={i.email} /> : "—"}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Registr agentů" description="Neukončení agenti napříč projekty. Časy v Europe/Prague." />
        <CardBody className={agents.length === 0 ? undefined : "p-0"}>
          {agents.length === 0 ? (
            <EmptyState
              icon={<Bot className="size-5" />}
              title="Žádní registrovaní agenti."
              description="Agenti se zaregistrují sami, jakmile orchestrátor naběhne a farma nestojí."
              className="py-8"
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Role</TH>
                  <TH>Okruh (alias)</TH>
                  <TH>Model</TH>
                  <TH>Stav</TH>
                  <TH>Poslední signál</TH>
                </TR>
              </THead>
              <TBody>
                {agents.map((a) => (
                  <TR key={a.id}>
                    <TD>{AGENT_ROLE_META[a.role]?.label ?? a.role}</TD>
                    <TD className="font-mono text-xs text-[--color-muted]">{a.model ?? "—"}</TD>
                    <TD className="text-xs">{modelLabel(a.model)}</TD>
                    <TD>
                      <StatusBadge meta={AGENT_STATUS_META[a.status]} dot />
                    </TD>
                    <TD className="text-xs text-[--color-muted]" title={formatDate(a.last_heartbeat)}>
                      {formatRelative(a.last_heartbeat, now)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
        {agentsCelkem > 0 ? (
          <CardFooter className="t-meta">
            Zobrazeno {formatNumber(agents.length)} z {formatNumber(agentsNeukoncenych)} neukončených
            {skryto > 0 ? ` · skryto ${formatNumber(skryto)} ukončených starších než 24 h` : ""}.
          </CardFooter>
        ) : null}
      </Card>

      {farmaStoji && !ownerPaused ? (
        <p className="t-meta mt-4">
          <Badge tone="info">Pozn.</Badge> Automatickou pauzu (levné hodiny, kredit, měsíční strop) tlačítko „Spustit“
          nepřebije — farma se rozjede sama.
        </p>
      ) : null}
    </>
  );
}
