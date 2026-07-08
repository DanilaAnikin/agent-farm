# AgentFarm — Implementační plán

> Plán vychází z [OVERVIEW.md](OVERVIEW.md) (v2 — multi-user, projekty, zapracovaný review). Fáze jdou po sobě; každá končí měřitelným akceptačním testem včetně **negativních testů pojistek**. Zásada: jádro smyčky dřív než cokoliv hezkého.

- **Stav:** návrh (v2) — 2026-07-04
- Odhady pro režim „ty + Claude". Celkem ~6–8 týdnů do plné vize.

---

## Přehled fází

| Fáze | Co | Odhad | Výstup |
|---|---|---|---|
| 0 | Základy: repo, infra, DB (multi-tenant schema + RLS), LiteLLM | 2–3 dny | živá kostra na VPS |
| 1 | **Jádro smyčky (MVP):** manager → worker → judge → refill + guardraily (běží pod admin účtem, 1 projekt) | build 1–2 týdny + **soak/tuning 3–7 dní** | 48h autonomní běh ✅ |
| 2 | Dashboard: projekty, přání, schvalování, Library skelet, náklady | 6–8 dní | ovládání z prohlížeče |
| 3 | Multi-user: pozvánky, per-user připojení, kvóty, RLS testy | 4–6 dní | druhý uživatel bezpečně |
| 4 | Deploy integrace: farm Dokploy preview + approval-gated produkce | 2–3 dny | přání → běžící appka |
| 5 | Media pipeline + Content Library | ~1 týden | reely ke stažení |
| 6 | Instagram publikace (per-user) | 3–4 dny | schválený post → publikováno |
| 7 | Hardening a škálování | průběžně | 3–4 workeři, alerty, zálohy |

---

## Fáze 0 — Základy (2–3 dny)

**Cíl:** prázdná, ale živá kostra: monorepo, multi-tenant DB, proxy, VPS.

### Úkoly

- [ ] **0.1 Monorepo scaffold:** pnpm workspace + turborepo, TS strict, ESLint+Prettier, struktura dle OVERVIEW §13, privátní GitHub repo.
- [ ] **0.2 Supabase projekt (nový, dedikovaný):** pgmq extension, Storage bucket `media/`, Auth (invite-only konfigurace).
- [ ] **0.3 `packages/db`:** Drizzle schema **všech** tabulek vč. `profiles`, `invites`, `connections`, `projects` (OVERVIEW §5.1); **RLS policies od první migrace** (user-scope, admin výjimka); šifrování `connections.encrypted_credentials` (pgsodium); seed `farm_settings`; pgmq helpery s visibility timeoutem **40 min**.
- [ ] **0.4 Farm VPS:** Hetzner CX53, Docker + compose, **gVisor runsc** (ověřit `docker run --runtime=runsc`), firewall (jen SSH + 443), fail2ban, doména + wildcard DNS (`*.farm.tvojedomena.cz`) pro dashboard a preview apps.
- [ ] **0.5 LiteLLM proxy:** modely `deepseek-v4-pro`, `deepseek-v4-flash`, `glm-4.7`/`glm-5.2` (anthropic passthrough), `kimi-k2.6`; vrstvené denní stropy (farma/user/projekt); admin API pro ephemeral klíče; **shadow pricing GLM plan traffic** (imputovaná list price, `is_shadow` flag v callbacku); failover glm→flash; cost_ledger callback. **Ověřit: GLM Coding Plan reálně funguje skrz LiteLLM (auth, kvóta)** — pokud ne, zdokumentovaný fallback (workeři přímo na Z.ai + orchestrátor-side polling). Žádné `deepseek-chat`/`deepseek-reasoner` aliasy (umírají 2026-07-24).
- [ ] **0.6 Worker image:** opencode + git + node + pnpm; custom agenti + permissions; roundtrip test SDK → session → LiteLLM → GLM i DeepSeek → cost_ledger řádek.
- [ ] **0.7 Compose stack + síťová topologie:** litellm, orchestrator placeholder, farm-dokploy; workeři na privátní síti s egress allowlistem **jen proxy + npm registry** (bez GitHubu — git remote ops dělá orchestrátor); docker.sock jen orchestrátoru přes socket-proxy (run/kill labelovaných imagů); **pinované verze imagů, žádný watchtower**.

