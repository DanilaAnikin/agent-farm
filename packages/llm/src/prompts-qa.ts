/**
 * QA / Tester prompty (anglicky — čínské modely jsou na EN spolehlivější).
 *
 * Dva builders:
 *  - testerPlanPrompt: ze specifikace + acceptance criteria vyrobí konkrétní E2E
 *    testovací scénáře (web: kam kliknout / co vyplnit / co čekat / kde udělat screenshot;
 *    cli/api: jaké příkazy a jaký výstup). Každý scénář se snaží mapovat na criterionId,
 *    aby byla POKRYTA VŠECHNA acceptance criteria.
 *  - visionCheckPrompt: VLM posoudí, zda screenshot vizuálně splňuje daný záměr/kritérium.
 */
import type { ChatMessage } from "./client.js";
import { attachImage } from "./client.js";
import { withConstitution } from "./constitution.js";

// --- Tester plan -------------------------------------------------------------
export interface TesterPlanScenario {
  id: string;
  name: string;
  kind: "web" | "cli" | "api";
  criterionId?: string;
  steps: string[];
  expect: string;
  route?: string;
}
export interface TesterPlanOutput {
  scenarios: TesterPlanScenario[];
}

export function testerPlanPrompt(input: {
  wishTitle: string;
  specMd: string;
  acceptanceCriteria: { id: string; description: string; check?: string }[];
  projectKind: string;
  startCommand?: string;
  appUrl?: string;
  fileTree?: string;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: withConstitution(
        `You are the TESTER: a meticulous QA engineer in an autonomous farm. The app has just been built by other ` +
        `agents. Your plan will be executed literally by a test runner that drives a real browser (Playwright: navigate, ` +
        `click, fill, wait, screenshot) and a shell (for CLI/API). You do NOT trust the developers — you verify every ` +
        `acceptance criterion actually works, both functionally and visually.\n\n` +
        `Produce concrete, executable scenarios. Return ONLY JSON:\n` +
        `{ "scenarios": [{\n` +
        `  "id": string,                 // unique slug, e.g. "s1-login"\n` +
        `  "name": string,               // human summary, e.g. "Přihlášení platnými údaji"\n` +
        `  "kind": "web"|"cli"|"api",\n` +
        `  "criterionId"?: string,       // the acceptance-criterion id this scenario proves (set whenever possible)\n` +
        `  "steps": string[],            // ordered, literal, imperative actions (see rules per kind)\n` +
        `  "expect": string,             // the single observable success condition to assert\n` +
        `  "route"?: string              // for web: the path to navigate to first, e.g. "/login"\n` +
        `}] }\n\n` +
        `RULES FOR web SCENARIOS:\n` +
        `- Set "route" to the starting path. steps are literal UI actions: 'navigate ${input.appUrl ?? "<appUrl>"}<route>', ` +
        `'fill input[name=email] with valid@example.com', 'click button:has-text("Přihlásit")', 'wait for url /dashboard', ` +
        `'screenshot'. Reference elements by visible text or obvious selector.\n` +
        `- Always end a web scenario with a 'screenshot' step so the result can be visually verified.\n` +
        `- "expect" is one checkable statement, e.g. "url is /dashboard and text 'Vítej' is visible".\n\n` +
        `RULES FOR cli SCENARIOS:\n` +
        `- steps are exact shell commands to run (one per entry). "expect" states the exact stdout substring or exit code.\n\n` +
        `RULES FOR api SCENARIOS:\n` +
        `- steps are exact HTTP calls (curl-style with method, path, body). "expect" states status code + expected JSON shape/field.\n\n` +
        `COVERAGE RULES:\n` +
        `- EVERY acceptance criterion must be covered by at least one scenario (map via criterionId). If a criterion has a ` +
        `"check" command, prefer a cli/api scenario that runs exactly it.\n` +
        `- Include at least one NEGATIVE/edge scenario (invalid input rejected, empty state shown, 404/401 path).\n` +
        `- Keep scenarios independent and idempotent; do not assume state from a previous scenario unless steps set it up.\n` +
        `- Be specific: never write "test that it works" — write the exact actions and the exact expectation.`,
      ),
    },
    {
      role: "user",
      content:
        `Project kind: ${input.projectKind}\n` +
        `Wish: ${input.wishTitle}\n` +
        (input.startCommand ? `Start command: ${input.startCommand}\n` : "") +
        (input.appUrl ? `App URL (already running): ${input.appUrl}\n` : "") +
        `\nSpecification:\n${input.specMd}\n\n` +
        `Acceptance criteria (COVER ALL of these):\n` +
        input.acceptanceCriteria
          .map((c) => `- [${c.id}] ${c.description}${c.check ? ` (check: ${c.check})` : ""}`)
          .join("\n") +
        (input.fileTree ? `\n\nProject file tree (for routes/commands):\n${input.fileTree}` : ""),
    },
  ];
}

