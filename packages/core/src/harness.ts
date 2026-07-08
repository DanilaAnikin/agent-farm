/**
 * Config ráčna (OVERVIEW §5.5 bod 3): worker si nesmí přepsat harness, kterým je
 * souzen. Judge diffuje tuto chráněnou množinu proti main a jakoukoliv změnu
 * eskaluje na člověka (approval `config_change`).
 */
export const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.eslintrc[^/]*$/,
  /(^|\/)eslint\.config\.[cm]?[jt]s$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)jest\.config\.[cm]?[jt]s$/,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.farm\//,
  /(^|\/)\.opencode\//,
  /(^|\/)turbo\.json$/,
];

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATH_PATTERNS.some((re) => re.test(path));
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions?: number;
  deletions?: number;
}

/**
 * Chráněné soubory, které diff MODIFIKUJE / MAŽE / PŘEJMENOVÁVÁ (ne pouze přidává).
 * PŘIDÁNÍ nového chráněného souboru je legitimní scaffolding nového projektu
 * (worker MUSÍ vytvořit package.json/tsconfig). Ráčnujeme jen změnu EXISTUJÍCÍCH
 * harness souborů — to je ta cesta, jak by worker gamoval kontrolu.
 */
export function protectedFilesTouched(files: DiffFile[]): DiffFile[] {
  return files.filter((f) => isProtectedPath(f.path) && f.status !== "added");
}

const TEST_PATH = /(^|\/)(.*\.(test|spec)\.[cm]?[jt]sx?|__tests__\/.*)$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** Ráčna na testy: byl smazán testovací soubor? (reject) */
export function deletedTestFiles(files: DiffFile[]): DiffFile[] {
  return files.filter((f) => f.status === "deleted" && isTestPath(f.path));
}
