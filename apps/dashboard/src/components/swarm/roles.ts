// Vizuální meta pro role agentů v roji — emoji, popisek a barevný akcent dlaždice.
// Barvíme dlaždice podle role, aby N paralelních agentů vypadalo jako živý roj.
// Popisky jsou česky a stejné jako AGENT_ROLE_META v lib/constants.ts.
import type { AgentRole } from "@/lib/types";
import { formatDuration } from "@/lib/format";

export interface RoleMeta {
  emoji: string;
  label: string;
  // Akcent celé dlaždice (rámeček + pozadí).
  tile: string;
  // Barevný „chip" pod emoji.
  chip: string;
  // Barva pulzující tečky / textu.
  dot: string;
  text: string;
}

export const ROLE_META: Record<AgentRole, RoleMeta> = {
  worker: {
    emoji: "⚙️",
    label: "Vývojář",
    tile: "border-(--color-brand)/30 bg-(--color-brand-soft)/50",
    chip: "bg-(--color-brand-soft) text-(--color-brand)",
    dot: "bg-(--color-brand)",
    text: "text-(--color-brand)",
  },
  manager: {
    emoji: "🧭",
    label: "Manažer",
    tile: "border-(--color-info)/30 bg-(--color-info-bg)/50",
    chip: "bg-(--color-info-bg) text-(--color-info)",
    dot: "bg-(--color-info)",
    text: "text-(--color-info)",
  },
  judge: {
    emoji: "⚖️",
    label: "Soudce",
    tile: "border-(--color-violet)/30 bg-(--color-violet-bg)/50",
    chip: "bg-(--color-violet-bg) text-(--color-violet)",
    dot: "bg-(--color-violet)",
    text: "text-(--color-violet)",
  },
  // Tester (QA) se dosud registroval jako 'judge', takže se ve velíně zobrazoval
  // jako Soudce a nešlo poznat, kdo testuje.
  tester: {
    emoji: "🧪",
    label: "Tester",
    tile: "border-(--color-ok)/30 bg-(--color-ok-bg)/40",
    chip: "bg-(--color-ok-bg) text-(--color-ok)",
    dot: "bg-(--color-ok)",
    text: "text-(--color-ok)",
  },
  media: {
    emoji: "🎬",
    label: "Média",
    tile: "border-(--color-warn)/30 bg-(--color-warn-bg)/40",
    chip: "bg-(--color-warn-bg) text-(--color-warn)",
    dot: "bg-(--color-warn)",
    text: "text-(--color-warn)",
  },
  publisher: {
    emoji: "📡",
    label: "Publikace",
    tile: "border-(--color-brand-2)/30 bg-(--color-info-bg)/40",
    chip: "bg-(--color-info-bg) text-(--color-brand-2)",
    dot: "bg-(--color-brand-2)",
    text: "text-(--color-brand-2)",
  },
};

/** Záloha pro roli, kterou orchestrátor zavede dřív, než ji sem někdo dopíše. */
const NEZNAMA_ROLE: RoleMeta = {
  emoji: "🤖",
  label: "Agent",
  tile: "border-(--color-border) bg-(--color-surface-2)",
  chip: "bg-(--color-surface) text-(--color-muted)",
  dot: "bg-(--color-faint)",
  text: "text-(--color-muted)",
};

/** Meta role s fallbackem — neznámá role nesmí shodit celou mřížku. */
export function roleMeta(role: string): RoleMeta {
  return (ROLE_META as Record<string, RoleMeta>)[role] ?? { ...NEZNAMA_ROLE, label: role || "Agent" };
}

// Pořadí rolí v legendě (vývojáři jako první — jádro roje).
export const ROLE_ORDER: AgentRole[] = [
  "worker",
  "manager",
  "judge",
  "tester",
  "media",
  "publisher",
];

// Doba běhu → krátký český tvar ("45 s", "3 min", "1 h 4 min").
export function formatElapsed(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "—";
  if (seconds === 0) return "0 s";
  return formatDuration(seconds);
}