### Akceptační kritéria

- `pnpm build` zelené; migrace + RLS aplikované; automatizovaný RLS smoke test (user B nevidí řádky usera A).
- Testovací prompt projde: SDK → opencode → LiteLLM → GLM i DeepSeek → odpověď + cost_ledger (GLM se shadow cenou).
- Worker kontejner pod runsc: `curl` na github.com i supabase.co **selže**, na proxy a npm projde.

### Manuální úkoly (účty a klíče)

- [ ] DeepSeek API klíč (+ ~$10 kredit) · Z.ai GLM Coding Plan Pro · Moonshot API klíč (+ ~$5) · Groq klíč
- [ ] Hetzner CX53 · nový Supabase projekt · doména + wildcard DNS
- [ ] **GitHub fine-grained PAT** (repo create/push — pro admin účet; ostatní uživatelé si vloží svůj ve Fázi 3)
- [ ] Telegram bot přes @BotFather
- [ ] (F4) Dokploy API token na produkčním Dokploy · (F5) fal.ai + ElevenLabs (+ volitelně Fish Audio) · (F5) Supabase Pro upgrade · (F6) IG Creator/Business + Meta dev app · (kdykoliv) ověřit Higgsfield tarif/API

---

## Fáze 1 — Jádro smyčky / MVP (build 1–2 týdny + soak 3–7 dní)

**Cíl:** „Jedno přání, jeden manager, jeden worker, jeden judge, 48 hodin bez zásahu." Běží pod admin účtem s jedním projektem; multi-user UI přijde ve F2/F3, ale schema už je multi-tenant.

### Úkoly

- [ ] **1.1 `packages/core`:** stavové stroje projekt/wish/task/attempt přesně dle OVERVIEW §7 (vč. `budget_hold`, `awaiting_spec_approval`, infra-kill bez inkrementu attempts), guardrail konfigurace, dedup (`dedup_key`, trigram ≥ 0.85).
- [ ] **1.2 `packages/llm`:** LiteLLM klient + **ephemeral per-attempt klíče** (mint s max_budget $0.50/expiry 35 min, revoke po skončení); prompt knihovna (EN, structured output se schema validací a retry): `manager-spec`, `manager-plan` (done-conditions povinné), `manager-refill` (kurátorský checklist + `manager_note` s prioritou), `judge-review`.
- [ ] **1.3 Orchestrátor — manager loop:** wish → spec → **spec approval krok** (approval typu `spec`; `trust_mode` ho přeskočí) → tasky → `q_tasks`. Refill loop s **mechanickými guardy**: dedup proti parked/failed, max 6 kol/projekt/den, parked otevírá jen člověk.
- [ ] **1.4 Orchestrátor — worker dispatch:** per-projekt kontejner (label, mount jen volume projektu) → worktree + branch → fresh session s per-attempt klíčem → SSE do `events` → commit lokálně, `.farm/progress.md`, kill, `attempts` řádek (idempotentně per `(task_id, msg_id)`) → `q_judge`. **Git servis:** všechny remote ops (create repo, fetch, push) dělá orchestrátor s PAT z `connections`.
- [ ] **1.5 Orchestrátor — judge runner:** **gVisor** sibling kontejner (stejný egress allowlist, `--ignore-scripts` kde lze), `install/build/test/lint`; **mechanická config ráčna** (chráněné soubory → automatická eskalace `config_change`); ráčna na testy; LLM review (Kimi) proti done-condition; approve → merge orchestrátorem (v1: max 1 code task per repo — merge lock implicitní); reject ≤ 3× → parked + alert.
- [ ] **1.6 Guardraily:** kontrola `global_pause` + stropů před dispatch; **rozlišení budget 429 od selhání** → `budget_hold` s auto-resume 00:00 UTC + notifikace; circuit breaker (3 task / 5 projekt/den); loop detection (normalizovaný diff + závěrečná zpráva, trigram ≥ 0.9, proti všem předchozím pokusům tasku); limity 50 kroků/30 min; heartbeaty; **reconciliation** při startu + á 5 min (mrtvé heartbeaty, orphaned sessions/worktrees, srovnání s frontou); **sync farm_settings → LiteLLM** (Realtime watch → admin API).
- [ ] **1.7 Telegram bot (MVP):** párování (`/start <kód>`), přání textem + hlasovkou (audio → Storage → orchestrátor STT přes Groq), `/status`, `/pause`, `/resume`, `/budget`, `/note`, **`/kill`** (admin: global_pause + abort sessions), alerty (parked, budget_hold/resume, breaker), inline approval spec.
- [ ] **1.8 Mini-dashboard:** jediná stránka — projekt, přání+tasky se stavy, poslední eventy (Realtime), dnešní útrata (vč. shadow), PAUSE. Hezké ve F2.
- [ ] **1.9 Nasazení + soak:** compose na VPS, restart policies, logy; **soak období: opakované 48h běhy + ladění refill promptů a guardrailů** (počítej 2–4 iterace).

