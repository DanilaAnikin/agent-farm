# AgentFarm — Overview

> Multi-user farma AI agentů, která běží 24/7. Každý uživatel má své **projekty** — jeden na každou věc (content pro Instagram, web appka, …). V každém projektu pracují **jeho vlastní agenti**, kteří se mezi projekty nikdy nekříží: manager rozpadá přání na úkoly, workeři je plní, judge ověřuje kvalitu — a když je backlog prázdný, manager sám generuje další vylepšení. Farma se nikdy nezastaví sama; zastaví ji jen uživatel. Umí stavět a nasazovat aplikace, generovat video/obrázky/hudbu, publikovat na Instagram a všechno ostatní dát ke stažení do Content Library.

- **Stav:** návrh (v2) — 2026-07-04 (v2: multi-user, projekty jako top-level, zapracován adversarial review)
- **Stack:** TypeScript, Next.js 16, Supabase (Postgres + pgmq + Storage + Realtime + Auth + RLS), opencode, Docker + gVisor, Hetzner VPS
- **Modely:** LLM výhradně čínské — DeepSeek V4, GLM 4.7/5.2, Kimi K2.6, Qwen-VL (žádný Anthropic/OpenAI). Jediná deklarovaná výjimka: přepis hlasu dělá Whisper large-v3 (open-source váhy) hostovaný na Groq — teče tam jen audio přání, nikdy kód ani prompty agentů.
- **Jazyk:** dokumentace česky; prompty, handoff soubory a kód anglicky (čínské modely jsou na angličtině spolehlivější)

---

## 1. Vize

1. Uživatel se přihlásí do dashboardu, otevře svůj projekt (nebo založí nový) a napíše či namluví přání — „přidej dark mode", „vyrob 5 reelů o AI nástrojích".
2. Manager projektu přání převede na specifikaci, uživatel ji jedním klikem potvrdí (nebo má zapnutý trust mode), a agenti začnou pracovat. Vše je vidět živě: kdo na čem dělá, co prošlo, kolik to stojí.
3. Nevratné akce (publikace na Instagram, produkční deploy, navýšení rozpočtu) chodí jako **schválení na jedno ťuknutí** (dashboard nebo Telegram).
4. Když je backlog projektu prázdný, manager vygeneruje další kolo vylepšení. Smyčka se **nikdy nezastaví sama** — jen uživatelův pokyn (pause/stop) ji zastaví; rozpočtové stropy ji umí pozdržet (`budget_hold`), ale po resetu okna sama pokračuje.
5. Uživatel smyčku průběžně **řídí poznámkami manažerovi** („teď se soustřeď na výkon", „přestaň refactorovat, přidávej featury") — bez zastavování.

## 2. Doménový model: Uživatelé → Projekty → Přání → Úkoly

```
Uživatel (role: admin | member; registrace jen na pozvánku)
 ├─ Globální profil: tón hlasu, designový vkus, brand (barvy, fonty), jazyk, do/don't
 │   → čtou ho VŠECHNY projekty tohoto uživatele (jednotný styl napříč projekty)
 └─ Projekty — zapečetěné jednotky, jeden na každou věc
     ├─ kind: code (web appka, CLI, …) | content (IG kanál, série reelů) | mixed
     ├─ vlastní: agenti, workspace volume, git repo, rozpočty, Library sekce, backlog
     └─ Přání (wishes) — jednotlivé požadavky uživatele do projektu
         └─ Úkoly (tasks) → Pokusy (attempts) → Review (judge)
```

**Garance izolace mezi projekty** (i mezi projekty téhož uživatele):

| Vrstva | Mechanismus |
|---|---|
| Filesystem | Každý projekt má vlastní workspace volume; worker kontejner mountuje **jen** volume svého projektu |
| Agenti | Worker kontejner je při spawnu svázán s jedním projektem (label `project_id`) a po celý život pracuje jen pro něj; manager i judge dostávají do kontextu výhradně stav svého projektu |
| Peníze | Rozpočty a `cost_ledger` per projekt (a per uživatel); LiteLLM virtuální klíče nesou `user_id + project_id` |
| Data | RLS na všech tabulkách (user-scope); storage cesty `users/{user_id}/projects/{project_id}/…` |
| Znalosti | Handoff soubory (`.farm/`) žijí v repu projektu; jediná sdílená věc je globální profil uživatele (read-only, injektuje se do manager/media promptů) |

**Multi-tenant:** farma je od začátku pro více uživatelů. Registrace jen na pozvánku od admina (ty). Každý uživatel: vlastní projekty, vlastní denní stropy (nastavuje admin), vlastní připojení Instagramu, GitHubu a Telegramu. Platby/účtování mezi uživateli **nejsou** ve v1 — admin přiděluje kvóty ručně (viz non-goals).

