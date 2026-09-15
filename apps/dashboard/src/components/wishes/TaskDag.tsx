import { StatusBadge } from "@/components/ui/Badge";
import { TASK_KIND_META, TASK_STATUS_META } from "@/lib/constants";
import type { TaskRow } from "@/lib/types";

// Task s DAG závislostmi. depends_on (jsonb pole UUID nadřazených úkolů, které musí
// být 'done') už TaskRow typuje; alias necháváme kvůli čitelnosti volajících.
export type DagTask = TaskRow;

interface Node {
  task: DagTask;
  deps: string[];
  level: number;
}

/**
 * Spočítá úroveň (vlnu) úkolu jako nejdelší cestu od kořene grafu závislostí.
 * Kořeny (bez závislostí) = úroveň 0. Odolné vůči cyklům a chybějícím id.
 */
function computeLevels(tasks: DagTask[]): Map<string, number> {
  const byId = new Map<string, DagTask>();
  for (const t of tasks) byId.set(t.id, t);

  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const level = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // ochrana proti cyklu
    const task = byId.get(id);
    if (!task) return 0;
    const deps = (task.depends_on ?? []).filter((d) => byId.has(d));
    if (deps.length === 0) {
      memo.set(id, 0);
      return 0;
    }
    visiting.add(id);
    let max = 0;
    for (const d of deps) max = Math.max(max, level(d) + 1);
    visiting.delete(id);
    memo.set(id, max);
    return max;
  };

  for (const t of tasks) level(t.id);
  return memo;
}

/**
 * TASK DAG — vykreslí úkoly seřazené podle jejich závislostí (kořeny první),
 * seskupené do vln. Ukazuje, že plán je skutečný graf závislostí, ne plochý
 * seznam. Odsazení + jemný náznak "závisí na: …".
 */
export function TaskDag({ tasks }: { tasks: DagTask[] }) {
  if (tasks.length === 0) {
    return <p className="text-sm text-(--color-muted)">Zatím žádné úkoly v plánu.</p>;
  }

  const levels = computeLevels(tasks);
  const titleById = new Map<string, string>();
  for (const t of tasks) titleById.set(t.id, t.title);

  const maxLevel = tasks.reduce((m, t) => Math.max(m, levels.get(t.id) ?? 0), 0);

  // Seskupení do vln a stabilní řazení uvnitř (priorita → čas vytvoření).
  const waves: DagTask[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const t of tasks) {
    const lvl = levels.get(t.id) ?? 0;
    waves[lvl]!.push(t);
  }
  for (const wave of waves) {
    wave.sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
  }

  return (
    <div className="space-y-5">
      {waves.map((wave, idx) => {
        if (wave.length === 0) return null;
        return (
          <div key={idx}>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-(--color-faint)">
                {/* Vlny se číslují od 1 včetně startu — dřív šla po „Start" rovnou „Vlna 2". */}
                {idx === 0 ? "Vlna 1 · bez závislostí" : `Vlna ${idx + 1}`}
              </span>
              <span className="h-px flex-1 bg-(--color-border)" />
            </div>
            <ul
              className="space-y-2"
              style={{ paddingLeft: `${Math.min(idx, 4) * 16}px` }}
            >
              {wave.map((task) => {
                const deps = (task.depends_on ?? []).filter((d) => titleById.has(d));
                return (
                  <li
                    key={task.id}
                    className="rounded-lg border border-(--color-border) bg-(--color-surface) p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        {idx > 0 ? (
                          <span className="shrink-0 text-(--color-faint)" aria-hidden>
                            └
                          </span>
                        ) : null}
                        <StatusBadge meta={TASK_KIND_META[task.kind]} />
                        <span className="truncate text-sm font-medium">{task.title}</span>
                      </div>
                      <StatusBadge meta={TASK_STATUS_META[task.status]} dot className="shrink-0" />
                    </div>
                    {task.done_condition ? (
                      <p className="mt-1.5 text-xs text-(--color-muted)">
                        <span className="text-(--color-faint)">Podmínka: </span>
                        {task.done_condition}
                      </p>
                    ) : null}
                    {deps.length > 0 ? (
                      <p className="mt-1.5 text-[11px] text-(--color-faint)">
                        závisí na: {deps.map((d) => titleById.get(d)).filter(Boolean).join(" · ")}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
