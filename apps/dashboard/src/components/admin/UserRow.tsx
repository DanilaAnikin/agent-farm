"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateUserCaps } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { TD, TR } from "@/components/ui/Table";

export function UserRow({
  userId,
  displayName,
  email,
  role,
  dailyCap,
  mediaCap,
}: {
  userId: string;
  displayName: string | null;
  email: string;
  role: "admin" | "member";
  dailyCap: number;
  mediaCap: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [llm, setLlm] = useState(dailyCap);
  const [media, setMedia] = useState(mediaCap);
  const [r, setR] = useState<"admin" | "member">(role);

  return (
    <TR>
      <TD>
        <div className="font-medium">{displayName ?? "—"}</div>
        <div className="text-xs text-[--color-muted]">{email}</div>
      </TD>
      <TD>
        <Select value={r} onChange={(e) => setR(e.target.value as "admin" | "member")} className="max-w-32">
          <option value="member">člen</option>
          <option value="admin">admin</option>
        </Select>
      </TD>
      <TD>
        <Input type="number" step="0.5" value={llm} onChange={(e) => setLlm(Number(e.target.value))} className="max-w-24" />
      </TD>
      <TD>
        <Input type="number" step="0.5" value={media} onChange={(e) => setMedia(Number(e.target.value))} className="max-w-24" />
      </TD>
      <TD className="text-right">
        <Button
          size="sm"
          variant="secondary"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              await updateUserCaps({ userId, dailyCapUsd: llm, dailyMediaCapUsd: media, role: r });
              router.refresh();
            })
          }
        >
          Uložit
        </Button>
      </TD>
    </TR>
  );
}