## 3. Základní principy

1. **Always-resumable, ne always-running.** Nekonečnost = samodoplňující se fronta (refill), ne věčná session. Každý běh agenta je krátký s čerstvým kontextem; stav žije v gitu a Postgresu, nikdy v kontextovém okně.
2. **Guardraily mimo dosah agentů.** Stropy vynucuje LLM proxy a deterministický kód (media gate, refill dedup) — nikdy jen prompt. Kill switch čte orchestrátor před každým krokem.
3. **Least privilege.** Worker dostane jen: worktree svého projektu, sandboxovaný shell (gVisor) a per-attempt LLM klíč. Externí tokeny (Instagram, GitHub, Dokploy) drží výhradně Publisher/orchestrátor; workeři podávají žádosti.
4. **Nikdo si neznámkuje vlastní práci.** Judge z jiné modelové rodiny + build/testy v čistém kontejneru + mechanická ráčna na testy i konfiguraci harnessu.
5. **Všechno se počítá.** Každé volání modelu i každá media generace → řádek v `cost_ledger` s `user_id/project_id/task_id`.
6. **Projekty se nekříží.** Viz §2 — izolace je vlastnost architektury (volumes, labely, klíče, RLS), ne konvence.

## 4. Architektura

```
┌────────────────────────── UŽIVATELÉ (multi-tenant) ────────────────────────┐
│  Dashboard (Next.js)                       Telegram bot (grammY)           │
│  projekty · přání · schvalování ·          párování per user · hlasová     │
│  Library · náklady · profil · admin        přání · schvalování · alerty    │
└──────────────┬──────────────────────────────────────┬──────────────────────┘
               │ supabase-js (Auth/RLS/Realtime/       │ Bot API (long-poll)
               │ Storage)                              │
               ▼                                       ▼
┌────────────────── SUPABASE (cloud, dedikovaný projekt farmy) ──────────────┐
│  Postgres (RLS): users/profiles · projects · wishes · specs · tasks ·      │
│    attempts · reviews · approvals · cost_ledger · media_assets ·           │
│    publish_requests · agents · events · farm_settings · connections        │
│  pgmq: q_tasks · q_judge · q_media · q_publish    Storage: media bucket    │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │ service-role (jen backend služby na VPS)
               ▼
┌────────────────────── FARM VPS (Hetzner CX53, Docker) ─────────────────────┐
│  ORCHESTRÁTOR (jediný drží docker.sock přes socket-proxy a GitHub tokeny)  │
│   ├─ per-project manager loop + refill (s mechanickými guardy)             │
│   ├─ dispatch: fresh opencode session + worktree per task (per-project     │
│   │   worker kontejnery, gVisor)                                           │
│   ├─ judge runner (gVisor sibling kontejnery, merge lock per repo)         │
│   ├─ reconciliation (crash recovery) · guardrails · farm_settings→LiteLLM  │
│   └─ STT servis (audio ze Storage → Groq Whisper → přepis)                 │
│  LLM PROXY (LiteLLM): per-attempt ephemeral klíče · denní stropy per       │
│   user/projekt/farma · shadow pricing GLM plánu · cost_ledger callback     │
│  MEDIA PIPELINE: fal.ai · ElevenLabs · Remotion/FFmpeg · media budget gate │
│  PUBLISHER: IG tokeny per user · Dokploy API · approval enforcement        │
│  FARM DOKPLOY (preview deploye agentích aplikací — nikdy produkční VPS)    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 5. Komponenty

### 5.1 Databáze (Supabase — nový dedikovaný projekt, RLS všude)

| Tabulka | Účel | Klíčové sloupce |
|---|---|---|
| `profiles` | Uživatel + globální profil | `user_id (auth.users), role (admin/member), display_name, preference_profile (jsonb: tone, style, brand, language, dos/donts), daily_cap_usd, daily_media_cap_usd, telegram_chat_id` |
| `invites` | Pozvánky | `id, email, invited_by, used_at` |
| `connections` | Per-user připojení externích služeb | `id, user_id, kind (github/instagram/telegram), encrypted_credentials, status, meta (jsonb)` — šifrované, čte jen service-role (orchestrátor/Publisher), nikdy workeři |
| `projects` | Top-level jednotka práce | `id, user_id, name, kind (code/content/mixed), repo_mode (new/existing/none), repo_url, env_recipe (jsonb), status (active/paused/stopped/budget_hold), monthly_budget_usd, daily_cap_usd, manager_note, trust_mode (bool), created_at` |
| `wishes` | Požadavky uživatele do projektu | `id, project_id, title, description, source (dashboard/telegram/voice), status (new/specifying/awaiting_spec_approval/active/done/parked), budget_usd, spent_usd` |
| `specs` | Verzované specifikace | `id, wish_id, version, content_md, acceptance_criteria (jsonb), approved_at` |
| `tasks` | Atomické úkoly s done-condition | `id, project_id, wish_id, kind (code/media/publish/deploy), title, description, done_condition, status (queued/running/judging/done/failed/parked), priority, attempts_count, max_attempts (3), dedup_key` |
| `attempts` | Jeden běh workera | `id, task_id, agent_id, model, opencode_session_id, msg_id (pgmq — idempotence), worktree_ref, branch, status, steps_used, wall_ms, cost_usd, diff_stat, output_summary, heartbeat_at` |
| `reviews` | Verdikt judge | `id, attempt_id, judge_model, verdict (approve/reject/escalate), checks (jsonb: build/tests/lint/config_ratchet/ui_smoke), reasons, screenshot_path` |
| `approvals` | Schvalovací brána | `id, user_id, project_id, type (spec/publish/deploy_prod/budget/config_change), payload, status (pending/approved/rejected/expired), decided_via, expires_at (24h)` |
| `cost_ledger` | Každé utracené $ | `id, ts, user_id, project_id, scope (task/attempt/media/system), ref_id, provider, model, tokens_in/out/cached, cost_usd, is_shadow (bool — GLM paušál)` |
| `media_assets` | Content Library | `id, project_id, wish_id, task_id, kind, storage_path, mime, size_bytes, duration_s, meta (jsonb: prompt, model, vlm_check, user_rating), status, cost_usd, idempotency_key` |
| `publish_requests` | Publikace | `id, media_asset_id, target (instagram/manual), caption, status, approval_id, external_id, published_at` |
| `agents` | Registr běžících agentů | `id, project_id, role, model, container_id, status (idle/busy/dead), current_task_id, last_heartbeat` |
| `events` | Append-only timeline | `id, ts, project_id, wish_id, task_id, agent_id, level, type, message, data` |
| `farm_settings` | Globální konfigurace (admin) | `key, value` — `global_pause`, `farm_daily_cap_usd`, `farm_daily_media_cap_usd`, `max_workers_total`, … |

- **RLS:** každý uživatel vidí jen své řádky (přes `user_id`, resp. join přes `projects`). Admin vidí vše. Backend služby používají service-role a **vždy** filtrují podle id z queue zpráv.
- **Fronty:** pgmq `q_tasks`, `q_judge`, `q_media`, `q_publish`; visibility timeout **40 min** (> max wall-clock pokusu 30 min → žádný double-dispatch). Konzumenti = long-running Node procesy na VPS (nikdy Edge Functions, 150s limit).

### 5.2 Orchestrátor (`apps/orchestrator`)

- **Manager loop (per projekt).** Wish `new` → spec + akceptační kritéria (structured output) → **spec approval**: uživateli se zobrazí editovatelná spec k potvrzení (dashboard/Telegram); projekt s `trust_mode=true` tento krok přeskakuje. Po schválení rozpad na tasky, každý s explicitní done-condition — schéma structured outputu vágní task nepustí.
- **Refill loop (per projekt) — jádro nekonečnosti.** Projekt `active`, žádné `queued/running` tasky a žádná otevřená přání → manager dostane stav repa/kanálu + `manager_note` od uživatele (priorita č. 1) + kurátorský checklist (testy → edge-cases → výkon → UX → refactoring → dokumentace → backlog) → další dávka (max 5 tasků). **Mechanické guardy mimo prompt:** (a) dedup — `dedup_key` (normalizovaný title+done_condition, trigram similarity ≥ 0.85) nového tasku se porovná proti parked/failed taskům projektu; shoda → task se nezaloží, jen event; (b) max 6 refill kol / projekt / den; (c) parked task smí znovu otevřít jen člověk.
- **Worker dispatch.** Task z `q_tasks` → worker kontejner projektu (spawn on-demand, label `project_id`, mount jen volume projektu) → git worktree + branch `farm/task-{id}` → fresh opencode session (`@opencode-ai/sdk`) s per-attempt LLM klíčem → SSE eventy do `events` → po skončení commit (lokálně), update `.farm/progress.md`, kill session, `attempts` řádek → `q_judge`. Idempotence: attempt se zakládá per `(task_id, msg_id)` — redelivery nevytvoří duplikát.
- **Git servis.** Orchestrátor je **jediný**, kdo mluví s GitHubem: per-user fine-grained PAT z `connections` (šifrovaný), zakládá repa (nové projekty), fetch/push, otevírá PR. Workeři mají jen lokální worktree — git egress v allowlistu workera **není**.
- **Reconciliation (crash recovery).** Při startu a pak každých 5 min: attempts s mrtvým heartbeatem (> 3 min) → `failed` (bez férové penalizace: pokus přerušený infrastrukturou neinkrementuje `attempts_count`); orphaned sessions kill; worktree prune; `tasks.status` srovnat s frontou.
- **STT servis.** Dashboard/Telegram nahrají audio do Storage → orchestrátor přepíše přes Groq Whisper → přepis do wish draftu (Realtime). Groq klíč drží jen orchestrátor.
- **Sync nastavení.** Změny stropů (`farm_settings`, `profiles`, `projects`) sleduje přes Realtime a propisuje do LiteLLM admin API (privátní síť).

### 5.3 Worker runtime (opencode)

- Image: opencode + git + node + pnpm. Kontejnery **per projekt**, spawn on-demand, zánik při idle. **SWARM: N workerů běží SOUČASNĚ** (`max_workers_total` = počet paralelních dispatch slotů; každý čte z `q_tasks` přes `FOR UPDATE SKIP LOCKED`, takže bez race). Paralelně můžou stavět i úkoly téhož repa — serializuje se jen merge (rebase-onto-main, viz §5.5).
- **gVisor (runsc)** pro workery, judge i build kontejnery — LLM kód je nepřátelský. gVisor neumí nested Docker → buildy jedou v sibling kontejnerech, které spouští orchestrátor (jediný s přístupem k docker.sock, a to přes socket-proxy omezenou na run/kill labelovaných imagů).
- Egress allowlist workera: **jen LiteLLM proxy a npm registry.** Žádný GitHub, žádný Supabase, žádný internet.
- Session žije jen po dobu tasku: limit 50 kroků / 30 min. Handoff výhradně přes `.farm/` soubory v repu + DB.

### 5.4 LLM Proxy (LiteLLM)

- **Per-attempt ephemeral klíče:** orchestrátor před dispatchem vytvoří přes admin API klíč s `max_budget` (default $0.50) a expirací 35 min, injektuje do session, po skončení revokuje. Role klíče (manager/judge/misc) mají vlastní stropy.
- **Vrstvené denní stropy:** farma ($15) → uživatel (default $5, nastavuje admin) → projekt (default $3). Vynucené na proxy.
- **`budget_hold`, ne pauza.** Odmítnutí kvůli stropu (429/budget error) se **nepočítá jako selhání tasku** (neinkrementuje circuit breaker) — projekt/uživatel přejde do `budget_hold` a orchestrátor ho **automaticky obnoví při resetu okna (00:00 UTC)**. Telegram notifikace při holdu i obnovení. Farma se tedy sama nikdy trvale nezastaví — jen ji zdrží strop, který si uživatel/admin sám nastavil.
- **Shadow pricing GLM paušálu:** traffic přes GLM Coding Plan se v `cost_ledger` účtuje imputovanou cenou za token (`is_shadow=true`, list price GLM API), takže denní stropy a statistiky zůstávají smysluplné i pro paušál; navíc requests/den limit na plan route.
- Failover: GLM plan → DeepSeek V4 Flash pay-as-you-go (vyčerpaná kvóta plánu nesmí farmu zastavit).
- Ověřeno musí být (Fáze 0): GLM Coding Plan funguje **skrz** LiteLLM (anthropic passthrough, kvóta, auth) — jinak fallback plán: workeři na Z.ai přímo + orchestrátor-side cost polling.

### 5.5 Judge

1. **Bezpečný swarm merge** (per-repo zámek + **rebase-onto-main**): worker větev se rebasne na aktuální main → fast-forward merge; konflikt (jiný paralelní worker mezitím změnil main) = reject s kontextem, úkol se vrátí workerovi k rebasu. Tak může stavět N workerů paralelně a slévá se bez rozbití repa.
2. Čistý **gVisor** sibling kontejner (stejný egress allowlist jako worker, `--ignore-scripts` kde lze): `pnpm install && build && test && lint` na branchi. Výsledky si vytahuje orchestrátor, kontejner nikam nepushuje.
3. **Mechanická config ráčna (deterministický kód, ne prompt):** diff proti main na chráněné množině — `package.json` (scripts), lockfiles, `tsconfig*`, lint/test konfigurace, CI soubory, `.farm/`, `.opencode/` → jakákoliv změna = automatická eskalace na člověka (approval `config_change`). Worker si nemůže přepsat harness, kterým je souzen. Ráčna na testy: smazané/oslabené test soubory = reject.
4. LLM review diffu (**Kimi K2.6** — jiná rodina než worker, málo output tokenů) proti done-condition a spec.
5. **UI smoke (pro UI tasky):** aplikaci v kontejneru spustit, klíčové routes (HTTP 200 / Playwright smoke), screenshot → `reviews.screenshot_path` → timeline v dashboardu.
6. Verdikt: `approve` → merge (orchestrátor) + task `done` · `reject` → task zpět s feedbackem (≤ 3 pokusy) · `escalate`/3. fail → `parked` + notifikace.

### 5.6 Publisher (`apps/publisher`)

Jediný proces s přístupem k publikačním tokenům. Bezpečnostní hranice.

- Konzumuje `q_publish`; **každá publikace a každý produkční deploy** vyžaduje `approved` řádek v `approvals` (expirace 24 h). Bez schválení technicky neodejde nic.
- **Instagram (per user):** každý uživatel připojí vlastní IG Creator/Business účet přes **vlastní Meta app v Development módu** (průvodce v dashboardu; bez Meta review — dev-mode app smí publikovat na účty vlastníka appky). Alternativa do budoucna: jedna farm appka s Meta App Review (2–6 týdnů) — pak odpadne setup per user. Publikace: 3-krokový container flow (create → poll `FINISHED` → publish), Reels/foto/carousel; `content_publishing_limit` se čte za běhu; self-imposed max 3 posty/den/účet; AI-content disclosure povinně.
- **Deploy — dvě úrovně:** (a) **Preview** na **farm Dokploy** (instance na farm VPS) — automatický, bez approvalu, každé code přání má preview subdoménu; (b) **Produkce** na produkční Dokploy uživatele — vždy approval `deploy_prod`, health check, automatický rollback při failu. Agentí kód nikdy neběží na produkčním boxu bez explicitního lidského schválení.

### 5.7 Media pipeline (`apps/media-pipeline`)

| Co | Čím | Cena (07/2026) |
|---|---|---|
| Video klipy | Seedance 2.0 přes fal.ai (workhorse), Hailuo 2.3 Fast (B-roll), Kling 3.0 jen schválené hero záběry | ~$0.15–0.26 / 5s |
| Obrázky | Seedream 4.x (volume), Nano Banana 2 (text v obraze, konzistence postav) | $0.02–0.07 / ks |
| Hudba | ElevenLabs Music API (licencovaná data, čistá komerční práva); později self-host ACE-Step 1.5 | $0.15 / min |
| Voiceover | Kokoro self-host (zdarma), fallback Fish Audio | $0 / $15 za 1M zn. |
| Střih | Remotion + FFmpeg; titulky whisper.cpp | $0 |
| Kvalitní check | VLM: **GLM-4.7V (Z.ai)**, fallback Qwen3-VL — rozlišení, artefakty, čitelnost textu; verdikt do `media_assets.meta.vlm_check` (přes LiteLLM → cost_ledger) | ~$0.01 / check |

- **Media budget gate (deterministický kód):** před **každým** placeným API voláním se čte `SUM(cost_ledger)` — vrstvené stropy: farma/den → uživatel/den (`daily_media_cap_usd`) → projekt/wish. Překročení → `budget_hold` (auto-resume při resetu), žádné další volání. Media výdaje se počítají do stejného denního totalu, který hlídá dashboard.
- **Idempotence drahých jobů:** `idempotency_key` (task_id + scene hash) se kontroluje proti `media_assets` před voláním fal.ai — pgmq redelivery po crashi negeneruje (a neplatí) dvakrát.
- Suno nemá oficiální API (wrappery porušují ToS) a Udio je bez exportu — nepoužíváme. Retry multiplikátor 1.5–2× je započítán ve stropech. Higgsfield (`higgsfield-js`) jako sekundární cesta — ověřit, že tarif zahrnuje API.

### 5.8 Content Library a storage

- Supabase Storage, cesty `users/{user_id}/projects/{project_id}/{asset_id}.{ext}`; abstrakce `StorageAdapter` (`packages/storage`) → přepnutí na MinIO na VPS bez zásahu do kódu, až objem přeroste Supabase Pro (100 GB).
- Library je **per projekt**: grid s přehrávači a náhledy, filtry, detail s promptem/modelem/cenou/VLM verdiktem, hodnocení 👍/👎 (signál pro výběr modelů).
- Akce: ⬇︎ **Stáhnout** (signed URL 24 h) · **Publikovat na Instagram** (→ approval) · **Označit jako použité** (kam bylo ručně nahráno) · **Archivovat** · hromadný ZIP výběru (streamuje route handler dashboardu).
- Tím je pokryto „postovat kamkoliv jinam": farma vyrobí hotový reel, uživatel si ho stáhne a nahraje na YouTube/TikTok/kamkoliv ručně — žádné API audity, žádné riziko banu.

### 5.9 Dashboard (`apps/dashboard`) — Next.js 16

**Next.js 16 App Router, Tailwind v4, shadcn/ui, Supabase Auth (invite-only) + RLS, Realtime, Recharts.** Tmavý „mission control" vzhled. Deploy: farm VPS (Dokploy/Traefik, HTTPS) nebo Vercel — dashboard mluví se Supabase + drží jen dva vlastní server-side úkony (ZIP streaming; nic víc — STT jde přes Storage a orchestrátor).

| Stránka | Obsah |
|---|---|
| `/projects` | **Domovská stránka**: karty projektů (stav, dnešní útrata, běžící agenti, poslední event), tlačítko Nový projekt (wizard: název, typ, repo new/existing/none, env recipe, rozpočty, trust mode) |
| `/projects/[id]` | **Mission Control projektu**: živí agenti, fronta, přání, poslední eventy, útrata vs. stropy, PAUSE/RESUME projektu, **pole „poznámka manažerovi"** (vstupuje do příštího refill promptu) |
| `/projects/[id]/wishes/[wishId]` | Spec (verze, **approval krok s editací**), strom tasků, timeline, živý stream agenta, parked tasky s plným kontextem (všechny pokusy + verdikty + reasons + diff_stat) a akcemi retry-s-poznámkou / zrušit |
| `/projects/[id]/library` | Content Library projektu (§5.8) |
| **Nové přání** (v projektu) | **Type-aware formulář:** code → repo/branch výběr; content → téma, počet kusů, styl, hudební nálada, cílový účet; + 🎤 hlas (MediaRecorder → Storage → orchestrátor STT → editovatelný přepis) + **šablony přání** (postav appku / vylepšuj existující / série reelů) |
| `/approvals` | Fronta schválení napříč projekty s náhledy (spec text, video + caption, deploy diff) — Approve/Reject |
| `/costs` | Grafy per den/projekt/model/provider (shadow spend odlišen), ledger, editace stropů |
| `/settings` | **Profil** (globální preference — tón, styl, brand), připojení (GitHub PAT, Instagram průvodce, Telegram párovací kód), notifikace |
| `/admin` (jen admin) | Uživatelé + pozvánky, per-user stropy, farm stropy, registr agentů, global kill switch, zdraví služeb |

UX standardy: empty states s CTA (první projekt / první přání ze šablony), first-run checklist karta (klíče OK, Telegram spárován, stropy nastaveny), **Library a Approvals plně responzivní** (reálně se používají z mobilu). Živé eventy do ~2 s (Realtime broadcast, throttling 1 s).

### 5.10 Telegram bot (`apps/telegram-bot`)

- Párování per user: kód vygenerovaný v `/settings` → `/start <kód>`. Všechny příkazy scoped na projekty daného uživatele.
- Přání textem i hlasovkou (audio → Storage → orchestrátor STT), výběr projektu inline tlačítky.
- Schvalování (spec/publish/deploy) inline ✅/❌ s náhledem; alerty (parked, budget_hold + auto-resume, circuit breaker, denní digest).
- Příkazy: `/status`, `/pause <projekt>`, `/resume <projekt>`, `/budget <projekt> <usd>`, `/note <projekt> <text>` (poznámka manažerovi), `/kill` = global_pause + okamžitý abort všech běžících sessions (jen admin).

## 6. Modely a routing

| Role | Model | Endpoint | Cena | Poznámka |
|---|---|---|---|---|
| Manager | `deepseek-v4-pro` (thinking) | nativní DeepSeek API přes LiteLLM | $0.435/$0.87 za 1M | cache hity $0.0036 — opakovaný plánovací kontext skoro zdarma |
| Worker — primární | GLM Coding Plan Pro: `glm-4.7` default, `glm-5.2` těžké tasky (2–3× kvóta) | Z.ai anthropic passthrough přes LiteLLM | paušál $30/měs (**shadow pricing** v ledgeru) | ověřit průchod LiteLLM ve Fázi 0 |
| Worker — fallback (vždy zapojen) | `deepseek-v4-flash` | nativní přes LiteLLM | $0.14/$0.28 za 1M | kvóta plánu nesmí farmu zastavit; ToS paušálů cílí na headless farmy |
| Judge | `kimi-k2.6` | Moonshot přes LiteLLM | $0.95/$4.00 za 1M | jiná rodina než worker |
| Media VLM check | `glm-4.7v` (fallback Qwen3-VL) | Z.ai / DashScope přes LiteLLM | ~$0.01/check | ověřit dostupnost ve Fázi 4 |
| Levné pomocné | `deepseek-v4-flash` | — | — | sumarizace, captions, commit messages |
| STT (výjimka, ne LLM) | Whisper large-v3 (open-source váhy) | Groq | ~$0.0006/min | jen audio přání; klíč drží orchestrátor |

**Kritické:** aliasy `deepseek-chat`/`deepseek-reasoner` umírají **2026-07-24** — všude `deepseek-v4-*`. Routing/failover je LiteLLM config, ne kód.

## 7. Stavové stroje (kanonické přechody)

**Projekt:** `active ⇄ paused` (uživatel) · `active → budget_hold → active` (strop → auto-resume při resetu) · `→ stopped` (uživatel, terminální).

**Wish:** `new → specifying → awaiting_spec_approval → active → done` · spec zamítnuta → `specifying` (nová verze) · `active → parked` (opakovaná selhání) · trust_mode přeskakuje approval krok.

**Task:** `queued → running → judging → done` · `judging → queued` (reject, `attempts_count < 3`) · `→ parked` (3. fail nebo escalate; znovu otevře jen člověk) · pokus zabitý infrastrukturou (crash/reconciliation) → `queued` **bez** inkrementu `attempts_count`.

**Budget odmítnutí ≠ selhání:** 429/budget z proxy neinkrementuje žádný failure counter — vede na `budget_hold` příslušné úrovně (projekt/uživatel/farma).

## 8. Guardraily a bezpečnost

| Vrstva | Mechanismus | Default |
|---|---|---|
| Peníze — LLM | Vrstvené denní stropy na LiteLLM: farma → uživatel → projekt; per-attempt ephemeral klíč $0.50/35 min | farma $15, user $5, projekt $3 |
| Peníze — média | Media budget gate v pipeline (deterministický kód, čte cost_ledger před každým voláním): farma/user/projekt/wish | farma $10/den, user $5/den |
| Peníze — paušál | Shadow pricing GLM plan traffic + requests/den limit plan routy | zapnuto |
| Strop dosažen | `budget_hold` + **auto-resume při 00:00 UTC** + notifikace; nikdy nekazí failure countery | zapnuto |
| Smyčky | Loop detection: normalizovaný diff + závěrečná zpráva pokusu, trigram similarity ≥ 0.9 proti všem předchozím pokusům tasku → halt | zapnuto |
| Smyčky | Circuit breaker: 3 selhání tasku → parked; 5 selhání v projektu/den → projekt paused + alert | zapnuto |
| Refill | Mechanický dedup (`dedup_key`, similarity ≥ 0.85 proti parked/failed) · max 6 kol/projekt/den · parked otevírá jen člověk | zapnuto |
| Běh | 50 kroků / 30 min / pokus; max 3 pokusy; pgmq visibility 40 min | zapnuto |
| Kill switch | `global_pause` (admin) + per-projekt pause; orchestrátor čte před každým dispatch; `/kill` = pause + abort sessions | dashboard + Telegram |
| Izolace | gVisor pro workery **i judge/build** kontejnery; egress allowlist (proxy + npm; bez GitHubu); docker.sock jen orchestrátor přes socket-proxy; opencode port jen privátní síť | vždy |
| Credentials | `connections` šifrované, čte jen service-role; workeři nikdy nedrží externí tokeny; Git ops jen orchestrátor; publikace/prod-deploy jen Publisher po approvalu | vždy |
| Harness | Config ráčna: chráněné soubory (package.json scripts, lockfiles, tsconfig, lint/test config, CI, `.farm/`, `.opencode/`) → změna = eskalace | vždy |
| Publikace | Approval na každý post a prod deploy; AI disclosure; ≤ 3 posty/den/účet; `content_publishing_limit` za běhu | vždy |
| Multi-tenant | RLS všude; cross-user přístup testován automatizovaně; worker volume mount jen vlastní projekt | vždy |
| Data | Kód a prompty tečou na čínské endpointy — vědomé rozhodnutí, uživatelé o něm musí vědět (poučení při registraci). Farma nikdy nedostane produkční credentials (viz §9 existing-repo politika) | poznamenáno |

## 9. Práce s existujícím repem (politika)

Přání typu „vylepšuj moji existující appku":

1. Farma pracuje **na branchi/forku a otevírá PR** — nikdy nemerguje přímo do main cizího repa; merge PR je lidská akce (nebo approval-gated).
2. Projekt musí mít **env recipe**: deklarovaný způsob, jak appku spustit bez produkčních credentials (`.env.example` + `supabase start`/mocky/seed). Manager recipe ověří před vytvořením tasků; bez funkčního testovacího prostředí se wish zaparkuje s vysvětlením.
3. Produkční tajemství do farmy nikdy nevstupují — deploy na produkci dělá Publisher přes Dokploy API po approvalu, env vars zadává uživatel přímo v Dokploy.

## 10. Publikování a Library — flow

```
media task → pipeline (budget gate → generace → VLM check) → asset ve Storage
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
   „Publikovat na Instagram“                   „Stáhnout lokálně“
   publish_request → approval                  signed URL / ZIP z Library
   → Publisher → Graph API (user token)        → uživatel nahraje kamkoliv
   → published + permalink                     → označí kam (evidence)
