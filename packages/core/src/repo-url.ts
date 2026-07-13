/**
 * Bezpečnostní validace `project.repo_url` (BEZPEČNOSTNĚ KRITICKÉ).
 *
 * Bez ní si mohl kterýkoli přihlášený člen nastavit libovolné repo_url a orchestrátor
 * ho naklonoval s vloženým GitHub tokenem → tři třídy zranitelností:
 *  1) Token exfiltrace — `https://evil.tld/x.git` dostal `x-access-token:<TOKEN>@`
 *     (a při chybějícím per-user PAT sdílený GITHUB_ADMIN_PAT celé farmy).
 *  2) SSRF — klon na interní adresu (např. 169.254.169.254 metadata endpoint).
 *  3) git argument injection — hodnota začínající `-` (např. `--upload-pack=…`,
 *     `ext::sh -c …`) je `git clone`em interpretována jako přepínač → RCE na hostu.
 *
 * Proto: JEN https, JEN host github.com (nebo www.github.com), NIKDY hodnota začínající
 * '-'. Volá se při vytváření projektu (dashboard) i defenzivně před klonem (orchestrátor).
 */

const ALLOWED_HOSTS = new Set(["github.com", "www.github.com"]);

export class InvalidRepoUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRepoUrlError";
  }
}

/**
 * Vrátí normalizované (trimnuté) repo URL, nebo vyhodí InvalidRepoUrlError.
 * Prázdný/undefined vstup je chyba — volej jen když repo_mode očekává URL.
 */
export function assertSafeRepoUrl(raw: string | null | undefined): string {
  const url = (raw ?? "").trim();
  if (!url) throw new InvalidRepoUrlError("Repo URL je prázdné.");
  // Argument injection: git bere první poziční arg jako přepínač, když začíná '-'.
  if (url.startsWith("-")) throw new InvalidRepoUrlError("Repo URL nesmí začínat '-'.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidRepoUrlError("Repo URL není platná URL (očekávám https://github.com/owner/repo).");
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidRepoUrlError("Repo URL musí používat https:// (ne ssh/git/http/file/ext).");
  }
  if (parsed.username || parsed.password) {
    throw new InvalidRepoUrlError("Repo URL nesmí obsahovat přihlašovací údaje (user:pass@).");
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new InvalidRepoUrlError("Povolený je jen host github.com.");
  }
  // owner/repo musí existovat (aspoň dva segmenty cesty).
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new InvalidRepoUrlError("Repo URL musí mít tvar https://github.com/owner/repo.");
  }
  // Vrať NORMALIZOVANOU (re-serializovanou) URL, ne surový vstup — jinak vzniká parser
  // differential: `new URL()` (WHATWG) sbalí zpětná lomítka na lomítka a zahodí tab/newline,
  // takže `https://github.com\@evil.com/a/b`, `https://git\nhub.com/o/r` apod. projdou
  // validací, ale downstream (git clone/push s vloženým tokenem) by dostal jinou hodnotu.
  // Rekonstrukce z ověřených komponent garantuje, že validovaná == použitá hodnota.
  return `https://${parsed.hostname}${parsed.pathname}${parsed.search}`;
}

/** Nevyhazující varianta — true, když je repo URL bezpečné. */
export function isSafeRepoUrl(raw: string | null | undefined): boolean {
  try {
    assertSafeRepoUrl(raw);
    return true;
  } catch {
    return false;
  }
}
