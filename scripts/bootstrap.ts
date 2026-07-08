/**
 * Bootstrap: připraví farmu po migracích.
 *  - zajistí Storage bucket `media`
 *  - zajistí pgmq fronty
 *  - založí (nebo pozve) prvního uživatele a nastaví mu profil (volitelně admin)
 *
 *   pnpm tsx scripts/bootstrap.ts --email tvuj@email.cz --admin
 */
import { createClient } from "@supabase/supabase-js";
import { getDb, profiles, ensureQueues } from "@farm/db";
import { SupabaseStorageAdapter } from "@farm/storage";
import { loadDotenv } from "./_env.js";

loadDotenv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const email = arg("email");
  const isAdmin = hasFlag("admin");

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nejsou nastavené.");

  // 1) Storage bucket
  const storage = new SupabaseStorageAdapter();
  await storage.ensureBucket();
  console.log("→ storage bucket `media` ok");

  // 2) pgmq fronty (idempotentní)
  await ensureQueues();
  console.log("→ pgmq fronty ok");

  // 3) uživatel + profil
  if (email) {
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // existuje už uživatel s tímto e-mailem?
    const { data: list } = await admin.auth.admin.listUsers();
    let user = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

    if (!user) {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email);
      if (error) throw error;
      user = data.user;
      console.log(`→ pozvánka odeslána na ${email}`);
    } else {
      console.log(`→ uživatel ${email} už existuje`);
    }

    if (user) {
      await getDb()
        .insert(profiles)
        .values({
          userId: user.id,
          role: isAdmin ? "admin" : "member",
          displayName: email.split("@")[0] ?? email,
        })
        .onConflictDoUpdate({
          target: profiles.userId,
          set: { role: isAdmin ? "admin" : "member" },
        });
      console.log(`→ profil nastaven (role=${isAdmin ? "admin" : "member"})`);
    }
  } else {
    console.log("→ (přeskočeno vytvoření uživatele; použij --email tvuj@email.cz [--admin])");
  }

  console.log("\n✅ Bootstrap hotový.");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Bootstrap selhal:", err);
  process.exit(1);
});
