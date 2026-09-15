/**
 * Budget-hold loop (á 1 min): projekty v `budget_hold`, jejichž okno se resetovalo
 * (shouldAutoResume) a aktuální útrata je pod stropem → zpět na `active`.
 * Farma se tak nikdy trvale nezastaví — jen ji zdrží strop, který si uživatel nastavil.
 * Telegram notifikace jde přes zapsaný event.
 */
import { getDb, projects, events } from "@farm/db";
import { and, eq, gte } from "drizzle-orm";
import { projectMachine, shouldAutoResume, loadConfig } from "@farm/core";
import { admissionBlockedScope, guardAdmissionReserveUsd } from "./budget-deferral.js";
import { creditBalance } from "@farm/billing";
import { logEvent } from "./events.js";
import { spendSnapshot } from "./cost.js";
import { getCaps, isGlobalPaused } from "./settings.js";

/** Jedna iterace budget-hold loopu. */
export async function runBudgetHoldOnce(): Promise<void> {
  // Ruční pauza musí vydržet. Tahle smyčka jinak každou půlnoc vrátí do 'active'
  // i projekty, které pozastavil člověk — nerozlišuje totiž pauzu od
  // circuit-breakeru. Dokud je farma vypnutá vypínačem, neobnovuje se nic.
  if (await isGlobalPaused()) return;
  const now = new Date();
  const cfg = loadConfig();
  const held = await getDb().select().from(projects).where(eq(projects.status, "budget_hold"));

  for (const project of held) {
    try {
      // heldSince = kdy projekt přešel do budget_hold. Aproximujeme projects.updatedAt,
      // který se přes $onUpdate bumpne na přechodu active→budget_hold (dispatch/judge/
      // media-loop) — takže shouldAutoResume měří skutečnou dobu v holdu, ne stáří řádku.
      const heldSince = project.updatedAt ?? project.createdAt ?? now;
      if (!shouldAutoResume(heldSince, now)) continue;

      // Po resetu okna ověř, že útrata je opravdu pod DENNÍM stropem — a to se STEJNOU
      // branou, jakou drží dispatch (admissionBlockedScope: perAttempt nad všemi stropy
      // + rezervace hlídače nad stropy farmy). Bez shodné rezervy vzniká flapping pásmo:
      // budget-hold obnoví „bezpečný" projekt, dispatch ho hned zas re-holdne.
      const caps = await getCaps(project.userId, project.id);
      const spend = await spendSnapshot(project.userId, project.id);
      if (admissionBlockedScope(spend, caps, cfg.perAttemptBudgetUsd, guardAdmissionReserveUsd()) !== null) continue;

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

  // Circuit-breaker pauza (5 parked/den → paused) se stejně jako rozpočet resetuje
  // s denním oknem — jinak by autonomní farma po pár parkech stála až do ručního
  // zásahu. Obnovíme po resetu okna, ale JEN když je útrata pod stropem a kredity OK
  // (denní $ strop tak zůstává jediná tvrdá brzda; při trvalém selhávání se projekt
  // týž den zas zaparkuje — flapping je omezený denním capem).
  const paused = await getDb().select().from(projects).where(eq(projects.status, "paused"));
  for (const project of paused) {
    try {
      const pausedSince = project.updatedAt ?? project.createdAt ?? now;

      /*
        Obnovovat se smí JEN to, co pozastavil stroj.

        Stav `paused` znamená dvě různé věci: circuit breaker (judge.ts) a člověk,
        který projekt vypnul přes dashboard, Telegram nebo SQL. Tahle smyčka to
        dřív nerozlišovala a každou půlnoc pustila obojí — ruční pauza tedy do
        rána nevydržela a majitel to nemohl nijak poznat.

        Rozlišit to jde bez zásahu do schématu: circuit breaker po sobě nechává
        událost `project_paused_auto` zapsanou ve stejném okamžiku, kdy mění
        status. Když u pauzy taková událost není, pauzu udělal člověk — a ta
        skončí, až ji zruší člověk.
      */
      const autoPause = await getDb()
        .select({ id: events.id, data: events.data })
        .from(events)
        .where(
          and(
            eq(events.projectId, project.id),
            eq(events.type, "project_paused_auto"),
            gte(events.ts, new Date(pausedSince.getTime() - 2 * 60_000)),
          ),
        )
        .limit(1);
      if (autoPause.length === 0) continue;
      // Circuit breaker zapisuje `resumeAt` (časová pauza, výchozí 6 h). Starší
      // události ho nemají → původní chování: obnovit po resetu denního okna.
      const resumeAt = Date.parse(String((autoPause[0]?.data as { resumeAt?: unknown } | null)?.resumeAt ?? ""));
      if (Number.isFinite(resumeAt) ? now.getTime() < resumeAt : !shouldAutoResume(pausedSince, now)) continue;
      const caps = await getCaps(project.userId, project.id);
      const spend = await spendSnapshot(project.userId, project.id);
      if (admissionBlockedScope(spend, caps, cfg.perAttemptBudgetUsd, guardAdmissionReserveUsd()) !== null) continue;
      const credit = await creditBalance(project.userId);
      if (!credit.ok) continue;

      projectMachine.assert("paused", "active");
      await getDb().update(projects).set({ status: "active" }).where(eq(projects.id, project.id));
      await logEvent({
        projectId: project.id,
        type: "circuit_breaker_resumed",
        message: "Circuit-breaker okno se resetovalo — projekt automaticky obnoven.",
      });
    } catch (err) {
      console.error(`[budget-hold] obnovení pauznutého projektu ${project.id} selhalo:`, err);
    }
  }
}
