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
    if (!command) continue;
    steps.push({ key, label, command, state: stepState(verified, verifiedKey) });
  }

  const discoveredAt = text(meta?.discoveredAt);
  const running =
    lastEvent?.type === "project_discovery_started" &&
    // Událost je novější než poslední dokončený recept → průzkum právě běží.
    (!discoveredAt || new Date(lastEvent.ts).getTime() >= new Date(discoveredAt).getTime());

  let state: RunRecipeState;
  if (running) state = "discovering";
  else if (steps.length === 0) state = "missing";
  else if (!meta || meta.source === "manual") state = "manual";
  else {
    const installOk = verified?.install === "ok";
    const startOk = verified?.start === "ok";
    const startFailed = verified?.start === "failed";
    state = (installOk || startOk) && !startFailed && verified?.install !== "failed" ? "verified" : "failed";
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
  };
}

/** Krátký popisek stavu kroku (pro tooltip/štítek). */
export function stepStateLabel(state: StepState): string {
  switch (state) {
    case "ok":
      return "ověřeno";
    case "failed":
      return "selhalo";
    case "skipped":
      return "projekt to nemá";
    case "unknown":
      return "neověřeno";
  }
}
