import { promises as fs } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { TesterPlanOutput } from "@farm/llm";

type Scenario = TesterPlanOutput["scenarios"][number];
interface Criterion { id: string; description: string; check?: string; verifyMethod?: unknown; }
interface Task { id: string; title: string; description?: string; doneCondition: string; }
interface PackageInfo { directory: string; name?: string; scripts: Set<string>; tools: Set<string>; }
export interface GroundedQaCommands {
  scenarios: Scenario[];
  complete: boolean;
  promptContext: string;
}

export class QaCommandGroundingError extends Error {
  constructor(command: string) {
    super(`Explicit QA verification is unavailable in the selected artifact: ${command}`);
    this.name = "QaCommandGroundingError";
  }
}

const SKIP = new Set([".git", ".farm", ".next", ".opencode", "node_modules", "dist", "build", "coverage"]);
const VERIFY_SCRIPT = /^(?:test|typecheck|lint|build|check|verify)(?:$|[-:])/;
const SAFE_WORD = /^[A-Za-z0-9@_./:-]+$/;

/** Read only manifests, never .env, lockfile contents, or package-script bodies. */
async function readPackages(workspace: string): Promise<PackageInfo[]> {
  const found: PackageInfo[] = [];
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (++visited > 1500) throw new Error("QA package inventory exceeds its bounded scan.");
    let manifest: Record<string, unknown> | undefined;
    try { manifest = JSON.parse(await fs.readFile(join(directory, "package.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("QA package.json is unreadable or invalid.");
    }
    if (manifest) {
      const keys = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
      found.push({
        directory, name: typeof manifest.name === "string" ? manifest.name : undefined,
        scripts: new Set(keys(manifest.scripts)),
        tools: new Set([...keys(manifest.dependencies), ...keys(manifest.devDependencies)]),
      });
    }
    if (depth === 4) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name)) {
        await walk(join(directory, entry.name), depth + 1);
      }
    }
  }
  await walk(workspace, 0);
  return found;
}

/** Recognize a deliberately small grammar, without executing or rewriting a shell. */
export function extractExplicitQaCommands(text: string): string[] {
  const command = /\b(?:pnpm\s+(?:--filter\s+[@A-Za-z0-9_./-]+\s+)?(?:exec\s+(?:tsx\s+--test|vitest\s+run|node\s+--test)\s+[A-Za-z0-9_./-]+|(?:run\s+)?[A-Za-z0-9_:-]+)|npm\s+run\s+[A-Za-z0-9_:-]+)/g;
  const found: string[] = [];
  for (const match of text.matchAll(command)) {
    const literal = match[0].replace(/\.+$/, "");
    const suffix = text.slice((match.index ?? 0) + literal.length);
    // Never silently truncate flags, a second test path, or a shell operator.
    const next = suffix.match(/^[ \t]+([^\s`.,;)]+)/)?.[1];
    if (next && !/^(?:a|and|i|musí|must|projde|projdou|passes?|úspěšně|successfully)$/i.test(next)) continue;
    if (/^\s*(?:[|&<>]|\$\(|`[^\s.,;)]*\$)/.test(suffix)) continue;
    found.push(literal.replace(/\s+/g, " "));
  }
  return found;
}

async function verifiedCommand(command: string, workspace: string, packages: PackageInfo[]): Promise<boolean> {
  const words = command.split(" ");
  if (words.some((word) => !SAFE_WORD.test(word))) return false;
  const manager = words.shift();
  let selected = packages.find((pkg) => pkg.directory === workspace);
  if (manager === "pnpm" && words[0] === "--filter") {
    words.shift();
    const name = words.shift();
    const matching = packages.filter((pkg) => pkg.name === name);
    if (matching.length !== 1) return false;
    selected = matching[0];
  }
  if (!selected) return false;
  if (words[0] === "run") words.shift();
  if (words[0] !== "exec") return words.length === 1 && VERIFY_SCRIPT.test(words[0] ?? "") && selected.scripts.has(words[0]!);
  if (manager !== "pnpm") return false;
  const [, tool, mode, file] = words;
  if (words.length !== 4 || !file || !["tsx:--test", "node:--test", "vitest:run"].includes(`${tool}:${mode}`)) return false;
  if (tool !== "node" && !selected.tools.has(tool!) && !packages.find((pkg) => pkg.directory === workspace)?.tools.has(tool!)) return false;
  if (file.startsWith("/") || file.split("/").includes("..")) return false;
  try {
    const actual = await fs.realpath(join(selected.directory, file));
    const rel = relative(workspace, actual);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(actual).startsWith(`${workspace}${sep}node_modules${sep}`) && (await fs.stat(actual)).isFile();
  } catch { return false; }
}

function scenario(id: string, name: string, criterionId: string | undefined, commands: string[]): Scenario {
  return { id, name, kind: "cli", criterionId, steps: commands, expect: "exit code 0 for every command" };
}

