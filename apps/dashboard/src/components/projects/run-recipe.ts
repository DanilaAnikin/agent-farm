/**
 * „Jak farma projekt spouští" — čtení receptu (projects.env_recipe) pro UI.
 *
 * Recept zjišťuje a ověřuje farma sama (orchestrátor, project-discovery.ts);
 * dashboard ho jen ukazuje. Proto tady NENÍ žádná výzva k lidskému zásahu:
 * neověřený recept je stav, který si farma sama zopakuje, ne úkol pro člověka.
 *
 * Bez `@/` importů a bez runtime závislostí — čitelné i z testu.
 */

export type RunRecipeState = "missing" | "discovering" | "verified" | "failed" | "manual";
export type RunRecipeTone = "ok" | "warn" | "info" | "neutral";
export type StepState = "ok" | "failed" | "skipped" | "unknown";

export interface RunRecipeStep {
  key: string;
  label: string;
  /** Prázdné u kroku, který se neověřil a farma ho z receptu vyhodila. */
  command: string;
  state: StepState;
}

export interface RunRecipeView {
  state: RunRecipeState;
  /** Věta o stavu — bez výzvy k zásahu. */
  headline: string;
  tone: RunRecipeTone;
  steps: RunRecipeStep[];
  /** Služby, které projekt potřebuje (a které sandbox neumí spustit). */
  services: string[];
  /** JEN názvy proměnných prostředí — hodnoty se v UI nikdy nezobrazují. */
  envNames: string[];
  port: number | null;
  healthcheck: string | null;
  discoveredAt: string | null;
  commit: string | null;
  attempts: number | null;
  notes: string | null;
  /** Dřívější ruční poznámka, kterou průzkum přepsal (text od člověka). */
  replaced: string | null;
}

export interface DiscoveryEvent {
  type: string;
  ts: string;
}

const STEP_LABELS: [key: string, label: string, verifiedKey: string][] = [
  ["install", "Instalace", "install"],
  ["build", "Build", "build"],
  ["typecheck", "Typová kontrola", "typecheck"],
  ["lint", "Lint", "lint"],
  ["test", "Testy", "tests"],
  ["start", "Spuštění aplikace", "start"],
];

/** Kroky, jejichž „ok" se počítá jako důkaz, že recept funguje (stejně jako v @farm/core). */
const VERIFIED_KEYS = ["install", "build", "typecheck", "lint", "tests", "start"];

/**
 * Jak dlouho po události „zkoumá se" se ještě věří, že průzkum běží.
 *
 * Horní odhad jednoho kola sondy je ~3 × (12 min kontroly + 6 min start). Bez
 * tohohle okna stačilo, aby běh skončil bez koncové události, a karta tvrdila
 * „farma repozitář právě zkoumá" klidně 15 dní.
 */
const DISCOVERING_MAX_MS = 60 * 60_000;

