import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetScopeLabel, errorGroups, groupEvents, humanEventText, type FeedEvent } from "./event-groups";

let seq = 0;
function ev(p: Partial<FeedEvent>): FeedEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    ts: "2026-09-14T20:00:00.000Z",
    type: "attempt_started",
    level: "info",
    message: "zpráva",
    project_id: "p1",
    ...p,
  };
}

test("hromadná archivace se stejným run_id je jeden řádek s lidským textem", () => {
  const events: FeedEvent[] = [];
  for (let i = 0; i < 201; i++) events.push(ev({ type: "backlog_task_archived", run_id: "r1" }));
  for (let i = 0; i < 34; i++) events.push(ev({ type: "backlog_wish_archived", run_id: "r1" }));
  const g = groupEvents(events);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.count, 235);
  assert.equal(g[0]!.text, "Archivováno 201 úkolů a 34 přání historické fronty");
});

test("run_id slučuje i přes jiné události mezi nimi", () => {
  const g = groupEvents([
    ev({ type: "backlog_task_archived", run_id: "r1", ts: "2026-09-14T20:00:03Z" }),
    ev({ type: "task_done", ts: "2026-09-14T20:00:02Z" }),
    ev({ type: "backlog_task_archived", run_id: "r1", ts: "2026-09-14T20:00:01Z" }),
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0]!.count, 2);
  assert.equal(g[0]!.text, "Archivováno 2 úkoly historické fronty");
});

test("po sobě jdoucí stejný typ ve stejném projektu → „N× popisek“", () => {
  const g = groupEvents([
    ev({ type: "dispatch_error", level: "error" }),
    ev({ type: "dispatch_error", level: "error" }),
    ev({ type: "dispatch_error", level: "warn" }),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.text, "3× nepodařilo se spustit práci");
  assert.equal(g[0]!.level, "error");
});

test("stejný typ v jiném projektu se neslučuje; jedna událost ukáže zprávu", () => {
  const g = groupEvents([
    ev({ type: "task_done", project_id: "a", message: "Hotovo A" }),
    ev({ type: "task_done", project_id: "b", message: "Hotovo B" }),
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0]!.text, "Hotovo A");
});

test("filtr jen důležité zahodí šum a debug", () => {
  const g = groupEvents(
    [
      ev({ type: "dispatch_error", level: "error" }),
      ev({ type: "task_done" }),
      ev({ type: "attempt_started", level: "debug" }),
    ],
    { onlyImportant: true },
  );
  assert.deepEqual(
    g.map((x) => x.type),
    ["task_done"],
  );
});

test("poslední chyby: seskupené podle typu, nejčerstvější první, jen warn/error", () => {
  const g = errorGroups([
    ev({ type: "deploy_failed", level: "error", ts: "2026-09-15T16:23:00Z", message: "compose up selhal" }),
    ev({ type: "dispatch_error", level: "error", ts: "2026-09-15T10:00:00Z" }),
    ev({ type: "deploy_failed", level: "error", ts: "2026-09-15T04:21:00Z" }),
    ev({ type: "task_done", level: "info", ts: "2026-09-15T17:00:00Z" }),
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0]!.type, "deploy_failed");
  assert.equal(g[0]!.count, 2);
  assert.equal(g[0]!.lastMessage, "compose up selhal");
});

test("lidský text: budget_hold bez syrových kódů a s pravdivým pokračováním", () => {
  const zprava = "Projekt v budget_hold — překročen strop: project.";
  const label = "Projekt pozastaven rozpočtem";
  assert.equal(
    humanEventText({ type: "budget_hold", message: zprava, scope: "project" }, label),
    "Další pokus by překročil denní strop projektu. Projekt pokračuje sám po přetočení dne o půlnoci UTC.",
  );
  // Bez data.scope se kód vyčte ze zprávy; měsíční strop se o půlnoci nepřetočí.
  assert.equal(
    humanEventText({ type: "budget_hold", message: "Projekt v budget_hold — překročen strop: farm_month." }, label),
    "Další pokus by překročil měsíční strop farmy. Projekt čeká, až to rozpočet dovolí.",
  );
  const neznamy = humanEventText({ type: "budget_hold", message: "Projekt v budget_hold — překročen strop: xyz." }, label);
  assert.doesNotMatch(neznamy, /budget_hold|xyz/);
  assert.equal(budgetScopeLabel("user"), "denní strop uživatele");
  assert.equal(budgetScopeLabel("nesmysl"), null);
});

test("lidský text: bez zdvojení popisku a interních prefixů", () => {
  assert.equal(
    humanEventText(
      { type: "attempt_budget_deferred", message: "Práce čeká na rozpočet; rozpracované změny jsou uložené pro pokračování." },
      "Pokus odložen kvůli rozpočtu",
    ),
    "Rozpracované změny jsou uložené pro pokračování.",
  );
  assert.equal(
    humanEventText({ type: "orchestrator_start", message: "Orchestrátor nastartoval." }, "Orchestrátor nastartoval"),
    "",
  );
  assert.equal(humanEventText({ type: "orchestrator_stop", message: "Orchestrátor se vypíná." }, "Orchestrátor skončil"), "");
  assert.equal(
    humanEventText({ type: "attempt_started", message: "Worker start (worker-build): Audit SEO" }, "Pokus začal"),
    "Audit SEO",
  );
  assert.equal(
    humanEventText({ type: "farm_supervisor", message: "Supervisor: 4 návrhů napříč projekty." }, "Dohled nad farmou"),
    "4 návrhy napříč projekty.",
  );
  assert.equal(
    humanEventText({ type: "pr_opened", message: "PR otevřen (existující repo): https://github.com/x/y/pull/37" }, "Otevřen pull request"),
    "",
  );
});

test("skupina a poslední chyby používají lidský text; prázdný text = jen popisek", () => {
  const g = groupEvents([ev({ type: "orchestrator_start", message: "Orchestrátor nastartoval.", project_id: null })]);
  assert.equal(g[0]!.text, g[0]!.label);
  const chyby = errorGroups([
    ev({ type: "budget_hold", level: "warn", scope: "project", message: "Projekt v budget_hold — překročen strop: project." }),
  ]);
  assert.match(chyby[0]!.lastMessage ?? "", /^Další pokus by překročil denní strop projektu/);
});
