// Formátování zpráv: HTML escape, badge stavů, progress bar, šablony reportů.
// Reporty jsou template-based (bez LLM), s vkusnými emoji a českým textem.

// --- kontrakt typů událostí (viz EVENT + AGENTS CONTRACT) --------------------

/** Proaktivní pozitivní reporty ("agent něco dodělal / v jakém je to stádiu"). */
export const POSITIVE_TYPES = [
  "wish_done",
  "wish_progress",
  "task_done",
  "publish.published",
  "deploy.preview.triggered",
  "deploy.prod.succeeded",
  "pr_opened",
  "assumptions_made",
  "qa_started",
  "qa_passed",
  "qa_fix_tasks",
] as const;

/** Reporty vyžadující pozornost uživatele. */
export const ATTENTION_TYPES = [
  "task_parked",
  "wish_parked",
  "out_of_credits",
  "budget_hold",
  "budget_hold_resumed",
  "circuit_breaker",
  "project_paused_auto",
  "deploy.prod.health_failed",
  "publish.failed",
  "qa_failed",
  "qa_error",
] as const;

/** Předpřipravený digest ('report' s data.text) — pošleme přímo. */
export const DIGEST_TYPES = ["report"] as const;

/** Proaktivní návrhy farmy „co dál" — pushované vlastníkovi (univerzální, jakýkoliv cíl). */
export const PROACTIVE_TYPES = ["suggestion_new"] as const;

/** Všechny typy, které reporter sleduje v events. */
export const ALL_REPORT_TYPES: readonly string[] = [
  ...POSITIVE_TYPES,
  ...ATTENTION_TYPES,
  ...DIGEST_TYPES,
  ...PROACTIVE_TYPES,
];

// --- emoji pro druh návrhu (SuggestionKind) — univerzální, kind-agnostické ----

const KIND_EMOJI: Record<string, string> = {
  improvement: "✨",
  feature: "🧩",
  fix: "🐞",
  test: "🧪",
  content: "🎬",
  automation: "⚙️",
  integration: "🔌",
  research: "🔬",
  refactor: "🧹",
  opportunity: "🚀",
};

/** Emoji pro druh návrhu farmy (fallback 💡 pro neznámý druh). */
export function kindEmoji(kind: string): string {
  return KIND_EMOJI[kind] ?? "💡";
}

// --- HTML pomocníci ----------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Tučně (bezpečně escapované). */
export function b(s: string): string {
  return `<b>${escapeHtml(s)}</b>`;
}

// --- badge stavů projektu ----------------------------------------------------

const STATUS_BADGE: Record<string, string> = {
  active: "▶️ aktivní",
  paused: "⏸️ pozastavený",
  budget_hold: "💸 budget hold",
  stopped: "⏹️ zastavený",
};

export function statusBadge(status: string): string {
  return STATUS_BADGE[status] ?? status;
}

// --- progress bar ------------------------------------------------------------

/** Např. progressBar(3,5) → "▰▰▰▱▱ 60%". */
export function progressBar(done: number, total: number, segments = 5): string {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const filled = total > 0 ? Math.min(segments, Math.round((done / total) * segments)) : 0;
  return `${"▰".repeat(filled)}${"▱".repeat(segments - filled)} ${pct}%`;
}

// --- doba trvání -------------------------------------------------------------

