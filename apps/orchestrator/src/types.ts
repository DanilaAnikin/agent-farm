/** Payloady zpráv v pgmq frontách. Sdílené mezi dispatch a judge. */
import type { TaskKind } from "@farm/db";

/** Zpráva ve frontě q_tasks — jeden úkol k provedení. */
export interface TaskMessage {
  taskId: string;
  projectId: string;
  wishId?: string | null;
  kind: TaskKind;
  /** true, pokud jde o opravu po předchozím rejectu (worker-fix agent). */
  isFix?: boolean;
  /** volitelná poznámka z retry-s-poznámkou (injektuje se do promptu). */
  note?: string;
  /** kolikrát byl task znovu zařazen kvůli INFRA chybě (bez penalizace); bound proti spinu. */
  infraRetries?: number;
}

/** Zpráva ve frontě q_judge — hotový pokus k posouzení. */
export interface JudgeMessage {
  attemptId: string;
  taskId: string;
  projectId: string;
  wishId?: string | null;
  branch: string;
  worktreeRef: string;
  /** Kolikrát už se judge opakoval kvůli dočasné chybě poskytovatele (402/429). */
  judgeRetries?: number;
}

/**
 * Zpráva ve frontě q_qa — přání připravené k finální end-to-end verifikaci
 * (Tester agent). Judge sem zařadí přání, když jsou všechny jeho tasky hotové.
 */
export interface QaMessage {
  projectId: string;
  wishId: string;
  /** volitelně poslední task, který přání dokončil (jen pro atribuci). */
  taskId?: string;
}
