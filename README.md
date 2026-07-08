# 🌿 Perennial

**Univerzální autonomní farma AI agentů, která nikdy nepřestane stavět — použitelná na cokoliv.** Web appky, CLI, automatizace, datové pipeline, integrace, výzkum *i* obsah (video/reely). Zadáš přání (textem nebo hlasem), manager ho rozpadne, architekt navrhne DAG, worker agenti staví, judge + Tester ověří kvalitu — a když je hotovo, farma sama navrhuje a dělá další práci 24/7, dokud ji ručně nezastavíš. Levné čínské modely, tvůj rozpočet, tvoje kontrola. (Content/Instagram je jen jeden z případů použití, ne jádro produktu.)

## Univerzální autonomie (naváděj minimálně)

Farma sama vymýšlí, co dál — pro *jakýkoliv* cíl projektu:

- **Proaktivní návrhy:** strategist agent podle skutečného cíle projektu navrhuje další vysokou hodnotu (funkce/opravy/testy/automatizace/integrace/výzkum/refaktor/obsah/příležitost). Farm supervisor navrhuje i napříč projekty. Návrhy vidíš v dashboardu („Návrhy farmy") i v Telegramu (`/suggestions`) — přijmeš jedním tapem a stane se z nich přání.
- **Autopilot exekuce (`selfRun`):** projekt si sám převádí návrhy na přání a staví je bez tvého zásahu.
- **Auto-doručení (`autoDeliver`):** nevratné doručení (publikace hotového reelu) se do denního capu schválí automaticky, nad cap čeká na jeden tap. Produkční deploy zůstává vždy na lidském schválení (bezpečnost).
- Vše zapínáš per projekt v nastavení autonomie (proactive / selfRun / autoDeliver + denní limit).

Prodejní SaaS: veřejná landing (`/`), ceník (`/pricing`), předplatné s kredity přes Stripe, onboarding, per-user izolace. (`AgentFarm` = původní technický název; `@farm/*` je interní namespace balíčků.)

📄 Návrh a rozhodnutí: [OVERVIEW.md](OVERVIEW.md) · [PLAN.md](PLAN.md) · [INTEGRATION.md](INTEGRATION.md)

## Telegram velín (druhé plnohodnotné ovládání)

Farmu můžeš celou řídit z Telegramu — nemusíš do appky:

- **Proaktivní reporty:** agenti ti sami píšou, co dodělali a v jakém je to stádiu — dokončený úkol, milníky přání (25/50/75/100 %), zveřejněný reel, nasazený preview, i co potřebuje tvou pozornost (zaparkovaný úkol, došlé kredity). Durabilní kurzor → po restartu nespamuje.
- **Přehled:** `/projects` (všechny projekty se stavem + progress barem + dnešní útratou), `/project <název>` (detail + inline akce), `/agents` (kdo právě pracuje — živý registr botů), `/status` (celá farma na jeden pohled), `/digest` (shrnutí posledních 24 h v přirozené řeči).
- **Zadávání a navádění:** `/use <projekt>` → pak stačí psát a zprávy se stávají novými přáními · `/wish` / `/say <projekt> <text>` (jednorázově) · `/note <projekt> <text>` (poznámka manažerovi — okamžitě mění směr smyčky) · hlasovky · schvalování jedním tapem ✅/❌.

## Autonomie („naváděj minimálně, agenti udělají vše")

- **Concierge manager:** neblokuje na tobě. U vágního přání udělá rozumné, vyjmenované předpoklady, jede dál a ty předpoklady ti pošle (`assumptions_made`) — můžeš je opravit přes `/note`.
- **Autopilot:** projekt s `trust_mode` (nebo globální `autopilot` flag) přeskočí schvalování specifikace a rovnou plánuje a staví — z jedné věty vznikne kompletní autonomní build.
- **Živý registr agentů:** tabulka `agents` ukazuje, kdo (worker/judge/manager), jakým modelem a na čem právě pracuje — v Telegramu i v dashboard velíně (s pulzující animací).

## Swarm — desítky agentů současně

Farma není jeden agent — je to **roj**. `MAX_WORKERS_TOTAL` určuje, kolik workerů běží **paralelně**: tolik nezávislých dispatch smyček čte z fronty přes `FOR UPDATE SKIP LOCKED`, takže každý bere jiný úkol bez kolize. Paralelně stavějí i úkoly téhož projektu; slévá se bezpečně přes **rebase-onto-main** (konflikt → úkol zpět workerovi, repo se nerozbije). Živě to vidíš ve **velíně roje** (`/swarm` v dashboardu i v Telegramu): kolik agentů právě pracuje, na čem, throughput a náklady/hod. To je ten „strongest farm" výkon — a je vidět.

## Jak farma přemýšlí (architektura mozku)

Není to jeden agent s jedním promptem — je to vrstvený systém s vlastní **ústavou** a **pamětí**:

1. **Ústava (systémový prompt):** sdílená operační doktrína injektovaná do *každého* agenta — identita, znalost celé pipeline, laťka kvality (produkční kód, reálné testy, žádné placeholdery), poctivost, bezpečnost (least privilege, schvalování nevratného) a přísný JSON kontrakt. Stabilní → cache-friendly.
2. **Architekt (design + DAG):** z přání a specifikace vytvoří skutečný technický **design** a **závislostní graf úkolů** (DAG) — malé vertikální řezy, scaffolding a testy dřív než featury, každý úkol s `verify_method`. Dispatch je **event-driven po DAG**: spustí se jen úkoly, jejichž závislosti jsou hotové; po dokončení úkolu se odemknou závislé.
3. **Znalostní báze projektu („mozek projektu"):** perzistentní `project_memory` — architektura, rozhodnutí, konvence a **poučení**. Každý worker/architekt/refill dostane kompaktní **brief** z této paměti → agenti staví se souvislou znalostí, ne naslepo (řeší context rot).
4. **Reflexe po selhání:** když úkol nebo QA opakovaně selže, reflexní krok najde **root cause** a zapíše poučení do paměti — farma se stejné chyby podruhé nedopustí. Vidíš to v dashboardu (sekce „Mozek projektu").
5. **Adaptivní routing modelů:** levný model na první pokus, eskalace na silnější při opakování / u těžkých úkolů.
6. **Dvojitá verifikace:** judge (statika) → Tester agent (E2E + vizuálně, viz níže).

## Tester agent — kontroluje úplně všechno (self-healing)

Nad statickým judgem (build/testy/lint + review diffu) stojí **Tester agent**, který ověřuje reálný výsledek end-to-end:

1. **Spustí appku** v izolovaném kontejneru (detekuje `dev`/`build`+`start`, počká na port).
2. **Projede ji prohlížečem** — z akceptačních kritérií odvodí konkrétní scénáře (Playwright: navštiv routu, vyplň, klikni, ověř), u CLI/API spustí příkazy a ověří výstup.
3. **Screenshoty** každého scénáře → uloží do Content Library jako důkaz.
4. **Vizuální kontrola** klíčových screenshotů modelem (VLM) — nerozbité rozlgení, obsah je tam, vypadá správně.
5. **Ověří každé akceptační kritérium** funkčně i vizuálně → zapíše `qa_runs` (per-scénář pass/fail).
6. **Self-healing:** když něco selže, sám vyrobí **opravné úkoly** (s konkrétní done-condition a verify-method) a pošle je zpět workerům. Až 3 kola, pak přání zaparkuje pro člověka.
7. Teprve **po zeleném QA** se přání označí jako hotové a nasadí preview.

Výsledky (per-scénář stav + screenshoty) vidíš v dashboardu u přání i jako report v Telegramu (`✅ QA prošlo` / `❌ QA selhalo — agenti to opravují`). Tím produkt reálně garantuje, že „agenti si po sobě zkontrolují práci".

**Mozek** (prompt knihovna) je přepsaný na kvalitní reasoning: manager dělá PRD-style specifikaci s explicitními předpoklady a ověřitelnými kritérii, plán je závislostně seřazený s `verify_method` u každého úkolu, judge je ostrý adversariální reviewer, refill kuruje jen vysokou hodnotu. Worker agenti mají senior-engineer instrukce (reálné testy, žádné placeholdery/stuby, žádné oslabování testů).

## Monetizace (Perennial)

Předplatné s kreditovým modelem — **kredit = $1 skutečné spotřeby modelů/médií** (mapuje se na `cost_ledger`). Plány jsou v kódu (`@farm/billing` `PLANS`): **Free / Starter $29 / Pro $99 / Scale $299** (měsíčně), každý s měsíčním přídělem kreditů + denními stropy + limity projektů/workerů. Vyčerpání kreditů → projekt `budget_hold` + upsell (ne překvapivý účet). Stripe: Checkout (předplatné + dobití), Billing Portal, webhook (`/api/stripe/webhook`, idempotentní). Kvóty se odvozují z plánu; admin může přepsat přes `caps_override`.

> **Stav:** kompletní skelet v1 (všechny fáze). Kód je hotový a sestavuje se; po doplnění `.env` a spuštění migrací nastartuje. Živé účty (Supabase, čínské modely, Instagram…) doplňuješ jen do `.env`.

---

## Co je uvnitř

```
apps/
  orchestrator/     srdce farmy: manager · refill · dispatch · judge · reconciliation · guardrails
  publisher/        jediný držitel tokenů: Instagram Graph API + Dokploy deploy (za approval bránou)
  media-pipeline/   fal.ai · ElevenLabs · TTS · VLM check · ffmpeg assembly (budget gate + idempotence)
  telegram-bot/     grammY: přání text/hlas · schvalování · příkazy · alerty
  dashboard/        Next.js 16 mission control: projekty · přání · approvals · Library · costs · admin
packages/
  db/               Drizzle schema všech tabulek + RLS + pgmq fronty + migrace
  core/             stavové stroje · guardraily · dedup · šifrování · rozpočty (unit-testováno)
  llm/              brána k modelům přes LiteLLM · ephemeral klíče · prompty · strukturované výstupy
  storage/          StorageAdapter (Supabase → MinIO) · ZIP export
infra/
  litellm/          config.yaml — modely, stropy, shadow pricing, failover
  docker/           worker · judge-runner · service Dockerfily
  compose/          docker-compose.farm.yml (produkční stack pro farm VPS)
  opencode/         konfigurace worker agentů
```

## Rychlý start (lokálně)

Předpoklad: Node ≥ 22, pnpm 9, Docker (pro workery/compose).

```bash
# 1) instalace
pnpm install

# 2) konfigurace — zkopíruj vzor a doplň [POVINNÉ] hodnoty
cp .env.example .env
#    minimum pro nastartování: SUPABASE_*, DATABASE_URL, CREDENTIALS_ENCRYPTION_KEY,
#    LITELLM_MASTER_KEY, a klíče modelů (DEEPSEEK_API_KEY, ZAI_API_KEY, MOONSHOT_API_KEY)
openssl rand -hex 32   # → CREDENTIALS_ENCRYPTION_KEY

# 3) databáze: rozšíření + tabulky + RLS + pgmq fronty + seed
pnpm db:migrate

# 4) build
pnpm build

# 5) bootstrap: storage bucket + první admin uživatel + pozvánka
pnpm bootstrap --email tvuj@email.cz --admin

# 6) preflight: ověří, že .env + živé služby jsou správně zapojené
pnpm doctor

# 7) (volitelné) demo přání pro smoke-test smyčky bez médií/sítí
pnpm seed:demo
```

> **`pnpm doctor`** projede 10 kontrol (env, DB, migrace, pgmq fronty, storage, LiteLLM, odezva modelu, GitHub PAT, Telegram token, admin uživatel) a řekne přesně, co ještě chybí — spusť ho kdykoliv po úpravě `.env`.

## Spuštění celé farmy (farm VPS)

Na dedikovaném farm VPS (Hetzner CX53, **ne** produkční box):

```bash
# gVisor runtime pro izolaci (produkce)
#   nastav WORKER_DOCKER_RUNTIME=runsc v .env po instalaci gVisoru

docker compose -f infra/compose/docker-compose.farm.yml up -d --build
```

Stack spustí: LiteLLM proxy, orchestrátor, publisher, media-pipeline, telegram-bot, dashboard a socket-proxy. Worker a judge kontejnery spouští orchestrátor on-demand.

## Co musíš doplnit (accounts & klíče)

Vše jde jen do `.env` — kód je připravený. Podle fáze:

| Kdy | Co | Kam |
|---|---|---|
| Hned | Supabase projekt (nový, dedikovaný) | `SUPABASE_*`, `DATABASE_URL` |
| Hned | DeepSeek, Z.ai GLM Coding Plan, Moonshot Kimi | `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `MOONSHOT_API_KEY` |
| Hned | GitHub PAT (zakládání/push rep) | `GITHUB_ADMIN_PAT`, `GITHUB_OWNER` |
| Hned | Telegram bot (@BotFather) | `TELEGRAM_BOT_TOKEN` |
| Hlas | Groq (Whisper STT) | `GROQ_API_KEY` |
| Média | fal.ai, ElevenLabs | `FAL_API_KEY`, `ELEVENLABS_API_KEY` |
| Deploy | farm Dokploy | `FARM_DOKPLOY_URL`, `FARM_DOKPLOY_API_KEY` |
| Instagram | vlastní Meta app (per user) v dashboardu → `/settings` | ukládá se šifrovaně do DB |

## Bezpečnost & guardraily (shrnutí)

- **Rozpočet mimo agenty:** LiteLLM proxy vynucuje vrstvené denní stropy (farma → uživatel → projekt) + ephemeral per-attempt klíče. Média mají vlastní budget gate v pipeline. Dosažení stropu = `budget_hold` s auto-resume o půlnoci UTC (ne trvalé zastavení).
- **Izolace:** worker/judge kontejnery pod gVisorem, egress allowlist (jen LiteLLM + npm), docker.sock jen orchestrátor přes socket-proxy.
- **Least privilege:** agenti nedrží externí tokeny; git dělá orchestrátor, publikaci/deploy jen Publisher po approvalu.
- **Ráčna:** judge zamítne diff, který mění chráněný harness (package.json/tsconfig/CI/…) nebo maže testy.
- **Multi-tenant:** RLS na všech tabulkách; projekty se nekříží (izolace volume + labely + klíče).

## Užitečné příkazy

```bash
pnpm build            # sestaví vše (turbo)
pnpm typecheck        # typová kontrola
pnpm --filter @farm/core test   # unit testy jádra
pnpm db:migrate       # migrace + RLS + pgmq + seed
pnpm dev              # dev režim (turbo)
```

## Kam dál (PLAN.md)

Skelet pokrývá všechny fáze. Doporučené pořadí zprovoznění: nejdřív **Fáze 1** (jádro smyčky — 48h autonomní běh), pak dashboard, deploy, média a nakonec Instagram. Externí audity (YouTube/TikTok) jsou vědomě mimo v1 — místo nich Content Library ke stažení.
