"use client";

import { useEffect, useState, useTransition } from "react";
import { updateProfile } from "@/app/actions/settings";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import type { PreferenceProfile } from "@/lib/types";

// Jak dlouho zůstane viditelné „Uloženo." (chyba zůstává, dokud se pole nezmění).
const USPECH_ZOBRAZIT_MS = 4000;

// Globální preferenční profil — čtou ho VŠECHNY projekty uživatele.
export function ProfileForm({
  displayName,
  profile,
}: {
  displayName: string | null;
  profile: PreferenceProfile;
}) {
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (msg?.tone !== "success") return;
    const t = setTimeout(() => setMsg(null), USPECH_ZOBRAZIT_MS);
    return () => clearTimeout(t);
  }, [msg]);

  function onSubmit(formData: FormData) {
    setMsg(null);
    startTransition(async () => {
      const res = await updateProfile(formData);
      // Dřív se chyba tiše spolkla a formulář se tvářil, že se nic nestalo.
      setMsg(
        res.ok
          ? { tone: "success", text: "Uloženo." }
          : { tone: "error", text: res.message ?? "Profil se nepodařilo uložit." },
      );
    });
  }

  return (
    <form action={onSubmit} onChange={() => setMsg(null)} className="space-y-4">
      <Field label="Zobrazované jméno" htmlFor="display_name">
        <Input id="display_name" name="display_name" maxLength={80} defaultValue={displayName ?? ""} />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Tón" htmlFor="tone">
          <Input id="tone" name="tone" maxLength={2000} defaultValue={profile.tone ?? ""} placeholder="přátelský, sebevědomý" />
        </Field>
        <Field label="Styl" htmlFor="style">
          <Input id="style" name="style" maxLength={2000} defaultValue={profile.style ?? ""} placeholder="minimalistický, moderní" />
        </Field>
      </div>

      <Field label="Jazyk obsahu" htmlFor="language">
        <Input id="language" name="language" maxLength={2000} defaultValue={profile.language ?? ""} placeholder="čeština" className="max-w-48" />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Barvy značky" htmlFor="brand_colors" hint="každá na řádek">
          <Textarea
            id="brand_colors"
            name="brand_colors"
            maxLength={2000}
            defaultValue={(profile.brand?.colors ?? []).join("\n")}
            placeholder={"#0a0c10\n#4f8cff"}
            className="min-h-20"
          />
        </Field>
        <Field label="Písma značky" htmlFor="brand_fonts" hint="každé na řádek">
          <Textarea
            id="brand_fonts"
            name="brand_fonts"
            maxLength={2000}
            defaultValue={(profile.brand?.fonts ?? []).join("\n")}
            placeholder={"Inter\nJetBrains Mono"}
            className="min-h-20"
          />
        </Field>
      </div>

      <Field label="Odkaz na logo" htmlFor="brand_logo" hint="http:// nebo https://">
        <Input
          id="brand_logo"
          name="brand_logo"
          type="url"
          maxLength={2000}
          defaultValue={profile.brand?.logoUrl ?? ""}
          placeholder="https://…"
        />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Dělej" htmlFor="dos" hint="každé na řádek">
          <Textarea id="dos" name="dos" maxLength={2000} defaultValue={(profile.dos ?? []).join("\n")} className="min-h-24" />
        </Field>
        <Field label="Nedělej" htmlFor="donts" hint="každé na řádek">
          <Textarea id="donts" name="donts" maxLength={2000} defaultValue={(profile.donts ?? []).join("\n")} className="min-h-24" />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending}>
          Uložit profil
        </Button>
        {msg ? <FormMessage tone={msg.tone}>{msg.text}</FormMessage> : null}
      </div>
    </form>
  );
}
