/**
 * Budget-hold loop (á 1 min): projekty v `budget_hold`, jejichž okno se resetovalo
 * (shouldAutoResume) a aktuální útrata je pod stropem → zpět na `active`.
 * Farma se tak nikdy trvale nezastaví — jen ji zdrží strop, který si uživatel nastavil.
 * Telegram notifikace jde přes zapsaný event.
 */
import { getDb, projects } from "@farm/db";
import { eq } from "drizzle-orm";
import { projectMachine, shouldAutoResume, checkBudget } from "@farm/core";
import { creditBalance } from "@farm/billing";
import { logEvent } from "./events.js";
import { spendSnapshot } from "./cost.js";
import { getCaps } from "./settings.js";

/** Jedna iterace budget-hold loopu. */
export async function runBudgetHoldOnce(): Promise<void> {
  const now = new Date();
  const held = await getDb().select().from(projects).where(eq(projects.status, "budget_hold"));

  for (const project of held) {
    try {
      // heldSince aproximujeme updatedAt (kdy projekt přešel do budget_hold).
      const heldSince = project.updatedAt ?? project.createdAt ?? now;
      if (!shouldAutoResume(heldSince, now)) continue;

      // Po resetu okna ještě ověř, že útrata je opravdu pod DENNÍM stropem.
      const caps = await getCaps(project.userId, project.id);
      const spend = await spendSnapshot(project.userId, project.id);
      if (checkBudget(spend, caps) !== null) continue;

      // A KRITICKY: pokud jsou vyčerpané MĚSÍČNÍ kredity (out_of_credits), NEobnovuj —
      // denní okno se resetuje každý den, ale kredity až s měsícem. Bez téhle brány
      // by se projekt každý den obnovil a hned zase zablokoval (flapping + spam).
      const credit = await creditBalance(project.userId);
      if (!credit.ok) continue;

      projectMachine.assert("budget_hold", "active");
      await getDb().update(projects).set({ status: "active" }).where(eq(projects.id, project.id));
      await logEvent({
        projectId: project.id,
        type: "budget_hold_resumed",
        message: "Rozpočtové okno se resetovalo — projekt automaticky obnoven.",
      });
    } catch (err) {
      console.error(`[budget-hold] obnovení projektu ${project.id} selhalo:`, err);
    }
  }
}
