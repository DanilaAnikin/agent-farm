import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { capsFromState, getFarmRunState } from "@/lib/server/farm-state";
import { effectiveUserCaps } from "@/lib/admin-guards";
import { formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ProfileForm } from "@/components/settings/ProfileForm";
import { ConnectionsForm } from "@/components/settings/ConnectionsForm";
import type { ConnectionRow, PreferenceProfile } from "@/lib/types";

export const metadata = { title: "Nastavení — Perennial" };

export default async function SettingsPage() {
  const user = await requireUser();
  const supabase = await createClient();

  const [connRes, stateRes] = await Promise.all([
    // JEN vlastní připojení: adminovi RLS vrátí i cizí řádky a „Připojeno" pak
    // svítilo podle tokenu jiného uživatele.
    supabase
      .from("connections")
      .select("kind, status, updated_at")
      .eq("user_id", user.id)
      .eq("kind", "github")
      .maybeSingle<Pick<ConnectionRow, "kind" | "status" | "updated_at">>(),
    getFarmRunState(),
  ]);
  const github = connRes.data ?? null;
  const tokenSaved = github?.status === "active";

  const profile: PreferenceProfile = user.profile?.preference_profile ?? {};
  const userCaps = effectiveUserCaps(user.profile ?? {});
  const farmCaps = capsFromState(stateRes.state);

  return (
    <>
      <PageHeader title="Nastavení" description="Globální profil a připojení služeb." />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Globální profil"
            description="Tón, styl a značka — čtou ho všechny tvé projekty pro jednotný výstup."
          />
          <CardBody>
            <ProfileForm displayName={user.profile?.display_name ?? null} profile={profile} />
          </CardBody>
        </Card>

        <div className="space-y-6">
          <ConnectionsForm
            tokenSaved={tokenSaved}
            updatedAt={github?.updated_at ?? null}
            githubStatus={stateRes.state.github_status}
          />

          <Card>
            <CardHeader
              title="Efektivní stropy"
              description="Co opravdu platí. Váže vždy nejnižší z nich; dny a měsíce se počítají v UTC."
            />
            <CardBody>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[1fr_auto]">
                <dt className="text-[--color-muted]">Měsíční strop farmy</dt>
                <dd className="tabular-nums">{formatUsd(farmCaps.monthlyUsd, "cap")}</dd>
                <dt className="text-[--color-muted]">Denní strop farmy (modely)</dt>
                <dd className="tabular-nums">{formatUsd(farmCaps.dailyUsd, "cap")}</dd>
                <dt className="text-[--color-muted]">Denní strop médií farmy</dt>
                <dd className="tabular-nums">{formatUsd(farmCaps.dailyMediaUsd, "cap")}</dd>
                <dt className="text-[--color-muted]">Tvůj denní strop (modely)</dt>
                <dd className="tabular-nums">{formatUsd(userCaps.dailyCapUsd, "cap")}</dd>
                <dt className="text-[--color-muted]">Tvůj denní strop (média)</dt>
                <dd className="tabular-nums">{formatUsd(userCaps.dailyMediaCapUsd, "cap")}</dd>
              </dl>
              <p className="t-meta mt-3">
                Tvoje stropy: {userCaps.sourceLabel}.
                {/* Záložní čtení tabulky vrací skutečné hodnoty; výchozí jen když se nepřečetlo nic. */}
                {stateRes.degraded
                  ? stateRes.state.updated_at === null
                    ? " Stropy farmy se nepodařilo načíst, jsou zobrazené výchozí hodnoty."
                    : " Stropy farmy jsou přečtené záložní cestou přímo z nastavení farmy."
                  : ""}{" "}
                <Link href="/costs" className="text-[--color-accent] hover:underline">
                  Čerpání a úpravy v Nákladech →
                </Link>
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
