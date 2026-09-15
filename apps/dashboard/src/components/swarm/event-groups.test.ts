import assert from "node:assert/strict";
import { test } from "node:test";
import { errorGroups, groupEvents, type FeedEvent } from "./event-groups";

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
