/**
 * Validace server actions a čisté výpočty pro /admin, /settings a /costs.
 *
 * PROČ: server action je veřejný RPC endpoint. TS typy parametrů nejsou runtime
 * validace — kdokoli přihlášený může akci zavolat s libovolným JSONem. Dřív tak
 * `setFarmSetting` přijal jakýkoli klíč (i `owner_pause` nebo `budget_block`),
 * `updateUserCaps` zapsal `NaN` → JSON null → NOT NULL violation se syrovou
 * anglickou chybou z Postgresu a admin mohl odebrat práva sám sobě i poslednímu
 * administrátorovi.
 *
 * Soubor je ZÁMĚRNĚ bez `@/` importů — testuje se přes `tsx --test`.
 */
import { effectivePlanKey, getPlan, planCaps } from "@farm/billing/plans";

type Vysledek<T> = { ok: true; value: T } | { ok: false; message: string };

// =============================================================================
// Čísla ze vstupů
// =============================================================================

/**
 * „0,60" i „0.6" → 0.6. Prázdné pole → null (NE nula: prázdno není příkaz
 * „neutrácej nic"). Cokoli jiného než jedno desetinné číslo → NaN.
 */
export function parseDecimalInput(raw: unknown): number | null {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return Number.NaN;
  const s = raw.replace(/\s| /g, "").replace(/US\$$/i, "");
  if (s === "") return null;
  if (!/^-?\d+([.,]\d+)?$/.test(s)) return Number.NaN;
  return Number(s.replace(",", "."));
}

/**
 * Konečné číslo oříznuté do rozsahu. `null` = nečíselný vstup (NaN, řetězec,
 * Infinity) — volající ho musí odmítnout, ne tiše uložit nulu.
 */
export function clampCap(value: unknown, max: number, min = 0): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const horni = Number.isFinite(max) ? Math.max(min, max) : min;
  const v = Math.min(horni, Math.max(min, value));
  // Centy stačí; plovoucí čárka jinak vyrobí 0.6000000000000001.
  return Math.round(v * 10000) / 10000;
}

// =============================================================================
// farm_settings — whitelist editovatelných klíčů
// =============================================================================

/**
 * Jediné klíče, které smí dashboard zapsat přes `setFarmSetting`.
 *
 * NEPATŘÍ SEM: klíče pauzy (`owner_pause`, `global_pause`, `pause_source` —
 * mají vlastní akci s pravidly), `budget_block`, `month_guard_*` a
 * `deepseek_balance_usd` (zapisují je hlídači; ruční zápis by obešel pojistku).
 * Horní meze jsou pojistka proti překlepu, NE doporučení — výchozí stropy
 * farmy (0,60 / 0,20 / 20 US$) jsou hluboko pod nimi.
 */
export const EDITOVATELNE_KLICE = {
  farm_daily_cap_usd: { min: 0, max: 5 },
  farm_daily_media_cap_usd: { min: 0, max: 5 },
  farm_monthly_cap_usd: { min: 0, max: 50 },
  max_workers_total: { min: 1, max: 8 },
} as const;

export type EditableFarmSettingKey = keyof typeof EDITOVATELNE_KLICE;

export function isEditableFarmSetting(key: unknown): key is EditableFarmSettingKey {
  return typeof key === "string" && Object.hasOwn(EDITOVATELNE_KLICE, key);
}

/** Validace zápisu do farm_settings. Mimo rozsah se ODMÍTÁ, ne ořezává. */
export function validateFarmSetting(
  key: unknown,
  value: unknown,
): Vysledek<{ key: EditableFarmSettingKey; value: number }> {
  if (!isEditableFarmSetting(key)) {
    return { ok: false, message: "Tohle nastavení se z dashboardu měnit nedá." };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, message: "Zadej číslo." };
  }
  const { min, max } = EDITOVATELNE_KLICE[key];
  if (value < min || value > max) {
    return { ok: false, message: `Hodnota musí být mezi ${cz(min)} a ${cz(max)}.` };
  }
  if (key === "max_workers_total" && !Number.isInteger(value)) {
    return { ok: false, message: "Počet workerů musí být celé číslo." };
  }
  return { ok: true, value: { key, value } };
}

