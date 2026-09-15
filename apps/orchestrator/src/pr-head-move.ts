/**
 * Posun hlavy PR od commitu, který posoudil soudce — smí se sloučit bez nového
 * posouzení?
 *
 * Proč zvlášť a proč takhle: dřívější kontrola porovnávala `posouzená hlava →
 * nová hlava` a chtěla, aby KAŽDÝ commit v rozdílu měl víc rodičů. Jenže
 * update-branch do větve přinese i všechny commity z hlavní větve a ty mají
 * většinou jednoho rodiče (squash merge, přímé commity). Kontrola tedy po
 * každém update-branch selhala, schválená práce se vracela workerovi „k opravě"
 * s prázdným diffem a po třech kolech se zaparkovala. A naopak: merge commit
 * z libovolné cizí větve (nebo ruční řešení konfliktu s vlastními změnami)
 * by prošel jako „update-branch".
 *
 * Teď se ověřuje to, na čem skutečně záleží:
 *  1. nová hlava navazuje na posouzenou (žádné přepsání historie),
 *  2. commity, které přibyly VE VĚTVI PR (nejsou v hlavní větvi ani v posouzené
 *     hlavě), jsou jen merge commity a aspoň jeden jejich rodič leží v hlavní větvi,
 *  3. výsledný diff PR proti hlavní větvi je po souborech stejný jako posouzený
 *     (stejné přidané a odebrané řádky) — sloučí se tedy přesně posouzená změna.
 *
 * Čistá funkce bez I/O — podklady (GitHub compare) sbírá delivery.ts.
 */

export interface HeadMoveCommit {
  sha: string;
  parents: string[];
}

export interface HeadMoveFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Blob SHA souboru v hlavě; stejný blob = stejný obsah. */
  sha?: string | null;
  /** GitHub u velkých a binárních souborů patch nevrací. */
  patch?: string | null;
}

/** Výsledek GitHub compare `base...head` (tři tečky = od společného předka). */
export interface HeadMoveCompare {
  commits: HeadMoveCommit[];
  totalCommits: number;
  files: HeadMoveFile[];
}

export interface HeadMoveInput {
  /** Status compare `posouzená hlava...nová hlava` (ahead | identical | behind | diverged). */
  sinceJudgedStatus: string;
  /** compare `hlavní větev...posouzená hlava` — posouzené commity a diff. */
  judged: HeadMoveCompare;
  /** compare `hlavní větev...nová hlava` — aktuální commity větve a diff. */
  current: HeadMoveCompare;
}

export type HeadMoveVerdict = { safe: true } | { safe: false; reason: string };

/** GitHub compare vrací nejvýš 300 souborů; víc = neúplný diff. */
export const COMPARE_MAX_FILES = 300;

/** Přidané a odebrané řádky patche bez hlaviček hunků a kontextu. */
export function changedPatchLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---")));
}

function stejnySoubor(a: HeadMoveFile, b: HeadMoveFile): boolean {
  if (a.status !== b.status || a.additions !== b.additions || a.deletions !== b.deletions) return false;
  // Stejný blob = stejný obsah, na kontextu diffu nezáleží.
  if (a.sha && b.sha && a.sha === b.sha) return true;
  // Bez patche nejde změněné řádky porovnat — radši ne.
  if (typeof a.patch !== "string" || typeof b.patch !== "string") return false;
  const ra = changedPatchLines(a.patch);
  const rb = changedPatchLines(b.patch);
  return ra.length === rb.length && ra.every((l, i) => l === rb[i]);
}

export function judgeHeadMove(input: HeadMoveInput): HeadMoveVerdict {
  if (input.sinceJudgedStatus === "identical") return { safe: true };
  if (input.sinceJudgedStatus !== "ahead") {
    return { safe: false, reason: "hlava PR nenavazuje na posouzený commit (historie větve se přepsala)" };
  }

  const { judged, current } = input;
  if (
    judged.commits.length < judged.totalCommits ||
    current.commits.length < current.totalCommits ||
    judged.files.length >= COMPARE_MAX_FILES ||
    current.files.length >= COMPARE_MAX_FILES
  ) {
    return { safe: false, reason: "rozdíl je příliš velký na to, aby šel posun hlavy ověřit" };
  }

  // Commity větve PR (dosažitelné z nové hlavy, ne z hlavní větve). Rodič, který
  // v téhle množině NENÍ, je nutně v hlavní větvi.
  const vetev = new Set(current.commits.map((c) => c.sha));
  const posouzene = new Set(judged.commits.map((c) => c.sha));
  const nove = current.commits.filter((c) => !posouzene.has(c.sha));
  for (const c of nove) {
    if (c.parents.length < 2) {
      return { safe: false, reason: `commit ${c.sha.slice(0, 7)} není sloučení z hlavní větve` };
    }
    if (!c.parents.some((p) => !vetev.has(p))) {
      return { safe: false, reason: `merge commit ${c.sha.slice(0, 7)} nepřináší hlavní větev, ale jinou větev` };
    }
  }

  // Výsledná změna proti hlavní větvi musí být ta posouzená.
  const puvodni = new Map(judged.files.map((f) => [f.filename, f] as const));
  if (puvodni.size !== current.files.length) {
    return { safe: false, reason: "posun hlavy změnil seznam souborů v PR" };
  }
  for (const f of current.files) {
    const p = puvodni.get(f.filename);
    if (!p || !stejnySoubor(p, f)) {
      return { safe: false, reason: `posun hlavy změnil obsah souboru ${f.filename}` };
    }
  }
  return { safe: true };
}
