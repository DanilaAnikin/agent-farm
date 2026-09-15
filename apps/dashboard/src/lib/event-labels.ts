/**
 * České popisky událostí.
 *
 * Řeka aktivity dosud vypisovala syrové `type` z databáze, takže se člověk díval
 * na „best_of_n_lost_ownership" a „reconciliation_requeue_queued". Ještě horší
 * byl poměr: 37 648 událostí `dispatch_error` a 33 179 `task_deps_pending`
 * přebilo úplně všechno, co se ve farmě doopravdy stalo.
 *
 * `importance` je proto stejně důležité jako `label`:
 *   'noise'     — provozní šum, výchozím filtrem se skrývá (nebo slučuje),
 *   'normal'    — běžný průběh práce,
 *   'important' — to, co člověk chce vidět (hotovo, sloučeno, zaparkováno, chyba).
 *
 * Bez `@/` importů a bez runtime závislostí — čitelné i z testu.
 */

export type EventTone = "ok" | "warn" | "danger" | "info" | "neutral" | "violet";
export type EventImportance = "noise" | "normal" | "important";

export interface EventMeta {
  label: string;
  tone: EventTone;
  importance: EventImportance;
}

const N = (label: string, tone: EventTone = "neutral"): EventMeta => ({
  label,
  tone,
  importance: "noise",
});
const B = (label: string, tone: EventTone = "info"): EventMeta => ({
  label,
  tone,
  importance: "normal",
});
const D = (label: string, tone: EventTone = "info"): EventMeta => ({
  label,
  tone,
  importance: "important",
});