### Akceptační testy (brána do další fáze)

1. **Pozitivní:** „Build a TypeScript CLI todo app with tests" (hlasovkou z Telegramu) → 48 h bez zásahu → zelený build, koherentní commit history, < $10, farma stále běží a refill generuje smysluplná vylepšení (žádné duplikáty parked tasků).
2. **Nemožný úkol:** logicky nesplnitelný test → 3 pokusy → parked → alert → **další refill kolo úkol neresuscituje** (dedup).
3. **Budget:** strop $0.50 → proxy odmítá → projekt `budget_hold` (žádný inkrement failure counterů, žádný crash-loop) → **po resetu okna se farma sama obnoví bez zásahu**.
4. **Harness útok:** ručně vytvořený branch s `"test": "echo ok"` v package.json → config ráčna eskaluje na člověka, judge nepustí.
5. **Crash:** kill -9 orchestrátoru uprostřed pokusu → po restartu reconciliation uklidí, task se znovu rozběhne, `attempts_count` férově, žádný duplicitní attempt.

---

## Fáze 2 — Dashboard (6–8 dní)

**Cíl:** plnohodnotné prostředí dle OVERVIEW §5.9 — projekty jako hlavní navigace.

### Úkoly

- [ ] **2.1 Základ:** Next.js 16, Tailwind v4, shadcn/ui, Supabase Auth + RLS, layout s project switcherem a globálním stavovým pruhem (útrata/strop, pause stav).
- [ ] **2.2 `/projects` + wizard** nového projektu (typ, repo new/existing/none, env recipe pro existing — viz §9 politika, rozpočty, trust mode); empty state s CTA; first-run checklist karta.
- [ ] **2.3 Mission Control projektu:** živí agenti, fronta, přání, eventy, útrata, PAUSE/RESUME, **pole „poznámka manažerovi"**.
- [ ] **2.4 Wish detail:** spec s **approval krokem (editovatelná)**, strom tasků, timeline, živý stream, parked detail (všechny pokusy + verdikty + reasons + diff_stat + screenshot) s retry-s-poznámkou (poznámka se injektuje do dalšího pokusu).
- [ ] **2.5 Nové přání:** type-aware formulář (code/content), 🎤 (MediaRecorder → Storage → STT → editovatelný přepis), **šablony přání** (3 archetypy).
- [ ] **2.6 `/approvals`** s náhledy (spec, později video+caption, deploy) — responzivní (mobil).
- [ ] **2.7 `/costs`:** grafy (shadow odlišen), ledger s filtry, editace stropů (zapisuje do DB; orchestrátor syncuje do LiteLLM — viz 1.6).
- [ ] **2.8 `/settings`:** profil (globální preference — tón/styl/brand; injektuje se do manager/media promptů), připojení GitHub PAT, Telegram párovací kód.
- [ ] **2.9 Deploy dashboardu** (farm VPS/Vercel) za HTTPS.

### Akceptační kritéria

- Celý cyklus (založení projektu → přání hlasem → schválení spec → sledování → parked rozhodnutí → pause/resume) čistě z dashboardu.
- Event v UI do ~2 s; empty states všude; Approvals použitelné z mobilu.
- Poznámka manažerovi prokazatelně změní obsah dalšího refill kola.

---

## Fáze 3 — Multi-user (4–6 dní)

**Cíl:** druhý reálný uživatel může bezpečně používat farmu.