export function validateTesterPlan(data: unknown): true | string {
  const d = data as TesterPlanOutput;
  if (!d || !Array.isArray(d.scenarios)) return "scenarios must be an array";
  if (d.scenarios.length === 0) return "scenarios must not be empty";
  const seen = new Set<string>();
  for (const s of d.scenarios) {
    if (!s || typeof s.id !== "string" || !s.id) return "each scenario needs a non-empty id";
    if (seen.has(s.id)) return `duplicate scenario id: ${s.id}`;
    seen.add(s.id);
    if (!s.name) return `scenario ${s.id} needs a name`;
    if (!["web", "cli", "api"].includes(s.kind)) return `scenario ${s.id} kind must be web|cli|api`;
    if (!Array.isArray(s.steps) || s.steps.length === 0)
      return `scenario ${s.id} needs a non-empty steps array`;
    if (typeof s.expect !== "string" || s.expect.length < 3)
      return `scenario ${s.id} needs an 'expect' success condition`;
  }
  return true;
}

// --- Vision check ------------------------------------------------------------
export interface VisionCheckOutput {
  pass: boolean;
  score: number; // 0..1
  issues: string[];
}

export function visionCheckPrompt(input: {
  intent: string;
  criterion?: string;
  /** Screenshot (data: URL nebo veřejná URL). Připojí se jako multimodální content. */
  imageUrl?: string;
}): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: withConstitution(
        `You are a strict visual QA reviewer. You are shown a SCREENSHOT of a running app and must judge whether it ` +
        `visually satisfies the stated intent${input.criterion ? " and acceptance criterion" : ""}. Judge only what is ` +
        `visible in the image.\n\n` +
        `Return ONLY JSON: { "pass": boolean, "score": number (0..1), "issues": string[] }.\n\n` +
        `FAIL (pass=false) if any of:\n` +
        `- The expected content/elements described in the intent are missing or not visible.\n` +
        `- The layout is broken: overlapping/cut-off text, elements off-screen, zero-height containers, unstyled/raw HTML.\n` +
        `- A framework error/stack trace, blank white page, 404/500 page, or "Cannot GET" is shown.\n` +
        `- Placeholder/lorem/undefined/NaN/[object Object] leaks into the UI where real content should be.\n` +
        `- It clearly does not match the intent.\n\n` +
        `PASS (pass=true) when the page renders correctly and the intended content is present and legible. ` +
        `score is your confidence (1 = clearly correct, 0 = clearly wrong). Each issue must be specific and observable.`,
      ),
    },
    {
      role: "user",
      content:
        `Intent: ${input.intent}` +
        (input.criterion ? `\nAcceptance criterion: ${input.criterion}` : "") +
        `\n(The screenshot is attached as an image.)`,
    },
  ];
  return input.imageUrl ? attachImage(messages, input.imageUrl) : messages;
}

export function validateVisionCheck(data: unknown): true | string {
  const d = data as VisionCheckOutput;
  if (!d || typeof d.pass !== "boolean") return "pass must be boolean";
  if (typeof d.score !== "number" || Number.isNaN(d.score)) return "score must be a number 0..1";
  if (d.issues !== undefined && !Array.isArray(d.issues)) return "issues must be an array of strings";
  return true;
}
