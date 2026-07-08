"use client";

import { useState, useTransition } from "react";
import { updateProfile } from "@/app/actions/settings";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import type { PreferenceProfile } from "@/lib/types";

// Globální preferenční profil — čtou ho VŠECHNY projekty uživatele.
export function ProfileForm({
  displayName,
  profile,
}: {
  displayName: string | null;
  profile: PreferenceProfile;
}) {
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(formData: FormData) {
    setSaved(false);
    startTransition(async () => {
      const res = await updateProfile(formData);
      if (res.ok) setSaved(true);
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <Field label="Zobrazované jméno" htmlFor="display_name">
        <Input id="display_name" name="display_name" defaultValue={displayName ?? ""} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Tón" htmlFor="tone">
          <Input id="tone" name="tone" defaultValue={profile.tone ?? ""} placeholder="přátelský, sebevědomý" />
        </Field>
        <Field label="Styl" htmlFor="style">
          <Input id="style" name="style" defaultValue={profile.style ?? ""} placeholder="minimalistický, moderní" />
        </Field>
      </div>

      <Field label="Jazyk obsahu" htmlFor="language">
        <Input id="language" name="language" defaultValue={profile.language ?? ""} placeholder="čeština" className="max-w-48" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Brand barvy" htmlFor="brand_colors" hint="každá na řádek">
          <Textarea
            id="brand_colors"
            name="brand_colors"
            defaultValue={(profile.brand?.colors ?? []).join("\n")}
            placeholder="#0a0c10&#10;#4f8cff"
            className="min-h-20"
          />
        </Field>
        <Field label="Brand fonty" htmlFor="brand_fonts" hint="každý na řádek">
          <Textarea
            id="brand_fonts"
            name="brand_fonts"
            defaultValue={(profile.brand?.fonts ?? []).join("\n")}
            placeholder="Inter&#10;JetBrains Mono"
            className="min-h-20"
          />
        </Field>
      </div>

      <Field label="Logo URL" htmlFor="brand_logo">
        <Input id="brand_logo" name="brand_logo" defaultValue={profile.brand?.logoUrl ?? ""} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Do (dělej)" htmlFor="dos" hint="každé na řádek">
          <Textarea id="dos" name="dos" defaultValue={(profile.dos ?? []).join("\n")} className="min-h-24" />
        </Field>
        <Field label="Don't (nedělej)" htmlFor="donts" hint="každé na řádek">
          <Textarea id="donts" name="donts" defaultValue={(profile.donts ?? []).join("\n")} className="min-h-24" />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending}>
          Uložit profil
        </Button>
        {saved ? <span className="text-xs text-[--color-ok]">Uloženo.</span> : null}
      </div>
    </form>
  );
}