export function humanizeDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h} h ${remM} min` : `${h} h`;
}

// --- šablony reportů ---------------------------------------------------------

export interface ReportEvent {
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  projectName: string | null;
}

function str(data: Record<string, unknown> | null, key: string): string | undefined {
  if (!data) return undefined;
  const v = data[key];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function num(data: Record<string, unknown> | null, key: string): number | undefined {
  if (!data) return undefined;
  const v = data[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/**
 * Sestaví českou HTML zprávu pro proaktivní report, nebo null pokud typ
 * neumíme (reporter ho pak přeskočí, ale posune kurzor).
 */
export function formatReport(e: ReportEvent): string | null {
  const proj = e.projectName ? b(e.projectName) : b("Projekt");
  const wishTitle = str(e.data, "wishTitle") ?? str(e.data, "title");
  const taskTitle = str(e.data, "taskTitle") ?? str(e.data, "title");

  switch (e.type) {
    // --- pozitivní ---
    case "wish_done": {
      const n = num(e.data, "taskCount") ?? num(e.data, "tasksDone");
      const tail = n !== undefined ? ` (${n} ${czTasks(n)})` : "";
      const w = wishTitle ? `přání „${escapeHtml(wishTitle)}“` : "přání";
      return `✅ ${proj}: ${w} hotové${tail}.`;
    }
    case "wish_progress": {
      const pct = num(e.data, "percent") ?? 0;
      const w = wishTitle ? `„${escapeHtml(wishTitle)}“` : "přání";
      return `🚧 ${proj}: ${w} – ${Math.round(pct)}% hotovo.`;
    }
    case "task_done": {
      const t = taskTitle ? `úkol „${escapeHtml(taskTitle)}“` : "úkol";
      return `☑️ ${proj}: ${t} hotový.`;
    }
    case "publish.published": {
      const t = str(e.data, "caption") ?? taskTitle;
      const target = str(e.data, "target") ?? "Instagramu";
      const link = str(e.data, "permalink") ?? str(e.data, "url");
      const what = t ? `„${escapeHtml(trim(t, 60))}“` : "příspěvek";
      const suffix = link ? `\n${escapeHtml(link)}` : "";
      return `📣 ${proj}: ${what} zveřejněno na ${escapeHtml(target)}.${suffix}`;
    }
    case "deploy.preview.triggered": {
      const url = str(e.data, "url") ?? str(e.data, "previewUrl");
      const suffix = url ? `\n${escapeHtml(url)}` : "";
      return `🔎 ${proj}: náhledový deploy nasazen.${suffix}`;
    }
    case "deploy.prod.succeeded": {
      const url = str(e.data, "url") ?? str(e.data, "prodUrl");
      const suffix = url ? `\n${escapeHtml(url)}` : "";
      return `🚀 ${proj}: produkční deploy proběhl úspěšně.${suffix}`;
    }
    case "pr_opened": {
      const url = str(e.data, "url") ?? str(e.data, "prUrl");
      const title = str(e.data, "title");
      const what = title ? ` „${escapeHtml(trim(title, 60))}“` : "";
      const suffix = url ? `\n${escapeHtml(url)}` : "";
      return `🔀 ${proj}: otevřen PR${what}.${suffix}`;
    }
    case "assumptions_made": {
      const text = str(e.data, "text") ?? e.message;
      return `💡 ${proj}: manažer pokračoval s předpoklady — ${escapeHtml(trim(text, 300))}`;
    }

    // --- pozornost ---
    case "task_parked":
      return `⚠️ ${proj}: úkol zaparkován — potřebuje tvé rozhodnutí.`;
    case "wish_parked":
      return `⚠️ ${proj}: přání zaparkováno — čeká na tebe.`;
    case "out_of_credits":
      return `🚫 ${proj}: došel kredit — farma pozastavena. Doplň kredit v dashboardu.`;
    case "budget_hold":
      return `💸 ${proj}: denní strop vyčerpán, čekám do dalšího dne.`;
    case "budget_hold_resumed":
      return `▶️ ${proj}: rozpočet obnoven, pokračuji v práci.`;
    case "circuit_breaker":
      return `🛑 ${proj}: pojistka sepnula (opakované chyby) — práce zastavena.`;
    case "project_paused_auto":
      return `⏸️ ${proj}: projekt automaticky pozastaven.`;
    case "deploy.prod.health_failed":
      return `🩺 ${proj}: produkční deploy neprošel health checkem — vracím zpět.`;
    case "publish.failed":
      return `❌ ${proj}: publikace selhala.`;

    // --- QA (Tester agent) ---
    case "qa_started": {
      // Subtilní — jen naznač, že testování běží.
      const w = wishTitle ? `„${escapeHtml(trim(wishTitle, 60))}“` : "přání";
      return `🧪 ${proj}: Tester spustil QA pro ${w}…`;
    }
    case "qa_passed": {
      const n = num(e.data, "scenarioCount") ?? num(e.data, "scenarios");
      const w = wishTitle ? `„${escapeHtml(trim(wishTitle, 60))}“` : proj;
      const tail = n !== undefined ? ` — ${n} ${czScenarios(n)} ověřeno` : "";
      return `✅ QA prošlo: ${w}${tail}.`;
    }
    case "qa_failed": {
      const n = num(e.data, "failedCount") ?? num(e.data, "failed");
      const w = wishTitle ? `„${escapeHtml(trim(wishTitle, 60))}“` : proj;
      const tail = n !== undefined ? ` — ${n} ${czProblems(n)}` : "";
      return `❌ QA selhalo: ${w}${tail}, agenti to opravují.`;
    }
    case "qa_fix_tasks": {
      const n = num(e.data, "count") ?? 0;
      return `🔧 ${proj}: Tester našel problémy — založeno ${n} ${czFixTasks(n)}, agenti je řeší.`;
    }
    case "qa_error": {
      const text = str(e.data, "message") ?? e.message;
      const suffix = text ? ` — ${escapeHtml(trim(text, 200))}` : "";
      return `🧪 ${proj}: QA narazilo na chybu${suffix}.`;
    }

    // --- proaktivní návrh farmy (co dál) ---
    case "suggestion_new": {
      const title = str(e.data, "title") ?? e.message;
      const kind = str(e.data, "kind");
      const emoji = kind ? kindEmoji(kind) : "💡";
      const what = title ? `${emoji} ${escapeHtml(trim(title, 120))}` : "něco dalšího";
      // Projektový návrh vs. návrh napříč projekty (projectName == null).
      return e.projectName
        ? `💡 ${proj}: Farma navrhuje — ${what}`
        : `💡 Farma navrhuje (napříč projekty) — ${what}`;
    }

    // --- předpřipravený digest ---
    case "report": {
      const text = str(e.data, "text");
      if (!text) return null;
      return e.projectName ? `📨 ${proj}\n${escapeHtml(text)}` : `📨 ${escapeHtml(text)}`;
    }

    default:
      return null;
  }
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function czTasks(n: number): string {
  if (n === 1) return "úkol";
  if (n >= 2 && n <= 4) return "úkoly";
  return "úkolů";
}

function czScenarios(n: number): string {
  if (n === 1) return "scénář";
  if (n >= 2 && n <= 4) return "scénáře";
  return "scénářů";
}

function czProblems(n: number): string {
  if (n === 1) return "problém";
  if (n >= 2 && n <= 4) return "problémy";
  return "problémů";
}

function czFixTasks(n: number): string {
  if (n === 1) return "opravný úkol";
  if (n >= 2 && n <= 4) return "opravné úkoly";
  return "opravných úkolů";
}
