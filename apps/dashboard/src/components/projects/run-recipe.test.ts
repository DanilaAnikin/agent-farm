import assert from "node:assert/strict";
import { test } from "node:test";
import { runRecipeView, stepStateLabel } from "./run-recipe";

/**
 * Čas se počítá vůči „teď": karta bere událost „zkoumá se" jako běžící práci
 * jen v rozumném okně, takže fixní datum v minulosti by test časem rozbilo.
 */
const DISCOVERED_AT = new Date(Date.now() - 2 * 3_600_000).toISOString();

const RECIPE = {
  install: "pnpm install --frozen-lockfile --ignore-scripts",
  commands: { build: "pnpm run build", test: "pnpm run test" },
  start: "pnpm --filter @app/web run dev",
  port: 3000,
  healthcheck: "/",
  services: [{ name: "postgres", kind: "postgres", required: true }],
  env: { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", APP_URL: "http://127.0.0.1:3000" },
  meta: {
    source: "auto",
    discoveredAt: DISCOVERED_AT,
    commit: "abcdef1234567890abcdef1234567890abcdef12",
    manifestFingerprint: "v1:abc",
    attempts: 1,
    verified: { install: "ok", build: "ok", tests: "failed", lint: "skipped", start: "ok" },
  },
};

test("ověřený recept: kroky, porty, služby a jen NÁZVY proměnných", () => {
  const view = runRecipeView(RECIPE);
  assert.equal(view.state, "verified");
  assert.equal(view.headline, "Recept ověřen — farma projekt umí spustit.");
  assert.deepEqual(
    view.steps.map((s) => `${s.key}:${s.state}`),
    ["install:ok", "build:ok", "test:failed", "start:ok"],
  );
  assert.equal(view.port, 3000);
  assert.deepEqual(view.services, ["postgres"]);
  assert.deepEqual(view.envNames, ["APP_URL", "NEXT_PUBLIC_SUPABASE_URL"]);
  assert.equal(view.commit, RECIPE.meta.commit);
  assert.equal(view.attempts, 1);
});

test("hodnoty proměnných se do UI modelu vůbec nedostanou", () => {
  const view = runRecipeView({ ...RECIPE, env: { TOKEN: "hodnota-co-se-nesmi-ukazat" } });
  assert.deepEqual(view.envNames, ["TOKEN"]);
  assert.doesNotMatch(JSON.stringify(view), /hodnota-co-se-nesmi-ukazat/);
});

test("prázdný recept nevyzývá člověka k ničemu", () => {
  const view = runRecipeView({});
  assert.equal(view.state, "missing");
  assert.deepEqual(view.steps, []);
  assert.doesNotMatch(view.headline, /vypln|zadej|nastav|doplň/i);
});

test("běžící průzkum přebije uložený recept", () => {
  const view = runRecipeView(RECIPE, {
    type: "project_discovery_started",
    ts: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(view.state, "discovering");
  assert.equal(view.headline, "Farma repozitář právě zkoumá.");
  // Starší událost než poslední recept znamená, že průzkum už doběhl.
  assert.equal(
    runRecipeView(RECIPE, {
      type: "project_discovery_started",
      ts: new Date(Date.now() - 4 * 3_600_000).toISOString(),
    }).state,
    "verified",
  );
});

test("zaseknutá událost „zkoumá se\" po čase přestane platit", () => {
  // Průzkum, který skončil bez koncové události (rozpočet, pád, kill), nesmí
  // kartu držet na „farma právě zkoumá" klidně dny.
  const view = runRecipeView(
    { meta: { source: "auto", attempts: 3, verified: { install: "failed" } } },
    { type: "project_discovery_started", ts: new Date(Date.now() - 3 * 3_600_000).toISOString() },
  );
  assert.equal(view.state, "failed");
});

test("neověřený recept hlásí, že to farma zkusí znovu — ne že má zasáhnout člověk", () => {
  const failed = runRecipeView({
    ...RECIPE,
    meta: { ...RECIPE.meta, verified: { install: "failed", start: "failed" } },
  });
  assert.equal(failed.state, "failed");
  assert.match(failed.headline, /farma to zkusí znovu sama/i);
  assert.doesNotMatch(failed.headline, /vypln|zadej|nastav/i);
});

test("po úplně neúspěšném průzkumu karta neříká „zatím nic\"", () => {
  // `pruneUnverifiedRecipe` zahodí install, commands i start — zbydou metadata.
  const view = runRecipeView({
    meta: {
      source: "auto",
      discoveredAt: DISCOVERED_AT,
      commit: null,
      manifestFingerprint: null,
      attempts: 3,
      verified: { install: "failed", build: "failed", tests: "failed", start: "failed" },
    },
  });
  assert.equal(view.state, "failed");
  assert.match(view.headline, /nepodařilo ověřit/i);
  // Zahozené kroky se v kartě ukážou i bez příkazu — jinak nemá varovný stav
  // žádný viditelný důvod.
  assert.deepEqual(
    view.steps.map((s) => `${s.key}:${s.state}:${s.command}`),
    ["install:failed:", "build:failed:", "test:failed:", "start:failed:"],
  );
});

test("projekt bez instalace, jehož jediná kontrola prošla, je ověřený", () => {
  const view = runRecipeView({
    commands: { test: "pytest -q" },
    meta: {
      source: "auto",
      discoveredAt: DISCOVERED_AT,
      attempts: 1,
      verified: { install: "skipped", tests: "ok", start: "skipped" },
    },
  });
  assert.equal(view.state, "verified");
});

test("ruční recept bez metadat farma respektuje", () => {
  const view = runRecipeView({ install: "pnpm i", commands: { build: "pnpm build" } });
  assert.equal(view.state, "manual");
  assert.equal(view.steps.length, 2);
});

test("dřívější ruční poznámka se v kartě neztratí", () => {
  const view = runRecipeView({
    install: "pnpm install",
    meta: {
      source: "auto",
      discoveredAt: DISCOVERED_AT,
      attempts: 1,
      verified: { install: "ok" },
      replaced: '{"note":"spusť to přes make dev"}',
    },
  });
  assert.match(view.replaced ?? "", /make dev/);
});

test("stepStateLabel je česky a rozlišuje „nemá\" od „nešlo ověřit\"", () => {
  assert.equal(stepStateLabel("ok"), "ověřeno");
  assert.equal(stepStateLabel("failed"), "selhalo");
  // Krok, který v receptu JE, ale ověřit ho nešlo (lokální režim, chybějící služby).
  assert.equal(stepStateLabel("skipped", true), "nešlo ověřit");
  assert.equal(stepStateLabel("skipped", false), "projekt to nemá");
  assert.equal(stepStateLabel("unknown"), "neověřeno");
});