export const EVENT_META: Record<string, EventMeta> = {
  // --- běh orchestrátoru ----------------------------------------------------
  orchestrator_start: D("Orchestrátor nastartoval", "ok"),
  orchestrator_stop: D("Orchestrátor skončil", "warn"),
  farm_maintenance: B("Údržba farmy", "neutral"),
  farm_resumed: D("Farma znovu spuštěna", "ok"),
  farm_guard_not_ready: D("Rozpočtový hlídač není připraven", "danger"),
  global_pause: D("Farma pozastavena", "warn"),

  // --- dispatch a pokusy ----------------------------------------------------
  attempt_started: B("Pokus začal"),
  attempt_finished: B("Pokus dokončen", "ok"),
  attempt_error: B("Chyba pokusu", "danger"),
  attempt_aborted: B("Pokus přerušen", "warn"),
  attempt_setup_timeout: B("Příprava pokusu vypršela", "warn"),
  attempt_budget_deferred: B("Pokus odložen kvůli rozpočtu", "warn"),
  dispatch_error: N("Nepodařilo se spustit práci", "danger"),
  worker_cap_reached: N("Vyčerpána kapacita vývojářů"),
  orphan_container_killed: N("Uklizen osiřelý kontejner"),
  task_deps_pending: N("Úkol čeká na závislosti"),
  reconciliation_requeue: N("Úkol vrácen do fronty"),
  reconciliation_requeue_queued: N("Úkol vrácen do fronty"),
  reconciliation_requeue_running: N("Běžící úkol vrácen do fronty"),
  reconciliation_requeue_judging: N("Posuzovaný úkol vrácen do fronty"),

  // --- best-of-N ------------------------------------------------------------
  best_of_n_started: N("Souboj řešení začal", "violet"),
  best_of_n_candidate: N("Kandidát na řešení", "violet"),
  best_of_n_winner: B("Vybráno nejlepší řešení", "ok"),
  best_of_n_no_winner: B("Žádné řešení neobstálo", "warn"),
  best_of_n_aborted: N("Souboj řešení přerušen", "warn"),
  best_of_n_budget_stop: B("Souboj řešení zastavil rozpočet", "warn"),
  best_of_n_lost_ownership: N("Souboj řešení ztratil vlastnictví úkolu", "warn"),

  // --- soudce a testy -------------------------------------------------------
  judge_error: B("Chyba soudce", "danger"),
  judge_empty_diff: B("Soudce nenašel žádnou změnu", "warn"),
  judge_diff_unavailable: B("Změnu se nepodařilo spočítat", "warn"),
  judge_retry_transient: N("Soudce to zkouší znovu"),
  judge_budget_deferred: B("Posouzení odloženo kvůli rozpočtu", "warn"),
  judge_harness_broken: D("Kontroly projektu jsou rozbité", "danger"),
  judge_harness_run_broken: B("Kontroly projektu se nepodařilo spustit", "danger"),
  judge_harness_ok: N("Kontroly projektu fungují", "ok"),
  qa_retry_scheduled: B("Testování se zopakuje později", "warn"),
  qa_started: B("Testování začalo"),
  qa_enqueued: N("Testování zařazeno"),
  qa_passed: D("Testy prošly", "ok"),
  qa_failed: D("Testy neprošly", "danger"),
  qa_error: B("Chyba testování", "danger"),
  qa_fix_tasks: B("Z testů vznikly opravné úkoly", "warn"),
  qa_artifact_selected: N("Vybrán výstup testu"),
  qa_false_fix_archived: B("Neplatná oprava archivována", "warn"),
  qa_failed_invalidated: B("Neplatný výsledek testu zrušen", "warn"),

  // --- doručení -------------------------------------------------------------
  pr_opened: D("Otevřen pull request", "violet"),
  pr_merged: D("Pull request sloučen", "ok"),
  pr_merge_blocked: D("Sloučení zablokováno", "warn"),
  pr_open_failed: D("Pull request se nepodařilo otevřít", "danger"),
  pr_branch_updated: N("Větev pull requestu dorovnána s main"),
  task_merging: B("Úkol čeká na sloučení", "violet"),
  task_merge_fix: B("Oprava před sloučením", "warn"),
  delivery_paused_owner: B("Slučování drží vypínač majitele", "warn"),
  merge_conflict: D("Konflikt při slučování", "danger"),
  deploy_preview_enqueued: B("Náhled nasazení zařazen"),
  deploy_running: B("Nasazuje se"),
  deploy_done: D("Nasazeno", "ok"),
  deploy_failed: D("Nasazení selhalo", "danger"),
  auto_deliver: B("Automatické doručení"),
  auto_deliver_pending: B("Doručení čeká", "warn"),
  auto_deliver_deferred: B("Doručení odloženo do resetu limitu", "warn"),

  // --- úkoly ----------------------------------------------------------------
  tasks_planned: D("Naplánovány úkoly", "ok"),
  task_done: D("Úkol hotový", "ok"),
  task_retry: B("Úkol se zkouší znovu", "warn"),
  task_unblocked: B("Úkol odblokován"),
  task_parked: D("Úkol zaparkován", "warn"),
  task_parked_infra: B("Úkol zaparkován kvůli infrastruktuře", "warn"),
  task_parked_attempt_allowance: B("Úkol zaparkován — na jeden pokus příliš velký", "warn"),
  task_parked_empty_diff: B("Úkol zaparkován — žádná změna", "warn"),
  task_cancelled: B("Úkol zrušen", "neutral"),
  task_cancelled_bad_premise: B("Úkol zrušen — chybné zadání", "warn"),
  task_invalid_greenfield: B("Úkol neplatný pro nový projekt", "warn"),
  task_title_language: N("Název úkolu není česky"),
  backlog_task_archived: N("Úkol archivován (historická fronta)"),
  backlog_wish_archived: N("Přání archivováno (historická fronta)"),
  backlog_normalized: B("Fronta srovnána"),
  backlog_normalization_complete: B("Srovnání fronty dokončeno", "ok"),
  backlog_pilot_revised: B("Pilotní fronta přepracována"),

  // --- přání a specifikace --------------------------------------------------
  wish_created: D("Nové přání", "info"),
  wish_activated: D("Přání spuštěno", "ok"),
  wish_activated_trust: D("Přání spuštěno automaticky", "ok"),
  wish_progress: B("Postup přání"),
  wish_done: D("Přání splněno", "ok"),
  wish_parked: D("Přání zaparkováno", "warn"),
  wish_auto_archived: D("Přání uzavřeno farmou", "warn"),
  wish_replanned: B("Přání přeplánováno", "warn"),
  wish_respec_attempt: B("Nová specifikace uvázlého přání", "warn"),
  spec: B("Specifikace"),
  spec_awaiting_approval: B("Specifikace čeká na schválení", "warn"),
  spec_failed: B("Specifikace selhala", "danger"),
  spec_rejected: B("Specifikace zamítnuta", "warn"),
  spec_stuck: D("Specifikace uvízla", "danger"),
  plan_failed: B("Plánování selhalo", "danger"),
  plan_stuck: D("Plánování uvízlo", "danger"),
  dag_no_root: B("Plán nemá kde začít", "danger"),
  criteria_uncovered: B("Nepokrytá akceptační kritéria", "warn"),
  assumptions_made: N("Agent si domyslel předpoklady"),

  // --- mozek projektu -------------------------------------------------------
  architecture_ready: B("Architektura připravena", "ok"),
  architect_dedup: N("Architekt zahodil duplicitu"),
  architect_fallback: N("Architekt použil náhradní postup", "warn"),
  architect_self_revised: N("Architekt se sám opravil"),
  reflection_recorded: B("Zaznamenáno poučení"),
  success_learned: B("Zaznamenán úspěšný postup", "ok"),
  manager_note: B("Poznámka manažera"),

  // --- návrhy a autonomie ---------------------------------------------------
  suggestion_new: B("Nový návrh", "violet"),
  suggestions_generated: B("Farma vymyslela návrhy", "violet"),
  suggestion_converted: D("Farma sama zadala práci", "ok"),
  suggestion_dismissed: B("Návrh zahozen", "neutral"),
  self_run: B("Samostatné kolo farmy"),
  farm_supervisor: B("Dohled nad farmou"),
  refill_round: N("Doplňování práce"),
  refill_done: B("Práce doplněna", "ok"),
  refill_dedup: N("Doplňování zahodilo duplicitu"),

  // --- rozpočet a projekty --------------------------------------------------
  budget_changed: D("Změna rozpočtu", "warn"),
  budget_hold: D("Projekt čeká na rozpočet", "warn"),
  budget_hold_resumed: D("Projekt znovu spuštěn po rozpočtu", "ok"),
  budget_rejected: N("Rozpočtová brána odmítla požadavky", "warn"),
  out_of_credits: D("Došel kredit u poskytovatele", "danger"),
  project_paused_auto: D("Projekt automaticky pozastaven", "warn"),
  project_rollout_activated: D("Projekt zapnut po postupném náběhu", "ok"),
  circuit_breaker: D("Projekt dočasně zastaven po sérii chyb", "danger"),
  circuit_breaker_resumed: D("Projekt znovu spuštěn", "ok"),

  // --- média a publikace ----------------------------------------------------
  media_error: B("Chyba generování médií", "danger"),
  publish: B("Publikace"),
  stt_done: N("Přepis hlasu hotový"),
  stt_error: B("Přepis hlasu selhal", "danger"),
  stt_unconfigured: B("Přepis hlasu není nastavený", "warn"),
  voice_wish: D("Přání nadiktované hlasem", "violet"),
};

/** Typy, které se výchozím filtrem schovávají nebo slučují do jednoho řádku. */
export const NOISE_EVENT_TYPES: string[] = Object.entries(EVENT_META)
  .filter(([, meta]) => meta.importance === "noise")
  .map(([type]) => type);

const NOISE_SET = new Set(NOISE_EVENT_TYPES);

export function isNoiseEvent(type: string): boolean {
  return NOISE_SET.has(type);
}

/**
 * Čitelný fallback pro typ, který tady ještě není: „nejaka_nova_udalost" →
 * „Nějaká nová událost" nedostaneme, ale „Nejaka nova udalost" je pořád lepší
 * než syrový snake_case — a hlavně se tím nic nerozbije, když orchestrátor
 * zavede nový typ dřív, než ho sem někdo dopíše.
 */
export function eventLabel(type: string): string {
  const meta = EVENT_META[type];
  if (meta) return meta.label;
  if (!type) return "Neznámá událost";
  const slova = type.replace(/_/g, " ").trim();
  return slova.charAt(0).toUpperCase() + slova.slice(1);
}

export function eventMeta(type: string): EventMeta {
  return EVENT_META[type] ?? { label: eventLabel(type), tone: "neutral", importance: "normal" };
}
