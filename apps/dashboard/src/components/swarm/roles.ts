// Vizuální meta pro role agentů v roji — emoji, popisek a barevný akcent dlaždice.
// Barvíme dlaždice podle role, aby N paralelních agentů vypadalo jako živý roj.
import type { AgentRole } from "@/lib/types";

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
    label: "Worker",
    tile: "border-[--color-brand]/30 bg-[--color-brand-soft]/50",
    chip: "bg-[--color-brand-soft] text-[--color-brand]",
    dot: "bg-[--color-brand]",
    text: "text-[--color-brand]",
  },
  manager: {
    emoji: "🧭",
    label: "Manažer",
    tile: "border-[--color-info]/30 bg-[--color-info-bg]/50",
    chip: "bg-[--color-info-bg] text-[--color-info]",
    dot: "bg-[--color-info]",
    text: "text-[--color-info]",
  },
  judge: {
    emoji: "⚖️",
    label: "Soudce",
    tile: "border-[--color-violet]/30 bg-[--color-violet-bg]/50",
    chip: "bg-[--color-violet-bg] text-[--color-violet]",
    dot: "bg-[--color-violet]",
    text: "text-[--color-violet]",
  },
  // Tester (QA) se dosud registroval jako 'judge', takže se ve velíně zobrazoval
  // jako Soudce a nešlo poznat, kdo testuje.
  tester: {
    emoji: "🧪",
    label: "Tester",
    tile: "border-[--color-ok]/30 bg-[--color-ok-bg]/40",
    chip: "bg-[--color-ok-bg] text-[--color-ok]",
    dot: "bg-[--color-ok]",
    text: "text-[--color-ok]",
  },
  media: {
    emoji: "🎬",
    label: "Média",
    tile: "border-[--color-warn]/30 bg-[--color-warn-bg]/40",
    chip: "bg-[--color-warn-bg] text-[--color-warn]",
    dot: "bg-[--color-warn]",
    text: "text-[--color-warn]",
  },
  publisher: {
    emoji: "📡",
    label: "Publisher",
    tile: "border-[--color-brand-2]/30 bg-[--color-info-bg]/40",
    chip: "bg-[--color-info-bg] text-[--color-brand-2]",
    dot: "bg-[--color-brand-2]",
    text: "text-[--color-brand-2]",
  },
};

// Pořadí rolí v legendě (workeři jako první — jádro roje).
export const ROLE_ORDER: AgentRole[] = [
  "worker",
  "manager",
  "judge",
  "tester",
  "media",
  "publisher",
];

// Doba běhu → krátký český tvar ("3 min", "1 h 4 min").
export function formatElapsed(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "—";
  if (seconds < 60) return `${seconds} s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min} min`;
  const hod = Math.floor(min / 60);
  const zbytek = min % 60;
  return zbytek === 0 ? `${hod} h` : `${hod} h ${zbytek} min`;
}
