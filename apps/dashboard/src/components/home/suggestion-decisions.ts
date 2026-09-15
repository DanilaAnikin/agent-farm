/**
 * „Co farma sama zadala" — lidský popis rozhodnutí intake o návrzích.
 *
 * Proč: sekce „Návrhy farmy" byla schvalovací fronta s tlačítky Přijmout/Zahodit
 * a odznakem „12 návrhů", který ukazoval strop dotazu (v DB jich bylo 96). Farma
 * je ale autonomní — návrhy sama zadává nebo zahazuje a člověk má vidět, CO
 * rozhodla a PROČ, ne klikat.
 *
 * `suggestions.decided_reason` zapisuje orchestrátor. Tvar: kód, volitelně
 * `:` a doplněk, např. `duplicate:<uuid původního přání>` nebo
 * `not_in_repo: chybí Next.js`. Neznámý kód se nerozbije, jen se ukáže obecně.
 *
 * Bez `@/` importů — testuje se přes `tsx --test`.
 */
import { plural } from "../../lib/plural";

export type DecisionKind =
  | "converted"
  | "duplicate"
  | "project_paused"
  | "not_in_repo"
  | "cross_project"
  | "stale"
  | "owner_dismissed"
  | "accepted"
  | "dismissed_other";

export interface Decision {
  kind: DecisionKind;
  /** Zadáno do projektu (přání existuje) vs. zahozeno. */
  outcome: "assigned" | "dropped";
  label: string;
  /** Id původního přání u duplicity (když ho orchestrátor zapsal). */
  refWishId: string | null;
  /** Volný doplněk důvodu. */
  detail: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALIASY: Record<string, DecisionKind> = {
  converted: "converted",
  duplicate: "duplicate",
  duplicate_of: "duplicate",
  dup: "duplicate",
  project_paused: "project_paused",
  paused: "project_paused",
  not_in_repo: "not_in_repo",
  ungrounded: "not_in_repo",
  not_grounded: "not_in_repo",
  unsupported: "not_in_repo",
  cross_project: "cross_project",
  no_project: "cross_project",
  stale: "stale",
  outdated: "stale",
  owner_dismissed: "owner_dismissed",
};

export function parseDecision(status: string, reason: string | null): Decision {
  const raw = (reason ?? "").trim();
  const dvojtecka = raw.indexOf(":");
  const kod = (dvojtecka >= 0 ? raw.slice(0, dvojtecka) : raw).trim().toLowerCase();
  const doplnek = dvojtecka >= 0 ? raw.slice(dvojtecka + 1).trim() : "";
  const refWishId = UUID.test(doplnek) ? doplnek : null;
  const detail = doplnek && !refWishId ? doplnek : null;

  if (status === "converted") {
    return { kind: "converted", outcome: "assigned", label: "Zadáno → přání", refWishId: null, detail };
  }
  if (status === "accepted") {
    return {
      kind: "accepted",
      outcome: "assigned",
      label: "Přijato (bez cílového projektu)",
      refWishId: null,
      detail,
    };
  }

  const kind: DecisionKind = ALIASY[kod] ?? "dismissed_other";
  const label: Record<DecisionKind, string> = {
    converted: "Zadáno → přání",
    accepted: "Přijato",
    duplicate: "Zahozeno: duplicita",
    project_paused: "Zahozeno: projekt je pozastavený",
    not_in_repo: "Zahozeno: nepodložené repozitářem",
    cross_project: "Zahozeno: napříč projekty",
    stale: "Zahozeno: zastaralé",
    owner_dismissed: "Zahozeno majitelem",
    dismissed_other: "Zahozeno",
  };
  return { kind, outcome: "dropped", label: label[kind], refWishId, detail };
}

export interface DecisionCounts {
  assigned: number;
  dropped: number;
  duplicate: number;
  notInRepo: number;
  projectPaused: number;
  crossProject: number;
}

const ZADANO = ["zadáno", "zadána", "zadáno"] as const;
const ZAHOZENO = ["zahozeno", "zahozena", "zahozeno"] as const;
const DUPLICIT = ["duplicita", "duplicity", "duplicit"] as const;

/** „2 zadána · 31 zahozeno (25 duplicit, 6 mimo repo)". */
export function decisionSummary(c: DecisionCounts): string {
  const casti = [`${c.assigned} ${plural(c.assigned, ZADANO)}`, `${c.dropped} ${plural(c.dropped, ZAHOZENO)}`];
  const proc: string[] = [];
  if (c.duplicate > 0) proc.push(`${c.duplicate} ${plural(c.duplicate, DUPLICIT)}`);
  if (c.notInRepo > 0) proc.push(`${c.notInRepo} mimo repo`);
  if (c.projectPaused > 0) proc.push(`${c.projectPaused} u pozastavených projektů`);
  if (c.crossProject > 0) proc.push(`${c.crossProject} napříč projekty`);
  return proc.length > 0 && c.dropped > 0 ? `${casti.join(" · ")} (${proc.join(", ")})` : casti.join(" · ");
}
