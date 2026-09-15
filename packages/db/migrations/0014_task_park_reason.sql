-- =============================================================================
-- DŮVOD ZAPARKOVÁNÍ ÚKOLU.
--
-- Dnes je 224 úkolů ve stavu `parked` a 201 z nich je jen HISTORICKÁ FRONTA
-- hromadně archivovaná událostí `backlog_task_archived`. Dashboard je ale
-- nedokáže odlišit od skutečné poruchy, takže panel pozornosti hlásil dvě stě
-- „incidentů", které žádné incidenty nejsou, a postup projektu vycházel
-- katastrofálně (procento se počítalo i z archivu).
--
-- Množina hodnot (vynucuje aplikace, ne DB — viz poznámka v enums.ts):
--   archived | qa_false_fix | judge_exhausted | dependency_cascade |
--   empty_diff | infra | judging_orphan | owner_cancelled | unknown
--
-- Idempotentní: sloupce IF NOT EXISTS, backfill jen tam, kde je park_reason
-- NULL — opakovaný běh už nic nepřepíše.
-- =============================================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS park_reason text,
  ADD COLUMN IF NOT EXISTS parked_at timestamptz;

CREATE INDEX IF NOT EXISTS tasks_park_reason_idx ON public.tasks(project_id, park_reason);

-- Backfill 1: co bylo hromadně archivováno, dostane 'archived' a čas z události.
UPDATE public.tasks t
SET park_reason = 'archived',
    parked_at = COALESCE(t.parked_at, e.ts)
FROM (
  SELECT DISTINCT ON (task_id) task_id, ts
  FROM public.events
  WHERE type = 'backlog_task_archived'
  ORDER BY task_id, ts DESC
) e
WHERE e.task_id = t.id
  AND t.status = 'parked'
  AND t.park_reason IS NULL;

-- Backfill 2: zbylé zaparkované úkoly bez dohledatelného důvodu. 'unknown' je
-- poctivější než 'archived' — UI je pak ukáže jako „důvod neznámý", ne jako
-- archiv, který se smí schovat.
UPDATE public.tasks t
SET park_reason = 'unknown',
    parked_at = COALESCE(t.parked_at, t.updated_at)
WHERE t.status = 'parked'
  AND t.park_reason IS NULL;
