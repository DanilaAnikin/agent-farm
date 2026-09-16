/**
 * Snapshot repozitáře pro průzkum spouštění (project-discovery.ts).
 *
 * Čte se JEN to, co rozhoduje o tom, jak se projekt instaluje a spouští: cesty
 * souborů a obsah malých manifestů (package.json, lockfile jen velikostí, CI
 * workflow, compose, Makefile, pyproject/go.mod/Cargo.toml, .env.example, README).
 *
 * Nikdy se nečte `.env` (to je tajemství, ne manifest), symlinky se přeskakují a
 * velké soubory se jen změří. Žádné spouštění kódu — tenhle krok je zadarmo.
 */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { isLockfilePath, isRecipeManifestPath } from "@farm/core";
import type { RepoSnapshot } from "@farm/core";

/** Strop na počet zaznamenaných cest (velká repa nesmí smyčku utopit). */
export const MAX_SNAPSHOT_PATHS = 1200;
/** Větší „manifest" se nečte, jen změří — do otisku stačí velikost. */
export const MAX_MANIFEST_BYTES = 65_536;

const SKIP_DIRS = new Set([
  ".git", ".farm", ".opencode", "node_modules", "dist", "build", ".next", ".turbo", ".venv", "venv",
  "__pycache__", "target", "vendor", "coverage", ".cache", ".pnpm-store", "tmp",
]);

const README = /^(README\.md|readme\.md|README)$/;

export async function collectRepoSnapshot(root: string): Promise<RepoSnapshot> {
  const paths: string[] = [];

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (paths.length >= MAX_SNAPSHOT_PATHS || depth > 3) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (paths.length >= MAX_SNAPSHOT_PATHS) return;
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name), childRel, depth + 1);
      } else if (entry.isFile()) {
        paths.push(childRel);
      }
    }
  }

  await walk(root, "", 0);

  const files: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  for (const path of paths) {
    if (!isRecipeManifestPath(path) && !README.test(path)) continue;
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
  return { paths, files, sizes };
}
