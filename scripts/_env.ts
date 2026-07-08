import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Načte .env z nejbližšího nadřazeného adresáře (bez závislosti na dotenv). */
export function loadDotenv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, ".env");
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && m[1] && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, "");
        }
      }
      return;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
}