const HEADLINE: Record<RunRecipeState, { text: string; tone: RunRecipeTone }> = {
  discovering: { text: "Farma repozitář právě zkoumá.", tone: "info" },
  verified: { text: "Recept ověřen — farma projekt umí spustit.", tone: "ok" },
  failed: { text: "Recept se nepodařilo ověřit — farma to zkusí znovu sama.", tone: "warn" },
  missing: { text: "Farma repozitář prozkoumá, jakmile na projektu začne pracovat.", tone: "neutral" },
  manual: { text: "Recept je nastavený ručně — farma ho respektuje.", tone: "neutral" },
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stepState(verified: Record<string, unknown> | null, key: string): StepState {
  const value = verified?.[key];
  return value === "ok" || value === "failed" || value === "skipped" ? value : "unknown";
}

/** Sestaví z env_recipe (a poslední události průzkumu) model pro kartu v UI. */
export function runRecipeView(envRecipe: unknown, lastEvent?: DiscoveryEvent | null): RunRecipeView {
  const recipe = object(envRecipe) ?? {};
  const meta = object(recipe.meta);
  const verified = object(meta?.verified);
  const commands = object(recipe.commands);

  const steps: RunRecipeStep[] = [];
  for (const [key, label, verifiedKey] of STEP_LABELS) {
    const command =
      key === "install"
        ? text(recipe.install)
        : key === "start"
          ? text(recipe.start)
          : text(commands?.[key]) ?? text(recipe[key]);
    if (command) {
      steps.push({ key, label, command, state: stepState(verified, verifiedKey) });
      continue;
    }
    // Krok, který selhal a farma ho z receptu vyhodila (pruneUnverifiedRecipe).
    // Bez něj by varovný stav neměl v kartě žádný viditelný důvod.
    if (verified?.[verifiedKey] === "failed") {
      steps.push({ key, label, command: "", state: "failed" });
    }
  }

  const discoveredAt = text(meta?.discoveredAt);
  const eventAt = lastEvent ? new Date(lastEvent.ts).getTime() : Number.NaN;
  const running =
    lastEvent?.type === "project_discovery_started" &&
    !Number.isNaN(eventAt) &&
    // Událost je novější než poslední dokončený recept → průzkum právě běží.
    (!discoveredAt || eventAt >= new Date(discoveredAt).getTime()) &&
    // …a ne starší, než může jedno kolo trvat (jinak je to zaseknutá událost).
    Date.now() - eventAt < DISCOVERING_MAX_MS;

  let state: RunRecipeState;
  if (running) {
    state = "discovering";
  } else if (meta && meta.source !== "manual") {
    // Metadata se čtou DŘÍV než prázdnost kroků: po úplně neúspěšném průzkumu
    // je recept prázdný (všechno se zahodilo), ale „zatím nic" by lhalo —
    // farma to zkoušela a nepovedlo se.
    state = viewVerificationPassed(verified, Boolean(text(recipe.start))) ? "verified" : "failed";
  } else if (steps.length > 0) {
    state = "manual";
  } else {
    state = "missing";
  }

  const services: string[] = [];
  if (Array.isArray(recipe.services)) {
    for (const svc of recipe.services) {
      const name = text(object(svc)?.name);
      const kind = text(object(svc)?.kind);
      if (name) services.push(kind && kind !== name ? `${name} (${kind})` : name);
    }
  }

  const envNames = Object.keys(object(recipe.env) ?? {}).sort();
  const port = Number(recipe.port);
  const attempts = Number(meta?.attempts);

  return {
    state,
    headline: HEADLINE[state].text,
    tone: HEADLINE[state].tone,
    steps,
    services,
    envNames,
    port: Number.isInteger(port) && port > 0 ? port : null,
    healthcheck: text(recipe.healthcheck),
    discoveredAt,
    commit: text(meta?.commit),
    attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : null,
    notes: text(meta?.notes),
    replaced: text(meta?.replaced),
  };
}

/**
 * Stejné pravidlo jako `verificationPassed` v @farm/core: recept je ověřený,
 * když nic podstatného neselhalo a aspoň jeden krok opravdu prošel. Projekt,
 * který instalaci nepotřebuje a jehož jediná kontrola prošla, tedy není
 * „neověřený" — dřív se tak hlásil a farma ho zbytečně přeměřovala.
 */
function viewVerificationPassed(verified: Record<string, unknown> | null, hasStart: boolean): boolean {
  if (verified?.install === "failed" || verified?.start === "failed") return false;
  if (hasStart && verified?.start !== "ok") return false;
  return VERIFIED_KEYS.some((key) => verified?.[key] === "ok");
}

/**
 * Krátký popisek stavu kroku (pro tooltip/štítek).
 *
 * `hasCommand` rozlišuje dvě velmi různé věci: krok, který projekt nemá, a krok,
 * který v receptu JE, ale ověřit ho nešlo (např. start v lokálním režimu nebo
 * bez potřebných služeb) — u toho by „projekt to nemá" bylo prostě nepravda.
 */
export function stepStateLabel(state: StepState, hasCommand = true): string {
  switch (state) {
    case "ok":
      return "ověřeno";
    case "failed":
      return "selhalo";
    case "skipped":
      return hasCommand ? "nešlo ověřit" : "projekt to nemá";
    case "unknown":
      return "neověřeno";
  }
}
