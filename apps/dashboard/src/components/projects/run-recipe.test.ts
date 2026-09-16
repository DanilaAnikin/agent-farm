import assert from "node:assert/strict";
import { test } from "node:test";
import { runRecipeView, stepStateLabel } from "./run-recipe";

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
    discoveredAt: "2026-09-16T10:00:00.000Z",
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
  const view = runRecipeView(RECIPE, { type: "project_discovery_started", ts: "2026-09-16T12:00:00.000Z" });
  assert.equal(view.state, "discovering");
  assert.equal(view.headline, "Farma repozitář právě zkoumá.");
  // Starší událost než poslední recept znamená, že průzkum už doběhl.
  assert.equal(
    runRecipeView(RECIPE, { type: "project_discovery_started", ts: "2026-09-16T08:00:00.000Z" }).state,
    "verified",
  );
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

test("ruční recept bez metadat farma respektuje", () => {
  const view = runRecipeView({ install: "pnpm i", commands: { build: "pnpm build" } });
  assert.equal(view.state, "manual");
  assert.equal(view.steps.length, 2);
});

test("stepStateLabel je česky a bez anglicismů", () => {
  assert.equal(stepStateLabel("ok"), "ověřeno");
  assert.equal(stepStateLabel("failed"), "selhalo");
  assert.equal(stepStateLabel("skipped"), "projekt to nemá");
  assert.equal(stepStateLabel("unknown"), "neověřeno");
});
