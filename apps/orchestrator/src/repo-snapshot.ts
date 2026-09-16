/**
 * Snapshot repozitáře pro průzkum spouštění (project-discovery.ts).
 *
 * Čte se JEN to, co rozhoduje o tom, jak se projekt instaluje a spouští: cesty
 * souborů a obsah malých manifestů (package.json, lockfile jen velikostí, CI
 * workflow, compose, Makefile, pyproject/go.mod/Cargo.toml, .env.example, README).
 *
 * Nikdy se nečte `.env` (to je tajemství, ne manifest), symlinky se přeskakují a
 * velké soubory se jen změří. Žádné spouštění kódu — tenhle krok je zadarmo.
 *
 * Pořadí průchodu je SOUČÁST KONTRAKTU: jde se do šířky (po úrovních) a manifesty
 * se sbírají bez ohledu na strop cest. Dřív se sestupovalo do hloubky v pořadí,
 * v jakém cesty vrátil `readdir` (tedy podle FS, ne podle abecedy), takže stačil
 * jeden adresář s 1500 soubory a strop se vyčerpal dřív, než se vůbec došlo na
 * kořenový package.json: otisk manifestů vyšel `null`, `decideDiscovery` vrátil
 * „no_facts" a projekt se nikdy nezkoumal — bez jediného záznamu.
 */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { isLockfilePath, isRecipeManifestPath } from "@farm/core";
import type { RepoSnapshot } from "@farm/core";

/** Strop na počet zaznamenaných OSTATNÍCH cest (velká repa nesmí smyčku utopit). */
export const MAX_SNAPSHOT_PATHS = 1200;
/** Strop na manifesty a README — ty se sbírají mimo strop výše, ale ne donekonečna. */
export const MAX_MANIFEST_PATHS = 400;
/** Větší „manifest" se nečte, jen změří — do otisku stačí velikost. */
export const MAX_MANIFEST_BYTES = 65_536;
/** Do jaké hloubky se jde (0 = kořen). */
const MAX_DEPTH = 3;

const SKIP_DIRS = new Set([
  ".git", ".farm", ".opencode", "node_modules", "dist", "build", ".next", ".turbo", ".venv", "venv",
  "__pycache__", "target", "vendor", "coverage", ".cache", ".pnpm-store", "tmp",
]);

const README = /^(README\.md|readme\.md|README)$/;

/** Je tahle cesta to, z čeho se recept odvozuje (a co tedy strop nesmí useknout)? */
function isRecipeInput(path: string): boolean {
  return isRecipeManifestPath(path) || README.test(path);
}

export async function collectRepoSnapshot(root: string): Promise<RepoSnapshot> {
  const manifestPaths: string[] = [];
  const otherPaths: string[] = [];
  let truncated = false;

  // Průchod do ŠÍŘKY: celý kořen (a tedy i package.json, lockfile, .github/…)
  // je zpracovaný dřív, než se sestoupí o úroveň níž.
  let level: { dir: string; rel: string }[] = [{ dir: root, rel: "" }];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: { dir: string; rel: string }[] = [];
    for (const { dir, rel } of level) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (depth < MAX_DEPTH) next.push({ dir: join(dir, entry.name), rel: childRel });
          continue;
        }
        if (!entry.isFile()) continue;
        if (isRecipeInput(childRel)) {
          if (manifestPaths.length < MAX_MANIFEST_PATHS) manifestPaths.push(childRel);
          else truncated = true;
        } else if (otherPaths.length < MAX_SNAPSHOT_PATHS) {
          otherPaths.push(childRel);
        } else {
          truncated = true;
        }
      }
    }
    level = next;
  }

  const paths = [...manifestPaths, ...otherPaths];
  const files: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  for (const path of manifestPaths) {
    try {
      const stat = await fs.lstat(join(root, path));
      if (!stat.isFile()) continue;
      if (isLockfilePath(path) || stat.size > MAX_MANIFEST_BYTES) {
        sizes[path] = stat.size;
        continue;
      }
      files[path] = await fs.readFile(join(root, path), "utf8");
    } catch {
      /* nečitelný manifest = neznámý, ne chyba */
    }
  }
  return { paths, files, sizes, ...(truncated ? { truncated: true } : {}) };
}
