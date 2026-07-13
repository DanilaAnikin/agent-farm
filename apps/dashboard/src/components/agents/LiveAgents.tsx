import { AGENT_STATUS_META } from "@/lib/constants";
import { Bot } from "lucide-react";
import { formatRelative } from "@/lib/format";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/Badge";
import type { AgentRole, AgentStatus } from "@/lib/types";

export interface AgentDisplay {
  id: string;
  role: AgentRole;
  model: string | null;
  status: AgentStatus;
  lastHeartbeat: string;
  currentTaskTitle?: string | null;
  projectName?: string | null;
}

const ROLE_LABEL: Record<AgentRole, string> = {
  manager: "Manažer",
  worker: "Worker",
  judge: "Soudce",
  media: "Média",
  publisher: "Publisher",
};

const ROLE_GLYPH: Record<AgentRole, string> = {
  manager: "◆",
  worker: "▲",
  judge: "⚖",
  media: "◈",
  publisher: "➤",
};

/**
 * Živý registr agentů — „kdo právě pracuje". Busy agenti pulzují.
 * `variant='strip'` = kompaktní pruh na home, `variant='list'` = svislý seznam v detailu.
 */
export function LiveAgents({
  agents,
  variant = "list",
  emptyHint,
}: {
  agents: AgentDisplay[];
  variant?: "strip" | "list";
  emptyHint?: string;
}) {
  if (agents.length === 0) {
    return (
      <EmptyState
        icon={<Bot className="size-5" />}
        title="Nikdo právě nepracuje"
        description={emptyHint ?? "Jakmile dostane farma přání, agenti naskočí a uvidíš je tady živě."}
      />
    );
  }

  if (variant === "strip") {
    return (
      <div className="flex gap-3 overflow-x-auto pb-1">
        {agents.map((a) => {
          const busy = a.status === "busy";
          return (
            <div
              key={a.id}
              className="flex min-w-56 shrink-0 items-center gap-3 rounded-xl border border-[--color-border] bg-[--color-surface-2] px-3 py-2.5"
            >
              <span
                className={
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm " +
                  (busy
                    ? "bg-[--color-brand-soft] text-[--color-brand] animate-farm-pulse"
                    : "bg-[--color-surface] text-[--color-muted]")
                }
              >
                {ROLE_GLYPH[a.role]}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{ROLE_LABEL[a.role]}</span>
                  {a.projectName ? (
                    <span className="truncate text-xs text-[--color-faint]">{a.projectName}</span>
                  ) : null}
                </div>
                <div className="truncate text-xs text-[--color-muted]">
                  {busy && a.currentTaskTitle ? a.currentTaskTitle : a.model ?? ROLE_LABEL[a.role]}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {agents.map((a) => {
        const busy = a.status === "busy";
        return (
          <li
            key={a.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-[--color-border] px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs " +
                  (busy
                    ? "bg-[--color-brand-soft] text-[--color-brand] animate-farm-pulse"
                    : "bg-[--color-surface-2] text-[--color-muted]")
                }
              >
                {ROLE_GLYPH[a.role]}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{ROLE_LABEL[a.role]}</span>
                  {a.model ? <span className="text-xs text-[--color-faint]">{a.model}</span> : null}
                </div>
                <div className="truncate text-xs text-[--color-muted]">
                  {busy && a.currentTaskTitle
                    ? a.currentTaskTitle
                    : `naposledy ${formatRelative(a.lastHeartbeat)}`}
                </div>
              </div>
            </div>
            <StatusBadge meta={AGENT_STATUS_META[a.status]} dot />
          </li>
        );
      })}
    </ul>
  );
}
