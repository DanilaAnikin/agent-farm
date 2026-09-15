import { AGENT_ROLE_META, AGENT_STATUS_META } from "@/lib/constants";
import { Bot } from "lucide-react";
import { formatRelative } from "@/lib/format";
import { modelLabel } from "@/lib/admin-guards";
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

const ROLE_GLYPH: Record<AgentRole, string> = {
  manager: "◆",
  worker: "▲",
  judge: "⚖",
  // Tester (QA) se dosud registroval jako 'judge' → ve velíně byl vidět Soudce.
  tester: "✓",
  media: "◈",
  publisher: "➤",
};

/** Popisek role s fallbackem — neznámá role nesmí shodit registr. */
function roleLabel(role: string): string {
  return (AGENT_ROLE_META as Record<string, { label: string }>)[role]?.label ?? (role || "Agent");
}

function roleGlyph(role: string): string {
  return (ROLE_GLYPH as Record<string, string>)[role] ?? "●";
}

/**
 * Živý registr agentů — „kdo právě pracuje". Busy agenti pulzují.
 * `variant='strip'` = kompaktní pruh na velínu, `variant='list'` = svislý seznam v detailu.
 *
 * Prázdný stav říká DŮVOD nečinnosti (ze stavu farmy), ne „jakmile dostane farma
 * přání, agenti naskočí" — farma si práci doplňuje sama.
 */
export function LiveAgents({
  agents,
  variant = "list",
  emptyTitle = "Nikdo právě nepracuje",
  emptyHint,
}: {
  agents: AgentDisplay[];
  variant?: "strip" | "list";
  emptyTitle?: string;
  emptyHint?: string;
}) {
  if (agents.length === 0) {
    if (variant === "strip") {
      // Na velínu jen jeden řádek — velká prázdná karta nic neříká a zabírá místo.
      return (
        <p className="flex items-center gap-2 text-sm text-[--color-muted]">
          <Bot className="size-4 shrink-0 text-[--color-faint]" />
          <span>
            {emptyTitle}
            {emptyHint ? <span className="text-[--color-faint]"> · {emptyHint}</span> : null}
          </span>
        </p>
      );
    }
    return (
      <EmptyState icon={<Bot className="size-5" />} title={emptyTitle} description={emptyHint} />
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
                {roleGlyph(a.role)}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{roleLabel(a.role)}</span>
                  {a.projectName ? (
                    <span className="truncate text-xs text-[--color-faint]">{a.projectName}</span>
                  ) : null}
                </div>
                <div className="truncate text-xs text-[--color-muted]">
                  {busy && a.currentTaskTitle ? a.currentTaskTitle : a.model ? modelLabel(a.model) : roleLabel(a.role)}
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
                {roleGlyph(a.role)}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{roleLabel(a.role)}</span>
                  {a.model ? <span className="text-xs text-[--color-faint]">{modelLabel(a.model)}</span> : null}
                </div>
                <div className="truncate text-xs text-[--color-muted]" suppressHydrationWarning>
                  {busy && a.currentTaskTitle
                    ? a.currentTaskTitle
                    : `poslední signál ${formatRelative(a.lastHeartbeat)}`}
                </div>
              </div>
            </div>
            <StatusBadge meta={AGENT_STATUS_META[a.status] ?? { label: a.status, tone: "neutral" }} dot />
          </li>
        );
      })}
    </ul>
  );
}
