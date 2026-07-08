"use client";

import { useCallback, useEffect, useState } from "react";
import { useSupabase } from "@/lib/supabase/provider";
import { formatUsd, spendRatio } from "@/lib/format";
import { startOfUtcDayIso } from "@/lib/time";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Badge } from "@/components/ui/Badge";

export function StatusBar({
  userId,
  initialSpend,
  userCap,
  farmCap,
  initialGlobalPause,
}: {
  userId: string;
  initialSpend: number;
  userCap: number;
  farmCap: number;
  initialGlobalPause: boolean;
}) {
  const supabase = useSupabase();
  const [spend, setSpend] = useState(initialSpend);
  const [globalPause, setGlobalPause] = useState(initialGlobalPause);

  const refresh = useCallback(async () => {
    const since = startOfUtcDayIso();
    const { data } = await supabase
      .from("cost_ledger")
      .select("cost_usd")
      .eq("user_id", userId)
      .gte("ts", since);
    if (data) {
      const total = (data as { cost_usd: number }[]).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
      setSpend(total);
    }
    const { data: pauseRow } = await supabase
      .from("farm_settings")
      .select("value")
      .eq("key", "global_pause")
      .maybeSingle();
    if (pauseRow) setGlobalPause(Boolean((pauseRow as { value: unknown }).value));
  }, [supabase, userId]);

  useEffect(() => {
    const channel = supabase
      .channel("statusbar")
      .on("postgres_changes", { event: "*", schema: "public", table: "cost_ledger" }, () => {
        void refresh();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "farm_settings" }, () => {
        void refresh();
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, refresh]);

  const ratio = spendRatio(spend, userCap);

  return (
    <div className="flex items-center gap-4">
      {globalPause ? (
        <Badge tone="danger" dot>
          Farma pozastavena
        </Badge>
      ) : (
        <Badge tone="ok" dot>
          Farma běží
        </Badge>
      )}

      <div className="hidden min-w-[12rem] flex-col gap-1 sm:flex">
        <div className="flex items-center justify-between text-xs">
          <span className="text-[--color-muted]">Dnešní útrata</span>
          <span className="tabular-nums">
            {formatUsd(spend)} <span className="text-[--color-faint]">/ {formatUsd(userCap)}</span>
          </span>
        </div>
        <ProgressBar ratio={ratio} />
      </div>

      <div className="hidden text-xs text-[--color-muted] lg:block">
        Farma dnes strop {formatUsd(farmCap)}
      </div>
    </div>
  );
}
