/**
 * Čistá logika „smí farma pracovat?" a „jak je na tom flotila?" — bez DB, bez env.
 *
 * Proč zvlášť: orchestrátor se dřív na nedostupný rozpočtový hlídač ptal tak, že
 * `guardedSpend()` vyhodila výjimku a všech ~16 smyček ji hlásilo jako pád. Farma
 * sice (správně) nic neutrácela, ale navenek to vypadalo jako rozbitý proces
 * a důvod nečinnosti nikde nebyl. Tady je rozhodnutí jako čistá funkce, aby šlo
 * otestovat a aby ho dashboard i orchestrátor četli stejně.
 */

/** Důvod, proč farma stojí, i když není pauza. */
export type FarmIdleReason = "guard_not_ready" | "guard_unreachable" | "budget_cap";

export interface GuardProbe {
  /** Vyžaduje nasazení hlídač? (FARM_BUDGET_GUARD_REQUIRED=true) */
  required: boolean;
  /** `true` připraven, `false` hlídač sám hlásí nepřipravenost, `null` nevíme. */
  ready: boolean | null;
  /** Chyba při čtení stavu hlídače (výjimka, chybějící tabulka, nesmyslné součty). */
  error?: string | null;
  /** Vyčerpaný strop (den/měsíc) jako text markeru, jinak null/undefined. */
  budgetBlock?: string | null;
}

export type FarmRunDecision =
  | { run: true }
  | { run: false; reason: FarmIdleReason; marker: string };

/**
 * Rozhodne, zda smí farma dělat placenou práci.
 *
 * Fail closed: když je hlídač povinný, pracuje se JEN při výslovném `ready=true`.
 * Nedostupnost se nesmí vykládat jako „ok" — to by byla přesně ta díra, kterou
 * hlídač zavírá. Když povinný není, jeho stav rozhodnutí neblokuje (farma pak
 * počítá jen z vlastního ledgeru, stejně jako dřív `guardedSpend`).
 */
export function farmRunDecision(probe: GuardProbe): FarmRunDecision {
  if (probe.required) {
    if (probe.error) return { run: false, reason: "guard_unreachable", marker: "guard_unreachable" };
    if (probe.ready === false) return { run: false, reason: "guard_not_ready", marker: "guard_not_ready" };
    if (probe.ready !== true) return { run: false, reason: "guard_unreachable", marker: "guard_unreachable" };
  }
  if (probe.budgetBlock) return { run: false, reason: "budget_cap", marker: probe.budgetBlock };
  return { run: true };
}

/** Je důvod nečinnosti na straně hlídače (ne vyčerpaný strop)? */
export function isGuardIdleReason(reason: FarmIdleReason): boolean {
  return reason === "guard_not_ready" || reason === "guard_unreachable";
}

// --- Zdraví flotily ----------------------------------------------------------

/** Práh živého tepu agenta — stejný jako u reconciliace pokusů (3 min). */
export const AGENT_LIVE_HEARTBEAT_MS = 3 * 60_000;

export interface AgentHealthInput {
  status: string;
  lastHeartbeat: Date | string | null | undefined;
}

export interface AgentHealth {
  /** busy|idle s tepem mladším než práh. */
  live: number;
  /** busy s živým tepem — agent, který opravdu pracuje. */
  working: number;
  /** busy|idle s mrtvým tepem — tváří se živě, ale netepe (NE dávno ukončení 'dead'). */
  stalled: number;
}

/**
 * Sečte zdraví flotily. `working` schválně vyžaduje i živý tep: busy agent, který
 * netepe, nepracuje — patří do `stalled`, jinak by velín hlásil práci, která neběží.
 * Řádky 'dead' se nepočítají nikam: to jsou už uklizení agenti, ne poplach.
 */
export function agentHealth(
  agents: readonly AgentHealthInput[],
  now: Date | number = Date.now(),
  liveMs: number = AGENT_LIVE_HEARTBEAT_MS,
): AgentHealth {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const out: AgentHealth = { live: 0, working: 0, stalled: 0 };
  for (const a of agents) {
    if (a.status !== "busy" && a.status !== "idle") continue;
    const beat = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : Number.NaN;
    const fresh = Number.isFinite(beat) && nowMs - beat < liveMs;
    if (fresh) {
      out.live += 1;
      if (a.status === "busy") out.working += 1;
    } else {
      out.stalled += 1;
    }
  }
  return out;
}

// --- Tajemství v chybových hláškách -------------------------------------------

/** Známé tvary GitHub tokenů a tokenů vložených do URL. */
const TOKEN_PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /x-access-token:[^@\s]+@/g,
  /(authorization:\s*(?:token|bearer)\s+)[^\s"']+/gi,
];

/**
 * Zbaví text tajemství a zkrátí ho. Používá se na chybové zprávy, které jdou do
 * DB (farm_settings je čitelné z dashboardu) — token tam nesmí skončit ani zčásti.
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = [], max = 200): string {
  let out = String(text);
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[skryto]");
  }
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (m, prefix?: string) =>
      typeof prefix === "string" && m.startsWith(prefix) ? `${prefix}[skryto]` : "[skryto]",
    );
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
