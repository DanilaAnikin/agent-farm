-- =============================================================================
-- Swarm — skutečná paralelizace: fronta pro serializovaný merge (merge queue),
-- best-of-N kandidáti na úkol. Paralelní dispatch neběží přes schéma (řídí ho
-- orchestrátor concurrency limitem), merge se serializuje přes q_merge + rebase.
-- Idempotentní.
-- =============================================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS best_of_n integer NOT NULL DEFAULT 1;

ALTER TABLE public.attempts
  ADD COLUMN IF NOT EXISTS candidate_idx integer NOT NULL DEFAULT 0;
ALTER TABLE public.attempts
  ADD COLUMN IF NOT EXISTS score double precision;
ALTER TABLE public.attempts
  ADD COLUMN IF NOT EXISTS is_winner boolean NOT NULL DEFAULT false;

-- Merge fronta (serializuje slévání větví do main; stavba běží paralelně).
SELECT pgmq.create('q_merge');