```

TikTok/YouTube API: vědomě odloženo (auditní procesy) — Library pokrývá ruční cestu. YouTube compliance audit lze podat kdykoliv později a přidat `target=youtube`.

## 11. Infrastruktura a deployment

- **Farm VPS:** Hetzner CX53 (16 vCPU/32 GB/~360 GB, ~€30/měs). Kapacita ~4–6 souběžných workerů. **Ne produkční Dokploy VPS.**
- **Stack:** Docker Compose (`infra/compose/`): orchestrator, publisher, media-pipeline, telegram-bot, litellm, farm-dokploy (preview deploye), worker pool on-demand. **Image verze pinované** — updaty ručně v rámci kvartální revize (žádný watchtower; auto-update pod 24/7 farmou je zbytečný výpadkový vektor).
- **Dashboard:** farm VPS (HTTPS, doména + wildcard DNS pro preview subdomény) nebo Vercel.
- **Zálohy:** Supabase PITR; všechna repa projektů pushovaná na GitHub (privátní) orchestrátorem; `infra/` = infrastructure as code.
- **Škálování:** víc workerů → GLM Max ($80) nebo mix plan+flash; tvrdší izolace → Hetzner auction dedicated (real KVM → Firecracker) beze změny architektury; storage → MinIO.

## 12. Náklady (odhad 07/2026, poctivě včetně retry)

| Položka | Start (1 uživatel, 1 reel/den) | Plný provoz (3–5 uživatelů, ~5 reelů/den) |
|---|---|---|
| Farm VPS (CX53) | €30 | €30–55 (příp. dedicated) |
| Modely — paušál (GLM Pro/Max) | $30 | $80 |
| Modely — pay-as-you-go (manager, judge, fallback) | $10–30 | $50–150 |
| Supabase Pro (nutné od Fáze 5 — média) | $0 → $25 | $25 |
| Média vč. 1.5–2× retry | $70–240 | $350–1200 |
| Groq STT, drobné | ~$1 | ~$5 |
| **Celkem/měs** | **~$150–360** | **~$550–1550** |

Největší páka = objem videa. Kódovací smyčka je levná. Účtování uživatelům není ve v1 — admin řídí kvóty stropy.

## 13. Struktura repozitáře

```
agent-farm/                      # pnpm workspace + turborepo
├── apps/
│   ├── dashboard/               # Next.js 16 (App Router, Tailwind v4, shadcn/ui)
│   ├── orchestrator/            # manager/refill/dispatch/judge/git/reconciliation/STT
│   ├── publisher/               # IG per-user tokeny, Dokploy API, approval enforcement
│   ├── media-pipeline/          # fal.ai, ElevenLabs, Remotion render, budget gate
│   └── telegram-bot/            # grammY, per-user párování
├── packages/
│   ├── db/                      # Drizzle schema, migrace, RLS policies, pgmq helpery
│   ├── core/                    # stavové stroje, guardrail logika, dedup, typy
│   ├── llm/                     # LiteLLM klient, ephemeral klíče, prompt knihovna (EN)
│   └── storage/                 # StorageAdapter (supabase | minio), ZIP
├── infra/
│   ├── docker/                  # worker image, judge-runner, služby
│   ├── compose/                 # docker-compose.farm.yml (pinované verze)
│   └── litellm/                 # config: modely, stropy, shadow pricing, failover
├── OVERVIEW.md
└── PLAN.md
```

## 14. Co vědomě NEděláme (non-goals v1)

- **Účtování/platby mezi uživateli** — admin přiděluje kvóty; billing případně v2.
- **TikTok / YouTube API publikace** — Content Library + ruční upload; audity později.
- **Meta App Review** — v1 každý uživatel vlastní dev-mode Meta app (průvodce); review až kdyby setup per user přestal škálovat.
- **Postiz** — pro jedinou síť zbytečný; vrátí se s druhou sítí.
- **Self-host video modelů (Wan)** — 40–80 GB VRAM; API levnější.
- **Těžké frameworky** (LangGraph, Temporal, claude-flow) — harness vlastníme sami.
- **Suno/Udio** — ToS/licenční miny.
- **Neoficiální automatizace sítí** — riziko banu účtů.
