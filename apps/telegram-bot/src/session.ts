// In-memory stav konverzace per chat: aktivní projekt (/use) a čekání na poznámku.
// POZOR (durabilita): drženo jen v paměti — po restartu bota se ztratí.
// To je záměr: jde o krátkodobý UX stav, ne o data. Uživatel prostě znovu
// napíše /use nebo klikne na tlačítko.

export interface ActiveProject {
  id: string;
  name: string;
}

const activeProjects = new Map<number, ActiveProject>();
// chatId → projekt, jehož poznámku manažerovi právě píšeme (další text = poznámka)
const awaitingNote = new Map<number, ActiveProject>();

export function setActiveProject(chatId: number, project: ActiveProject): void {
  activeProjects.set(chatId, project);
}

export function getActiveProject(chatId: number): ActiveProject | undefined {
  return activeProjects.get(chatId);
}

export function clearActiveProject(chatId: number): void {
  activeProjects.delete(chatId);
}

export function setAwaitingNote(chatId: number, project: ActiveProject): void {
  awaitingNote.set(chatId, project);
}

/** Vrátí a zároveň smaže čekající poznámku (jednorázová konzumace). */
export function takeAwaitingNote(chatId: number): ActiveProject | undefined {
  const v = awaitingNote.get(chatId);
  if (v) awaitingNote.delete(chatId);
  return v;
}

/** Úklid při shutdownu. */
export function clearSessions(): void {
  activeProjects.clear();
  awaitingNote.clear();
}