function cz(n: number): string {
  return new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 2 }).format(n);
}

// =============================================================================
// Uživatelé — role a stropy
// =============================================================================

export const USER_ROLES = ["admin", "member"] as const;
export type UserRoleValue = (typeof USER_ROLES)[number];

/** Nejvyšší denní strop uživatele, který jde v dashboardu nastavit. */
export const USER_CAP_MAX_USD = 20;

export function isUserRole(value: unknown): value is UserRoleValue {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Smí se role změnit?
 *   - role jen z whitelistu,
 *   - admin si NESMÍ sám sebe degradovat (odřízl by se od /admin),
 *   - poslednímu administrátorovi se práva odebrat nedají.
 */
export function canChangeRole(input: {
  actorId: string;
  targetId: string;
  currentRole: unknown;
  nextRole: unknown;
  adminCount: number;
}): { ok: true } | { ok: false; message: string } {
  if (!isUserRole(input.nextRole)) return { ok: false, message: "Neznámá role." };
  if (input.currentRole === input.nextRole) return { ok: true };
  if (input.currentRole === "admin" && input.nextRole !== "admin") {
    if (input.actorId === input.targetId) {
      return { ok: false, message: "Sám sobě administrátorská práva odebrat nemůžeš." };
    }
    if (!(input.adminCount > 1)) {
      return { ok: false, message: "Nemůžeš odebrat práva poslednímu administrátorovi." };
    }
  }
  return { ok: true };
}

/**
 * Nový uživatelský strop: 0–20 US$ a NIKDY nad strop farmy (vyšší by stejně
 * nic nepovolil, jen by v UI lhal). Vrací i příznak, že se ořezávalo.
 */
export function normalizeUserCap(
  raw: unknown,
  farmCapUsd: number,
): { ok: true; value: number; clamped: boolean } | { ok: false; message: string } {
  if (raw === null || raw === undefined || raw === "") {
    return { ok: false, message: "Vyplň strop (0 = uživatel nesmí utrácet)." };
  }
  const n = typeof raw === "string" ? parseDecimalInput(raw) : raw;
  const strop = Number.isFinite(farmCapUsd) ? Math.min(USER_CAP_MAX_USD, farmCapUsd) : USER_CAP_MAX_USD;
  const v = clampCap(n, strop, 0);
  if (v === null) return { ok: false, message: "Strop musí být číslo." };
  return { ok: true, value: v, clamped: v !== n };
}

/**
 * Sloučí změny do `profiles.caps_override`. PŘEPIS celého jsonb by smazal
 * ostatní klíče (maxWorkers, maxProjects) a uživatel by spadl na hodnoty plánu —
 * u plánu Free je denní strop 2 US$, tedy víc než ruční 0,60 US$.
 */
export function mergeCapsOverride(
  existing: unknown,
  patch: Record<string, number | undefined>,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    for (const [k, v] of Object.entries(existing as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export interface EffectiveUserCaps {
  dailyCapUsd: number;
  dailyMediaCapUsd: number;
  planName: string;
  hasOverride: boolean;
  /** „plán Free + ruční přepis" */
  sourceLabel: string;
}

/**
 * EFEKTIVNÍ denní stropy uživatele — přesně jak je počítá orchestrátor
 * (settings.getCaps) a media pipeline (loadMediaCaps). Sloupce
 * `profiles.daily_cap_usd` / `daily_media_cap_usd` strop NEURČUJÍ.
 */
export function effectiveUserCaps(profile: {
  plan_key?: string | null;
  subscription_status?: string | null;
  caps_override?: Record<string, number> | null;
}): EffectiveUserCaps {
  const plan = getPlan(effectivePlanKey(profile.plan_key, profile.subscription_status));
  const override = profile.caps_override ?? null;
  const caps = planCaps(plan, override);
  const hasOverride =
    !!override &&
    (typeof override.dailyCapUsd === "number" || typeof override.dailyMediaCapUsd === "number");
  return {
    dailyCapUsd: caps.dailyCapUsd,
    dailyMediaCapUsd: caps.dailyMediaCapUsd,
    planName: plan.name,
    hasOverride,
    sourceLabel: hasOverride ? `plán ${plan.name} + ruční přepis` : `plán ${plan.name}`,
  };
}

// =============================================================================
// Vypínač majitele
// =============================================================================

export interface OwnerToggleWrite {
  ownerPause: boolean;
  /** Shodit i `global_pause`? Jen když ho nedrží automatický hlídač. */
  clearGlobalPause: boolean;
  /** `pause_source` se čistí JEN tehdy, když se `global_pause` opravdu shodil. */
  clearPauseSource: boolean;
  message: string;
}

/**
 * Co zapsat po kliknutí na vypínač. Rozhodnutí o `global_pause` dělá
 * `resolveResumeAction` z lib/farm-state (sem se předává jeho výsledek, aby
 * pravidlo bylo na jednom místě).
 */
export function planOwnerToggle(
  paused: boolean,
  resume: { clearGlobalPause: boolean; message: string },
): OwnerToggleWrite {
  if (paused) {
    return {
      ownerPause: true,
      clearGlobalPause: false,
      clearPauseSource: false,
      message: "Farma zastavena. Žádný hlídač ji sám nespustí.",
    };
  }
  return {
    ownerPause: false,
    clearGlobalPause: resume.clearGlobalPause,
    clearPauseSource: resume.clearGlobalPause,
    message: resume.message,
  };
}

// =============================================================================
// Připojení (GitHub PAT)
// =============================================================================

export const CONNECTION_KINDS_EDITABLE = ["github"] as const;
export type EditableConnectionKind = (typeof CONNECTION_KINDS_EDITABLE)[number];

/** Klíče, které smí přijít v `connections.meta`. Nic jiného se neuloží. */
export const CONNECTION_META_KEYS = ["label", "account"] as const;

export function isEditableConnectionKind(kind: unknown): kind is EditableConnectionKind {
  return typeof kind === "string" && (CONNECTION_KINDS_EDITABLE as readonly string[]).includes(kind);
}

/**
 * GitHub token: fine-grained `github_pat_…` nebo klasický `ghp_…` / `gho_…` / `ghu_…`
 * / `ghs_…` / `ghr_…`. Délka 20–500 znaků, žádné mezery ani uvozovky.
 */
export function validatePat(raw: unknown): Vysledek<string> {
  if (typeof raw !== "string") return { ok: false, message: "Token musí být text." };
  const token = raw.trim();
  if (token.length < 20 || token.length > 500) {
    return { ok: false, message: "Token musí mít 20 až 500 znaků." };
  }
  const fineGrained = /^github_pat_[A-Za-z0-9_]{20,}$/;
  const klasicky = /^gh[pousr]_[A-Za-z0-9]{20,}$/;
  if (!fineGrained.test(token) && !klasicky.test(token)) {
    return {
      ok: false,
      message: "Tohle nevypadá jako GitHub token (začíná github_pat_ nebo ghp_).",
    };
  }
  return { ok: true, value: token };
}

/** Z `meta` nechá jen povolené klíče s krátkou textovou hodnotou. */
export function sanitizeConnectionMeta(meta: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return out;
  for (const k of CONNECTION_META_KEYS) {
    const v = (meta as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim().slice(0, 200);
  }
  return out;
}

// =============================================================================
// Pozvánky
// =============================================================================

export const INVITE_TTL_DAYS = 7;

/** Normalizovaný e-mail, nebo chyba. Záměrně jednoduchý regex — ověří ho registrace. */
export function validateEmail(raw: unknown): Vysledek<string> {
  if (typeof raw !== "string") return { ok: false, message: "Zadej e-mail." };
  const email = raw.trim().toLowerCase();
  if (email === "") return { ok: false, message: "Zadej e-mail." };
  if (email.length > 254 || !/^[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}$/.test(email)) {
    return { ok: false, message: "Tohle není platný e-mail." };
  }
  return { ok: true, value: email };
}

export function inviteExpiresAt(now: Date = new Date()): string {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000).toISOString();
}

export type InviteState = "active" | "used" | "revoked" | "expired";

export function inviteState(
  invite: { used_at: string | null; revoked_at?: string | null; expires_at?: string | null },
  now: Date = new Date(),
): InviteState {
  if (invite.used_at) return "used";
  if (invite.revoked_at) return "revoked";
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= now.getTime()) return "expired";
  return "active";
}

/** Česká hláška pro přijetí pozvánky, nebo null = pozvánka platí. */
export function inviteRejection(
  invite: { used_at: string | null; revoked_at?: string | null; expires_at?: string | null },
  now: Date = new Date(),
): string | null {
  switch (inviteState(invite, now)) {
    case "used":
      return "Tahle pozvánka už byla použita. Přihlas se.";
    case "revoked":
      return "Pozvánka byla zrušena. Požádej administrátora o novou.";
    case "expired":
      return "Platnost pozvánky vypršela. Požádej administrátora o novou.";
    default:
      return null;
  }
}

// =============================================================================
// Profil (preference_profile)
// =============================================================================

export const PROFILE_LIMITS = {
  displayName: 80,
  text: 2000,
  items: 50,
  itemLength: 200,
} as const;

export interface ProfilePatch {
  displayName: string | null;
  profile: {
    tone?: string;
    style?: string;
    language?: string;
    brand: { colors: string[]; fonts: string[]; logoUrl?: string };
    dos: string[];
    donts: string[];
  };
}

/** Validace formuláře profilu (vstupy jsou syrové hodnoty z FormData). */
export function validateProfileInput(fields: Record<string, unknown>): Vysledek<ProfilePatch> {
  const text = (k: string): string => (typeof fields[k] === "string" ? (fields[k] as string).trim() : "");
  const seznam = (k: string): string[] =>
    text(k)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  const displayName = text("display_name");
  if (displayName.length > PROFILE_LIMITS.displayName) {
    return { ok: false, message: `Jméno může mít nejvýš ${PROFILE_LIMITS.displayName} znaků.` };
  }
  for (const k of ["tone", "style", "language", "brand_colors", "brand_fonts", "dos", "donts"]) {
    if (text(k).length > PROFILE_LIMITS.text) {
      return { ok: false, message: `Pole je moc dlouhé (nejvýš ${PROFILE_LIMITS.text} znaků).` };
    }
  }
  const seznamy = {
    brand_colors: seznam("brand_colors"),
    brand_fonts: seznam("brand_fonts"),
    dos: seznam("dos"),
    donts: seznam("donts"),
  };
  for (const polozky of Object.values(seznamy)) {
    if (polozky.length > PROFILE_LIMITS.items) {
      return { ok: false, message: `Seznam může mít nejvýš ${PROFILE_LIMITS.items} položek.` };
    }
    if (polozky.some((p) => p.length > PROFILE_LIMITS.itemLength)) {
      return {
        ok: false,
        message: `Jedna položka může mít nejvýš ${PROFILE_LIMITS.itemLength} znaků.`,
      };
    }
  }
  const logo = text("brand_logo");
  if (logo !== "") {
    let url: URL | null = null;
    try {
      url = new URL(logo);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || logo.length > PROFILE_LIMITS.text) {
      return { ok: false, message: "Logo musí být odkaz začínající http:// nebo https://." };
    }
  }

  return {
    ok: true,
    value: {
      displayName: displayName || null,
      profile: {
        tone: text("tone") || undefined,
        style: text("style") || undefined,
        language: text("language") || undefined,
        brand: {
          colors: seznamy.brand_colors,
          fonts: seznamy.brand_fonts,
          logoUrl: logo || undefined,
        },
        dos: seznamy.dos,
        donts: seznamy.donts,
      },
    },
  };
}

/**
 * Sloučí formulář do stávajícího `preference_profile`. Slepý přepis by smazal
 * klíče, které formulář nezná (zapisuje je farma nebo jiné obrazovky).
 * Pole z formuláře se přepisují vždy — prázdné pole = uživatel ho vymazal.
 */
export function mergePreferenceProfile(
  existing: unknown,
  patch: ProfilePatch["profile"],
): Record<string, unknown> {
  const puvodni =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const puvodniBrand =
    puvodni.brand && typeof puvodni.brand === "object" && !Array.isArray(puvodni.brand)
      ? (puvodni.brand as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {
    ...puvodni,
    tone: patch.tone,
    style: patch.style,
    language: patch.language,
    brand: { ...puvodniBrand, ...patch.brand },
    dos: patch.dos,
    donts: patch.donts,
  };
  // `undefined` se do jsonb neserializuje; explicitně ho vyhodíme, ať je výsledek čitelný.
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  const brand = out.brand as Record<string, unknown>;
  for (const k of Object.keys(brand)) if (brand[k] === undefined) delete brand[k];
  return out;
}

// =============================================================================
// Agenti
// =============================================================================

/** Tep starší než 3 min = agent netepe (viz reconciliation v OVERVIEW §5.2). */
export const STALE_HEARTBEAT_MS = 3 * 60 * 1000;
/** Ukončené agenty starší než den ve výpisu nezobrazujeme. */
export const AGENT_HIDE_AFTER_MS = 24 * 60 * 60 * 1000;

interface AgentLike {
  status: string;
  last_heartbeat: string | null;
}

function vekTepu(a: AgentLike, now: Date): number {
  if (!a.last_heartbeat) return Number.POSITIVE_INFINITY;
  const t = new Date(a.last_heartbeat).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : now.getTime() - t;
}

/**
 * Souhrn zdraví agentů.
 *   live    — tváří se jako živý (busy/idle) a tepe,
 *   working — z živých právě pracuje (busy),
 *   silent  — tváří se jako živý, ale NETEPE (tohle je porucha),
 * Mrtví (`dead`) se nepočítají nikam: jsou to řádně ukončené procesy.
 */
export function agentHealthSummary(
  agents: AgentLike[],
  now: Date = new Date(),
): { live: number; working: number; silent: number } {
  let live = 0;
  let working = 0;
  let silent = 0;
  for (const a of agents) {
    if (a.status !== "busy" && a.status !== "idle") continue;
    if (vekTepu(a, now) > STALE_HEARTBEAT_MS) {
      silent += 1;
      continue;
    }
    live += 1;
    if (a.status === "busy") working += 1;
  }
  return { live, working, silent };
}

/** Patří agent do výpisu? Neukončený, nebo ukončený během posledních 24 h. */
export function isAgentListed(a: AgentLike, now: Date = new Date()): boolean {
  return a.status !== "dead" || vekTepu(a, now) <= AGENT_HIDE_AFTER_MS;
}

// =============================================================================
// Modely — aliasy okruhů LiteLLM
// =============================================================================

/**
 * Alias okruhu → skutečný model. MUSÍ odpovídat `model_name` → `model`
 * v infra/litellm/config.yaml (hlídá to test). Routování se tady NEMĚNÍ,
 * jen se překládá pro zobrazení.
 */
export const MODEL_ALIAS_TO_MODEL: Record<string, string> = {
  manager: "deepseek/deepseek-flash",
  worker: "deepseek/deepseek-flash",
  "worker-hard": "deepseek/deepseek-flash",
  // Poslední záchrana u třetího pokusu — jediná role, která smí na dražší Pro.
  "worker-fallback": "deepseek/deepseek-v4-pro",
  judge: "deepseek/deepseek-flash",
  cheap: "deepseek/deepseek-flash",
  "media-vlm": "deepseek/deepseek-flash",
};

export function resolveModel(model: string | null | undefined): string | null {
  if (!model) return null;
  return MODEL_ALIAS_TO_MODEL[model] ?? model;
}

/** Je `model` alias okruhu (a ne rovnou ID modelu poskytovatele)? */
export function isModelAlias(model: string | null | undefined): boolean {
  return typeof model === "string" && model in MODEL_ALIAS_TO_MODEL;
}

const ZNACKY: Record<string, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  gpt: "GPT",
  glm: "GLM",
  qwen: "Qwen",
  kimi: "Kimi",
  claude: "Claude",
  gemini: "Gemini",
  groq: "Groq",
  fal: "fal",
  elevenlabs: "ElevenLabs",
};

function hezkeSlovo(slovo: string): string {
  const znacka = ZNACKY[slovo.toLowerCase()];
  if (znacka) return znacka;
  if (/^v?\d/i.test(slovo)) return slovo.toUpperCase();
  return slovo.charAt(0).toUpperCase() + slovo.slice(1);
}

/**
 * „deepseek/deepseek-v4-pro" (i alias „worker") → „DeepSeek V4 Pro".
 *
 * Alias překládá podle AKTUÁLNÍHO routování, takže patří jen tam, kde jde o
 * současný stav (živí agenti). Na uložené řádky použij `storedModelLabel`.
 */
export function modelLabel(model: string | null | undefined): string {
  const skutecny = resolveModel(model);
  if (!skutecny) return "—";
  const bezPoskytovatele = skutecny.includes("/") ? skutecny.slice(skutecny.lastIndexOf("/") + 1) : skutecny;
  return bezPoskytovatele.split(/[-_]/).filter(Boolean).map(hezkeSlovo).join(" ");
}

/**
 * Popisek modelu u ULOŽENÉHO řádku (pokus, pohyb v ledgeru, doběhlý běh agenta).
 *
 * Alias se tu záměrně NEPŘEKLÁDÁ. `attempts.model` i `cost_ledger.model` drží alias
 * okruhu z doby vzniku řádku a routování se v čase mění (alias `worker` jel do
 * 16. 9. 2026 na Pru, od té doby na Flashi). Překlad přes dnešní mapu by tvrdil, že
 * staré pokusy běžely na modelu, který tehdy nepoužívaly — dashboard má o minulosti
 * mlčet, ne si ji domýšlet. Když řádek nese rovnou ID modelu, ukáže se model.
 */
export function storedModelLabel(model: string | null | undefined): string {
  if (!model) return "—";
  return isModelAlias(model) ? model : modelLabel(model);
}

/** „deepseek" → „DeepSeek"; prázdný poskytovatel → „—". */
export function poskytovatelLabel(provider: string | null | undefined): string {
  if (!provider) return "—";
  return hezkeSlovo(provider);
}

// =============================================================================
// Náklady — agregace výstupu RPC cost_summary
// =============================================================================

export interface CostSummaryLike {
  day: string;
  project_id: string | null;
  scope: string;
  model: string | null;
  provider: string | null;
  cost_usd: number;
}

export interface NamedValue {
  name: string;
  value: number;
}

export const SYSTEM_PROJECT_LABEL = "Systém (plánování a hodnocení)";

/**
 * Grafy /costs. Bere jen `cost_usd > 0` (nulové řádky s aliasy dělaly prázdné
 * sloupce) a řádky bez projektu sčítá do položky „Systém", aby součet grafu „Podle
 * projektu" seděl s celkem. Model se bere tak, jak je v řádku uložený
 * (`storedModelLabel`): jde o historii, a ta se překladem dnešních aliasů nepřepisuje.
 */
export function aggregateCosts(
  rows: CostSummaryLike[],
  days: string[],
  projectName: (id: string) => string,
): {
  total: number;
  byDay: { day: string; real: number }[];
  byProject: NamedValue[];
  byModel: NamedValue[];
  byPoskytovatel: NamedValue[];
} {
  const denni = new Map<string, number>(days.map((d) => [d, 0]));
  const projekty = new Map<string, number>();
  const modely = new Map<string, number>();
  const poskytovatele = new Map<string, number>();
  let total = 0;

  for (const r of rows) {
    const c = Number(r.cost_usd);
    if (!Number.isFinite(c) || c <= 0) continue;
    const den = String(r.day).slice(0, 10);
    if (!denni.has(den)) continue;
    denni.set(den, (denni.get(den) ?? 0) + c);
    total += c;
    const p = r.project_id ? projectName(r.project_id) : SYSTEM_PROJECT_LABEL;
    projekty.set(p, (projekty.get(p) ?? 0) + c);
    const m = storedModelLabel(r.model);
    modely.set(m, (modely.get(m) ?? 0) + c);
    const pr = poskytovatelLabel(r.provider);
    poskytovatele.set(pr, (poskytovatele.get(pr) ?? 0) + c);
  }

  const serad = (m: Map<string, number>): NamedValue[] =>
    Array.from(m.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

  return {
    total,
    byDay: days.map((d) => ({ day: d, real: denni.get(d) ?? 0 })),
    byProject: serad(projekty),
    byModel: serad(modely),
    byPoskytovatel: serad(poskytovatele),
  };
}

// =============================================================================
// Mapa stropů
// =============================================================================

export interface CapLayer {
  key: "farm_month" | "farm_day" | "media_day" | "user" | "project" | "attempt";
  label: string;
  /** null = nevíme (hlídač nedostupný, hodnota drží jiná služba). */
  spent: number | null;
  cap: number | null;
  guard: string;
  editWhere: string;
  note?: string;
  /** Čerpání je jen dolní odhad (useknuté čtení). */
  spentLowerBound?: boolean;
}

/**
 * Poměr čerpání vrstvy. Strop 0 = vrstva blokuje vždy (poměr 1).
 * Neznámé hodnoty → null (vrstva do „nejbližšího stropu" nevstupuje).
 */
export function layerRatio(layer: Pick<CapLayer, "spent" | "cap">): number | null {
  if (layer.cap === null || layer.spent === null) return null;
  if (!Number.isFinite(layer.cap) || !Number.isFinite(layer.spent)) return null;
  if (layer.cap <= 0) return 1;
  return Math.max(0, layer.spent / layer.cap);
}

/** Projekt pro vrstvu „Projekty" na mapě stropů. */
export interface ProjectCapInput {
  id: string;
  name: string;
  status: string;
  daily_cap_usd: number | null;
}

/**
 * Nejvytíženější projekt, jehož denní strop OPRAVDU váže: jen projekty, na kterých
 * farma smí pracovat (aktivní, nebo čekají na rozpočet a samy se pustí) a mají
 * strop > 0. Pozastavený projekt se stropem 0 dřív vyhrál jako „Aktuálně nejblíž
 * stropu" s „0,00 US$ z 0,00 US$", protože strop 0 dává poměr 1.
 */
export function busiestProjectCap(
  projects: readonly ProjectCapInput[],
  spentById: ReadonlyMap<string, number>,
): { name: string; spent: number; cap: number } | null {
  let nejlepsi: { name: string; spent: number; cap: number } | null = null;
  let max = -1;
  for (const p of projects) {
    if (p.status !== "active" && p.status !== "budget_hold") continue;
    const cap = Number(p.daily_cap_usd);
    if (!Number.isFinite(cap) || cap <= 0) continue;
    const spent = spentById.get(p.id) ?? 0;
    const ratio = Math.max(0, spent / cap);
    if (ratio > max) {
      max = ratio;
      nejlepsi = { name: p.name, spent, cap };
    }
  }
  return nejlepsi;
}

/** Klíč vrstvy, která je stropu nejblíž (nejvyšší poměr). Při shodě vyhrává dřívější = vazba výš. */
export function nearestCapKey(layers: CapLayer[]): CapLayer["key"] | null {
  let nejlepsi: CapLayer["key"] | null = null;
  let max = -1;
  for (const l of layers) {
    const r = layerRatio(l);
    if (r === null) continue;
    if (r > max) {
      max = r;
      nejlepsi = l.key;
    }
  }
  return nejlepsi;
}