function boundScenarios(scenarios: Scenario[], maxScenarios: number): Scenario[] {
  if (!Number.isSafeInteger(maxScenarios) || maxScenarios < 1 || scenarios.length > maxScenarios) {
    throw new Error("QA scenario limit cannot fit the required checks without discarding assertions.");
  }
  return scenarios;
}

/** Ground against the selected, approved QA artifact, never an unrelated base checkout. */
export async function groundQaCommands(input: {
  workspacePath: string; criteria: Criterion[]; tasks: Task[]; hasSpec: boolean; maxScenarios?: number;
}): Promise<GroundedQaCommands> {
  const workspace = await fs.realpath(input.workspacePath);
  const packages = await readPackages(workspace);
  const scenarios: Scenario[] = [];
  async function checks(text: string): Promise<string[]> {
    const candidates = extractExplicitQaCommands(text);
    if (candidates.length !== [...text.matchAll(/\b(?:pnpm|npm)\s+/g)].length) return [];
    const valid: string[] = [];
    for (const command of candidates) {
      if (!await verifiedCommand(command, workspace, packages)) throw new QaCommandGroundingError(command);
      valid.push(command);
    }
    // Partial extraction must not turn two required checks into a false PASS.
    return valid.length === candidates.length ? [...new Set(valid)] : [];
  }
  const covered = new Set<string>();
  for (const criterion of input.criteria) {
    const method = [criterion.check, typeof criterion.verifyMethod === "string" ? criterion.verifyMethod : undefined].filter(Boolean).join("\n");
    const commands = await checks(method);
    if (commands.length > 0) {
      scenarios.push(scenario(`explicit-criterion-${scenarios.length + 1}`, criterion.description, criterion.id, commands));
      let remainder = method.replace(/\s+/g, " ");
      for (const command of commands) remainder = remainder.split(command).join("");
      remainder = remainder.replace(/\b(?:run|spusť|spustit|a|and|projde|projdou|must pass|exit code 0)\b/gi, "").replace(/[\s`.,;():]+/g, "");
      if (!remainder) covered.add(criterion.id);
    }
  }
  let complete = input.hasSpec && input.criteria.length > 0 && input.criteria.every((criterion) => covered.has(criterion.id));
  // With no spec, the already approved tasks are the acceptance contract. Only
  // explicit successful verification qualifies; an audit may honestly report a
  // failing check and must never be converted into a mandatory exit-zero test.
  if (!input.hasSpec && input.criteria.length === 1 && input.tasks.length > 0) {
    let allTasks = true;
    for (const task of input.tasks) {
      const requiredPass = /\b(?:projde|projdou|must pass|passes|pass successfully)\b/i.test(task.doneCondition);
      const commands = requiredPass ? await checks(task.doneCondition) : [];
      if (commands.length === 0) { allTasks = false; continue; }
      scenarios.push(scenario(`explicit-task-${scenarios.length + 1}`, task.title, input.criteria[0]!.id, commands));
    }
    complete = allTasks;
  }
  const promptContext = [
    "Repository-verified package names and available verification scripts (commands run from /workspace):",
    ...packages.map((pkg) => `${relative(workspace, pkg.directory) || "."}: package ${pkg.name ?? "(unnamed)"}; scripts ${[...pkg.scripts].filter((name) => VERIFY_SCRIPT.test(name)).join(", ") || "(none)"}`),
    "Approved task acceptance contracts (keep exact package selectors, paths and commands; audit failures may be valid findings):",
    ...input.tasks.map((task) => `${task.title}\n${task.description ?? ""}\nDone condition: ${task.doneCondition}`),
    ...input.criteria.map((criterion) => `Criterion ${criterion.id} verification: ${criterion.check ?? ""} ${typeof criterion.verifyMethod === "string" ? criterion.verifyMethod : ""}`),
    "Required grounded CLI scenarios (do not replace their exact commands with guessed root scripts):",
    ...scenarios.map((item) => `[${item.criterionId ?? item.id}] ${item.steps.join(" ; ")}`),
  ].join("\n");
  return { scenarios: boundScenarios(scenarios, input.maxScenarios ?? 14), complete, promptContext };
}

/** Preserve additional assertions; replace only a CLI check for the same criterion. */
export function applyGroundedQaCommands(generated: Scenario[], grounding: GroundedQaCommands, maxScenarios = 14): Scenario[] {
  const bound = new Set(grounding.scenarios.map((item) => item.criterionId).filter(Boolean));
  const retained = generated.filter((item) => !(item.kind === "cli" && item.criterionId && bound.has(item.criterionId)
    && /^(?:exit(?: code)?\s*(?:is |[=:]\s*)?0|success(?:ful)?(?: exit(?: code)? 0)?)\.?$/i.test(item.expect.trim())));
  const ids = new Set(retained.map((item) => item.id));
  return boundScenarios([...retained, ...grounding.scenarios.map((item) => {
    let id = item.id;
    while (ids.has(id)) id += "-grounded";
    ids.add(id);
    return { ...item, id };
  })], maxScenarios);
}
