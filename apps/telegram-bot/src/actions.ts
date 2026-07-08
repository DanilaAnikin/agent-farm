// Sdílené zapisovací akce (pauza/obnova, poznámka manažerovi, založení přání).
// Sdílí je textové příkazy, inline tlačítka i tok "aktivní projekt".
import { getDb, projects, wishes } from "@farm/db";
import { eq } from "drizzle-orm";
import { projectMachine } from "@farm/core";
import { insertEvent } from "./db-helpers.js";
import type { ProjectRow } from "./db-helpers.js";

/** Titulek přání z první řádky textu (max 80 znaků). */
export function titleFromText(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? text.trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine || "Přání";
}

export interface ActionResult {
  ok: boolean;
  text: string;
}

/** Pauza/obnova projektu se state-machine kontrolou. Zapíše i event. */
export async function transitionProject(
  project: ProjectRow,
  to: "paused" | "active",
): Promise<ActionResult> {
  if (project.status === to) {
    return {
      ok: false,
      text: `Projekt „${project.name}“ už je ${to === "paused" ? "pozastavený" : "aktivní"}.`,
    };
  }
  if (!projectMachine.can(project.status, to)) {
    return {
      ok: false,
      text: `Nelze změnit stav projektu „${project.name}“ z „${project.status}“ na „${to}“.`,
    };
  }
  await getDb()
    .update(projects)
    .set({ status: to, updatedAt: new Date() })
    .where(eq(projects.id, project.id));
  await insertEvent({
    projectId: project.id,
    type: to === "paused" ? "project_paused" : "project_resumed",
    level: "info",
    message: `Projekt ${to === "paused" ? "pozastaven" : "obnoven"} přes Telegram.`,
    data: { from: project.status, to, via: "telegram" },
  });
  return {
    ok: true,
    text:
      to === "paused"
        ? `⏸️ Projekt „${project.name}“ pozastaven.`
        : `▶️ Projekt „${project.name}“ obnoven.`,
  };
}

/** Uloží poznámku manažerovi (steeruje never-ending refill smyčku). */
export async function saveManagerNote(project: ProjectRow, note: string): Promise<void> {
  await getDb()
    .update(projects)
    .set({ managerNote: note, updatedAt: new Date() })
    .where(eq(projects.id, project.id));
  await insertEvent({
    projectId: project.id,
    type: "manager_note",
    level: "info",
    message: "Poznámka manažerovi upravena přes Telegram.",
    data: { note, via: "telegram" },
  });
}

/**
 * Založí nové přání (wish) z textu. "Zpráva projektu" = INSERT wish,
 * kterou si vyzvedne manager smyčka. Vrací wishId (nebo undefined).
 */
export async function createTextWish(
  project: ProjectRow,
  text: string,
  source: "telegram" = "telegram",
): Promise<string | undefined> {
  const inserted = await getDb()
    .insert(wishes)
    .values({
      projectId: project.id,
      title: titleFromText(text),
      description: text,
      source,
      status: "new",
    })
    .returning({ id: wishes.id });
  const wishId = inserted[0]?.id;
  await insertEvent({
    projectId: project.id,
    wishId: wishId ?? null,
    type: "wish_created",
    level: "info",
    message: "Nové přání přes Telegram.",
    data: { source, via: "telegram" },
  });
  return wishId;
}
