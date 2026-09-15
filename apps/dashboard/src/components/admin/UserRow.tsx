"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateUserCaps } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { MoneyInput, Select } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { TD, TR } from "@/components/ui/Table";
import { parseDecimalInput } from "@/lib/admin-guards";
import { formatUsd } from "@/lib/format";

type Role = "admin" | "member";

function doPole(n: number | null): string {
  return n === null ? "" : n.toFixed(2).replace(".", ",");
}

/**
 * Řádek uživatele: role a ruční přepis denních stropů (`caps_override`).
 * Zobrazuje EFEKTIVNÍ strop, tedy ten, který orchestrátor opravdu vynucuje.
 */
export function UserRow({
  userId,
  displayName,
  email,
  role,
  isSelf,
  effectiveDailyCap,
  effectiveMediaCap,
  sourceLabel,
  overrideDaily,
  overrideMedia,
}: {
  userId: string;
  displayName: string | null;
  email: string;
  role: Role;
  isSelf: boolean;
  effectiveDailyCap: number;
  effectiveMediaCap: number;
  /** „plán Free + ruční přepis" */
  sourceLabel: string;
  overrideDaily: number | null;
  overrideMedia: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Prázdné pole = žádný ruční přepis. Předvyplníme efektivní hodnotu, aby
  // uložení beze změny nikdy nespadlo na (vyšší) strop plánu.
  const [llm, setLlm] = useState(doPole(overrideDaily ?? effectiveDailyCap));
  const [media, setMedia] = useState(doPole(overrideMedia ?? effectiveMediaCap));
  const [r, setR] = useState<Role>(role);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  function save() {
    setFeedback(null);
    const llmCislo = parseDecimalInput(llm);
    const mediaCislo = parseDecimalInput(media);
    // Dřív `Number("")` → NaN → JSON null → NOT NULL violation se syrovou chybou Postgresu.
    if (llmCislo === null || mediaCislo === null) {
      setFeedback({ tone: "error", text: "Vyplň oba stropy (0 = nesmí utrácet)." });
      return;
    }
    if (Number.isNaN(llmCislo) || Number.isNaN(mediaCislo)) {
      setFeedback({ tone: "error", text: "Strop musí být číslo, např. 0,60." });
      return;
    }
    // Změna role je citlivá oběma směry → potvrzení i při degradaci.
    if (r !== role) {
      const otazka =
        r === "admin"
          ? `Opravdu povýšit ${email} na administrátora? Získá plný přístup k celé farmě.`
          : `Opravdu odebrat ${email} administrátorská práva? Přijde o přístup do administrace.`;
      if (!window.confirm(otazka)) return;
    }
    startTransition(async () => {
      const res = await updateUserCaps({ userId, dailyCapUsd: llmCislo, dailyMediaCapUsd: mediaCislo, role: r });
      if (!res.ok) {
        setFeedback({ tone: "error", text: res.message ?? "Uložení se nepodařilo." });
        return;
      }
      setFeedback({ tone: "success", text: res.message ?? "Uloženo." });
      router.refresh();
    });
  }

  return (
    <TR>
      <TD>
        <div className="font-medium">{displayName ?? "—"}</div>
        <div className="text-xs text-(--color-muted)">{email}</div>
      </TD>
      <TD>
        <Select
          value={r}
          onChange={(e) => setR(e.target.value as Role)}
          className="max-w-36"
          aria-label="Role"
          disabled={isSelf}
          title={isSelf ? "Sám sobě roli měnit nemůžeš." : undefined}
        >
          <option value="member">Člen</option>
          <option value="admin">Administrátor</option>
        </Select>
      </TD>
      <TD>
        <MoneyInput
          value={llm}
          onChange={(e) => setLlm(e.target.value)}
          wrapperClassName="max-w-32"
          aria-label="Denní strop jazykových modelů"
        />
        <div className="mt-1 text-[11px] text-(--color-muted)">
          platí {formatUsd(effectiveDailyCap, "cap")}/den · {sourceLabel}
        </div>
      </TD>
      <TD>
        <MoneyInput
          value={media}
          onChange={(e) => setMedia(e.target.value)}
          wrapperClassName="max-w-32"
          aria-label="Denní strop médií"
        />
        <div className="mt-1 text-[11px] text-(--color-muted)">
          platí {formatUsd(effectiveMediaCap, "cap")}/den · {sourceLabel}
        </div>
      </TD>
      <TD className="text-right">
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" variant="secondary" loading={pending} onClick={save}>
            Uložit
          </Button>
          {feedback ? <FormMessage tone={feedback.tone}>{feedback.text}</FormMessage> : null}
        </div>
      </TD>
    </TR>
  );
}