### Úkoly

- [ ] **3.1 Pozvánky + onboarding:** admin vytvoří pozvánku → registrace → poučení o datovém toku (čínské endpointy) → first-run checklist (GitHub PAT, Telegram, stropy).
- [ ] **3.2 `/admin`:** správa uživatelů a pozvánek, per-user stropy (LLM + media), farm stropy, registr agentů napříč uživateli, global kill, zdraví služeb.
- [ ] **3.3 Per-user credentials end-to-end:** GitHub PAT v `connections` (šifrovaně) → orchestrátor git ops per user; Telegram párování per user; per-user LiteLLM klíče a stropy.
- [ ] **3.4 Kvóty a fair-share:** `max_workers_total` + per-user max souběžných workerů; fronta férově střídá projekty (round-robin per user).
- [ ] **3.5 Bezpečnostní testy multi-tenancy:** automatizované RLS testy na každou tabulku (CI); test mount izolace (worker projektu A nevidí volume B); pokus o cross-user approval selže.

### Akceptační kritéria

- Testovací druhý účet: založí projekt, pustí wish, vidí jen svá data (automatizovaný důkaz), jeho worker běží v izolaci, jeho útrata jde za ním.
- Admin vidí vše, umí měnit stropy za běhu (sync do LiteLLM ověřen).

---

## Fáze 4 — Deploy integrace (2–3 dny)

**Cíl:** code přání končí běžící aplikací.

### Úkoly

- [ ] **4.1 Farm Dokploy:** instance na farm VPS; **preview deploye automaticky bez approvalu** (subdoména per přání) — na farm boxu, nikdy na produkci.
- [ ] **4.2 Produkce:** Publisher + Dokploy API produkčního boxu uživatele; **vždy approval `deploy_prod`**; health check; auto-rollback při failu; env vars zadává uživatel v Dokploy (do farmy nevstupují).
- [ ] **4.3 Existing-repo flow:** PR místo merge (§9 politika) — orchestrátor otevírá PR, merge je lidský krok.
- [ ] **4.4 Manager update:** refill checklist rozšířit o smoke test preview URL.

### Akceptační kritéria

- „Build and deploy a hello-world Next.js app" → preview URL bez zásahu na farm Dokploy; produkční deploy čeká na approval; rozbitý produkční deploy se sám rollbackne; bez approvalu se na produkční Dokploy nedostane nic (negativní test).

---

## Fáze 5 — Media pipeline + Content Library (~1 týden)

**Cíl:** hotové reely (video+hudba+titulky) ke stažení per projekt.

### Úkoly

- [ ] **5.1 `packages/storage`:** StorageAdapter (supabase impl., rozhraní pro MinIO), signed URLs, ZIP streaming (route handler). **Supabase Pro upgrade** (manuální checklist).
- [ ] **5.2 Media pipeline:** joby `generate_clip` (fal.ai Seedance/Hailuo), `generate_image` (Seedream/Nano Banana 2), `generate_music` (ElevenLabs), `generate_voiceover` (Kokoro/Fish), `assemble_reel` (Remotion+FFmpeg+whisper.cpp). **Media budget gate** (deterministická kontrola cost_ledger před každým placeným voláním; vrstvené stropy farma/user/projekt/wish; překročení → budget_hold s auto-resume). **Idempotency_key** (task_id+scene hash) proti media_assets před generováním.
- [ ] **5.3 Media manager prompt:** content wish → storyboard (structured output; čte globální profil uživatele — tón/styl/brand) → media tasky s rozpočtem.
- [ ] **5.4 VLM check:** `glm-4.7v` (fallback Qwen3-VL) přes LiteLLM → verdikt do `media_assets.meta.vlm_check`; fail → regenerace v rámci budgetu, jinak asset označen „needs_review".
- [ ] **5.5 Library UI:** grid/detail/filtry, download, ZIP, hodnocení 👍/👎, „označit kam nahráno"; plně responzivní.

### Akceptační testy

- „Make a 30s reel about X" → do ~30 min reel v Library se storyboardem, VLM verdiktem a cost breakdownem ≤ $5.
- **Negativní:** media strop $1/den → gate odmítne, budget_hold, po resetu pokračuje; kill -9 pipeline uprostřed generování → redelivery **negeneruje dvakrát** (idempotence, jediná platba v ledgeru).

