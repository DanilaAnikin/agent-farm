import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ProfileForm } from "@/components/settings/ProfileForm";
import { ConnectionsForm } from "@/components/settings/ConnectionsForm";
import type { ConnectionKind, ConnectionRow, PreferenceProfile } from "@/lib/types";

export const metadata = { title: "Nastavení — Perennial" };

export default async function SettingsPage() {
  const user = await requireUser();
  const supabase = await createClient();

  const { data: connData } = await supabase.from("connections").select("kind, status");
  const conns = (connData as Pick<ConnectionRow, "kind" | "status">[] | null) ?? [];
  const connectedKinds = conns.filter((c) => c.status === "active").map((c) => c.kind as ConnectionKind);

  const profile: PreferenceProfile = user.profile?.preference_profile ?? {};

  return (
    <>
      <PageHeader title="Nastavení" description="Globální profil, připojení služeb a notifikace." />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Globální profil"
            description="Tón, styl a brand — čtou ho všechny tvé projekty pro jednotný výstup."
          />
          <CardBody>
            <ProfileForm displayName={user.profile?.display_name ?? null} profile={profile} />
          </CardBody>
        </Card>

        <div className="space-y-6">
          <ConnectionsForm connectedKinds={connectedKinds} />
        </div>
      </div>
    </>
  );
}
