/**
 * PROJECT BRIEF — kompaktní, prioritizovaný souhrn nastřádaných znalostí projektu
 * (project_memory) injektovaný do promptů architekta/workerů/refillu.
 *
 * ČISTÝ helper (žádné LLM volání): z položek paměti složí stručný brief seřazený
 * podle důležitosti (architektura → rozhodnutí → konvence → nejnovější learningy →
 * glosář), s nejvyšší vahou první, ořezaný na maxChars. Cílem je porazit "context
 * rot": agent dostane jen to nejdůležitější, ne celou historii.
 */

const KIND_ORDER: Record<string, number> = {
  architecture: 0,
  decision: 1,
  convention: 2,
  learning: 3,
  glossary: 4,
};

const KIND_HEADING: Record<string, string> = {
  architecture: "ARCHITECTURE",
  decision: "DECISIONS",
  convention: "CONVENTIONS",
  learning: "LEARNINGS (avoid repeating past mistakes)",
  glossary: "GLOSSARY",
};

interface MemoryItem {
  kind: string;
  title: string;
  content: string;
  weight?: number;
}

/**
 * Složí brief. `maxChars` (default ~4000) je tvrdý strop celkové délky výstupu.
 * Vrací prázdný string, pokud není žádná paměť ani repo stav (volající pak brief
 * do promptu nevloží).
 */
export function buildProjectBrief(input: {
  memory: MemoryItem[];
  repoState?: string;
  maxChars?: number;
}): string {
  const maxChars = input.maxChars && input.maxChars > 0 ? input.maxChars : 4000;
  const items = Array.isArray(input.memory) ? input.memory.filter((m) => m && m.title && m.content) : [];

  // Seřaď: nejdřív podle typu (architektura nahoře), pak podle váhy sestupně.
  const sorted = [...items].sort((a, b) => {
    const ka = KIND_ORDER[a.kind] ?? 99;
    const kb = KIND_ORDER[b.kind] ?? 99;
    if (ka !== kb) return ka - kb;
    return (b.weight ?? 100) - (a.weight ?? 100);
  });

  const header = "# PROJECT BRIEF (accumulated knowledge — trust this, do not re-litigate)";
  const parts: string[] = [header];
  let used = header.length;

  // Rezervuj rozpočet pro repo stav (dostane vlastní ořez na konci).
  const repo = (input.repoState ?? "").trim();
  const repoBudget = repo ? Math.min(repo.length + 40, Math.floor(maxChars * 0.35)) : 0;
  const memoryBudget = maxChars - repoBudget;

  let currentKind = "";
  for (const m of sorted) {
    let block = "";
    if (m.kind !== currentKind) {
      const heading = KIND_HEADING[m.kind] ?? m.kind.toUpperCase();
      block += `\n\n## ${heading}`;
      currentKind = m.kind;
    }
    // Jednotlivé položky držíme stručné; dlouhý content ořízneme.
    const content = m.content.length > 700 ? `${m.content.slice(0, 700).trimEnd()}…` : m.content;
    block += `\n- **${m.title}**: ${content}`;

    if (used + block.length > memoryBudget) {
      // Ještě zkus vejít alespoň zkrácenou položku, jinak končíme.
      const remaining = memoryBudget - used;
      if (remaining > 80) {
        parts.push(block.slice(0, remaining - 1).trimEnd() + "…");
        used = memoryBudget;
      }
      break;
    }
    parts.push(block);
    used += block.length;
  }

  if (repo) {
    const trimmed = repo.length > repoBudget ? repo.slice(0, Math.max(0, repoBudget - 1)).trimEnd() + "…" : repo;
    parts.push(`\n\n## CURRENT REPO STATE\n${trimmed}`);
  }

  // Nic k dispozici → prázdný brief (volající ho pak neinjektuje).
  if (parts.length === 1 && !repo) return "";
  return parts.join("");
}