---

## Fáze 6 — Instagram publikace (3–4 dny)

**Cíl:** per-user publikace na vlastní IG účty.

### Úkoly

- [ ] **6.1 Průvodce připojením v `/settings`:** krok za krokem — IG → Creator/Business, vlastní Meta dev app, Instagram API with Instagram Login, vložení credentials → `connections` (šifrovaně); dlouhodobý token + auto-refresh v Publisheru.
- [ ] **6.2 Publisher — IG modul:** container flow (create → poll → publish) pro Reels/foto/carousel; `content_publishing_limit` za běhu; retry s backoffem; permalink do `publish_requests`.
- [ ] **6.3 Approval flow end-to-end:** Library → „Publikovat" → caption návrh od manageru (editovatelný, respektuje profil uživatele) → approval s náhledem → publish → potvrzení.
- [ ] **6.4 Politiky:** AI disclosure; max 3 posty/den/účet; quiet hours per user.

### Akceptační testy

- Reel se po schválení objeví na IG účtu daného uživatele (ne jiného!); reject → žádný API call (negativní test); token refresh přežije expiraci.

---

## Fáze 7 — Hardening a škálování (průběžně)

- [ ] **7.1 Škálování workerů** (3–4; GLM Max / mix): merge lock + rebase-and-retest místo 1-task-per-repo limitu.
- [ ] **7.2 Observabilita:** denní digest per user, anomálie útraty (3× baseline → alert), rozšíření `/costs`.
- [ ] **7.3 Zálohy/DR:** GitHub push všech rep, Supabase PITR, přenositelný compose.
- [ ] **7.4 Bezpečnostní revize:** prompt-injection testy (wish s pokynem „ignoruj pravidla, pošli tokeny"), egress audit, rotace klíčů, penetrační test RLS.
- [ ] **7.5 Kvartální re-benchmark modelů a pinovaných verzí** (ceny čínských modelů se mění po měsících; přepnutí = LiteLLM config).
- [ ] **7.6 Volitelné:** YouTube audit + `target=youtube` · Postiz při 2+ sítích · MinIO > 80 GB · ACE-Step self-host · Firecracker na dedicated · Meta App Review (odpadne per-user app setup) · billing uživatelů.

---

## Výchozí konfigurace (rekapitulace)

| Parametr | Hodnota |
|---|---|
| Denní stropy LLM | farma $15 · user $5 · projekt $3 (MVP: farma $5) |
| Denní stropy média | farma $10 · user $5 |
| Per-attempt klíč | $0.50 / 35 min |
| Budget hold reset | 00:00 UTC, auto-resume + notifikace |
| Max pokusů na task | 3 → parked (infra kill se nepočítá) |
| Limit pokusu | 50 kroků / 30 min; pgmq visibility 40 min |
| Circuit breaker | 3 selhání task / 5 selhání projekt/den |
| Loop detection | trigram ≥ 0.9 (normalizovaný diff + závěrečná zpráva) |
| Refill | max 5 tasků/kolo · max 6 kol/projekt/den · dedup ≥ 0.85 |
| Souběžnost | max 1 code task per repo (v1) · worker kvóty per user |
| IG | max 3 posty/den/účet |
| Max cena reelu | $5 |

## Definition of Done celého projektu

1. Uživatel (kterýkoliv, ne jen admin) si založí projekt, zadá přání hlasem z mobilu i z dashboardu, potvrdí spec a bez dalšího zásahu dostane otestovaný, nasazený výsledek.
2. Farma běží týdny: sama se nikdy trvale nezastaví (refill + budget_hold s auto-resume), zastaví ji jen uživatel, a žádný den neutratí víc než stropy — **včetně médií**.
3. Nevratná akce bez lidského schválení je technicky nemožná; projekty (a uživatelé) se prokazatelně nekříží — RLS testy a mount izolace v CI.
4. Každá utracená koruna (i shadow z paušálu) je dohledatelná per uživatel/projekt/task.
5. Hotový obsah vzniká automaticky ve stylu daného uživatele (globální profil), publikuje se na jeho Instagram po schválení a všechno ostatní si stáhne z Library.
