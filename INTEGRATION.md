# Integrace — kontrakty a co ověřit při zapojení živých služeb

Skelet je kompletní a sestavuje se (`pnpm build` → 9/9). Aplikace spolu mluví **jen přes DB a pgmq fronty** — tady jsou přesné kontrakty a seznam míst, kde kód volá externí API, jejichž přesný tvar je nutné ověřit proti reálné verzi služby (jsou to odhady k 07/2026, izolované na jednom místě).

## Cross-app kontrakty (závazné rozhraní mezi službami)

### Fronty (pgmq)
| Fronta | Producent | Konzument | Payload |
|---|---|---|---|
| `q_tasks` | orchestrator (manager/refill/judge) | orchestrator (dispatch) | `TaskMessage { taskId, projectId, wishId, kind, isFix, note? }` |
| `q_judge` | orchestrator (dispatch) | orchestrator (judge) | `JudgeMessage { taskId, projectId, attemptId, branch, ... }` |
| `q_media` | media-pipeline (storyboard) / orchestrator | media-pipeline (media-loop) | `MediaJob` discriminated union (pole `job`), reely grupované přes `taskId` |
| `q_publish` | dashboard / orchestrator | publisher (publish-loop) | `{ publishRequestId: string }` |
| `q_deploy` | orchestrator (po dokončení code přání) | publisher (deploy-queue) | `DeployJob { projectId, wishId?, kind:'preview' }` |

### Events (append-only tabulka `events`)
- **Hlasové přání (STT):** zapisovatel (dashboard/telegram) vloží `type='voice_wish'`, sloupec `wish_id`, `data.storagePath`. Orchestrátor STT smyčka to čte, stáhne audio, přepíše (Groq) → doplní `wishes.description`, zapíše `type='stt_done'` pro tentýž `wish_id`. *(sjednoceno napříč všemi třemi službami)*
- **Alerty pro Telegram:** bot upozorňuje na eventy s `level in ('warn','error')` nebo `type in ('task_parked','budget_hold','budget_hold_resumed','circuit_breaker','project_paused_auto')`. Orchestrátor tyto typy emituje.
- **Refill limit:** počítá se z eventů `type='refill_round'` za dnešní UTC den.

### Approvals (schvalovací brána)
- Bot/dashboard nastaví `approvals.status='approved'|'rejected'`, `decided_via`, `decided_at` (guard `WHERE status='pending'`).
- **Deploy do produkce:** publisher polluje `approvals WHERE type='deploy_prod' AND status='approved'`; `payload = { projectId, artifact? }`. Dedup marker: event `type='deploy.prod.handled'`, `data.approvalId` (nikdy nemazat).
- **Publikace:** vzniká z Library → `publish_request` (draft) + `approval(type='publish')`. Náhledy v Telegramu čtou `payload.specMd|caption|target|diffSummary|requestedUsd`.

### Connections (šifrované credentials, per user — `@farm/core` decrypt)
- `kind='github'` → `{ pat }` (fine-grained PAT); fallback `GITHUB_ADMIN_PAT`/`GITHUB_OWNER`.
- `kind='instagram'` → `{ igUserId, accessToken }`, volitelně `meta.tokenExpiresAt`.
- `kind='dokploy'` → `{ url, apiKey }` (produkční Dokploy uživatele).

### Kill switch & pauzy
- `/kill` (admin) → `farm_settings.global_pause=true`. Orchestrátor to čte před každým dispatch a abortuje běžící sessions.
- `budget_hold` (projekt) → auto-resume o 00:00 UTC (budget-hold smyčka). Circuit breaker (≥ práh zaparkovaných úkolů/den) → projekt `paused` (ruční obnova).

## Externí API — ověřit při zapojení (odhady izolované na jednom místě)

| Kde | Co ověřit | Soubor |
|---|---|---|
| **opencode** | Tvar REST API worker serveru: `POST /session`, `POST /session/:id/message`, `GET /event` (SSE), `POST /session/:id/abort`; heuristika počítání kroků `isStepEvent`/`extractText`. Endpointy jsou na jednom místě. | `apps/orchestrator/src/opencode.ts` (`ENDPOINTS`) |
| **dockerode** | `container.wait()`, `container.logs()` demux, `listContainers` filtry proti reálné verzi `@types/dockerode` 3.3.x. | `apps/orchestrator/src/docker.ts` |
| **GitHub (octokit)** | `createForAuthenticatedUser` vs `createInOrg` dle práv PATu; pole `clone_url`/`html_url`. | `apps/orchestrator/src/git.ts` |
| **LiteLLM admin** | `POST /key/generate`, `/key/delete`, `/user/update` (max_budget, budget_duration) dle verze LiteLLM. **Ověřit i GLM Coding Plan passthrough** (viz `infra/litellm/README.md`). | `packages/llm/src/keys.ts`, `apps/orchestrator/src/litellm-sync.ts` |
| **Groq Whisper** | Multipart pole `file`/`model`/`response_format`; běží na Node 22+ (globální FormData/Blob/fetch). | `apps/orchestrator/src/stt.ts` |
| **fal.ai** | Model idčka (Seedance 2.0, Hailuo, Kling, Seedream, Nano-Banana) a vstupní pole; tvar odpovědi (`video.url`/`images[].url`). | `apps/media-pipeline/src/providers/fal.ts` |
| **ElevenLabs / Fish / Kokoro** | Music endpoint (`/v1/music` + pole délky), TTS tvary. | `apps/media-pipeline/src/providers/*` |
| **Media VLM** | Aktuálně jen textový prompt s podepsanou URL; pro skutečné „vidění" obrázku poslat multimodální content-parts přímo na LiteLLM. | `apps/media-pipeline/src/providers/vlm.ts` |
| **Instagram Graph** | Flavor: `graph.instagram.com` (Instagram Login) vs `graph.facebook.com` (Business). `content_publishing_limit` tvar, refresh tokenu. Přepínatelné přes `IG_GRAPH_BASE`/`IG_GRAPH_VERSION`. | `apps/publisher/src/instagram.ts` |
| **Dokploy** | REST cesty (`application.create/deploy/one/rollback`) a auth hlavička dle verze Dokploy. | `apps/publisher/src/dokploy.ts` |
| **Cenové odhady** | `VIDEO_USD_PER_S`, `IMAGE_USD`, `MUSIC_USD_PER_MIN` a ceny v `litellm/config.yaml` — kalibrovat podle reálných faktur (stojí na nich budget gate). | media-pipeline, litellm config |

## Ověřeno naostro (2026-07-05)

Kód byl poprvé spuštěn proti **živému Postgresu** (lokální cluster + Supabase-kompat shim: auth + pgmq + pg_trgm):
- ✅ Všech 6 migrací aplikováno čistě → 21 tabulek, RLS, 6 pgmq front.
- ✅ Funkční smoke 14/14: reálné dotazy @farm/db, pgmq enqueue→read→ack, stavové stroje, výpočet kreditů (@farm/billing) proti reálné DB.
- ✅ RLS multi-tenancy: uživatel vidí jen svá data (profiles i project-scoped), žádná rekurze.

**Opravené běhové chyby** (nalezené adversariálním bug-huntem + během — build je neodhalil):
- pgmq `enqueue`: `sql.json()` s `::jsonb` castem crashoval → `JSON.stringify` (fronta by v produkci vůbec nefungovala). **Kritické.**
- RLS `FORCE ROW LEVEL SECURITY` lámal SECURITY DEFINER bypass → nekonečná rekurze v `is_admin()` na Supabase (dashboard by nepřečetl nic) → jen `ENABLE` + `SET search_path`. **Kritické.**
- Judge: chyba během posouzení uvíznula task v `judging` napořád → catch task vrátí do fronty.
- Dispatch: `routeWorkerModel` off-by-one → eskalace modelu naskakovala o pokus později (`attemptsCount + 1`).
- Reconciliation reapoval ŽIVÉ pokusy (heartbeat jen z SSE eventů) → přidán periodický heartbeat à 30 s.
- Tester self-heal tvořil DUPLICITNÍ opravné úkoly → přepsaná dedup větev.
- Schválená publikace se NIKDY neodeslala (nikdo nezařadil `q_publish`) → dashboard i Telegram po approvalu zařadí frontu.
- RealtimeRefresh posílal filtr `wish_id` i tabulkám bez toho sloupce (subscription selhala) → per-tabulkové filtry.
- Stripe webhook: idempotenční marker PŘED prací → při chybě Stripe retry zahodil → marker až po úspěchu.
- Publisher: republikace na IG při crashi → guard na `externalId`/`publishing`.
- Media-loop: pgmq `read_ct` (rostl i při budget-hold odkladech) použit jako failure counter → vlastní `failCount` v payloadu.

**2. kolo oprav (swarm + RLS zápisy, 2026-07-05):**
- 🔴 KRITICKÉ: swarm `mergeToMain` dělal `git checkout branch` v hlavním workspace, jenže branch byla pořád checked-out ve worktree (nikdy se nemazal) → git odmítl → **každý merge falešný „konflikt"** → žádný úkol nikdy nedokončil. Oprava: před checkoutem odstraň worktree držící branch.
- RLS: `specs`, `publish_requests`, `events` měly jen `FOR SELECT`, ale dashboard do nich zapisuje pod uživatelským JWT (approveSpec, requestPublish, voice_wish) → zápis by RLS zablokoval a flow selhaly. Migrace `0007_rls_writes.sql` je rozšiřuje na vlastnické zápisy (ověřeno jako `authenticated`).

**Integrační testy (nové):** `tests/integration/` (`@farm/integration`) — 25 testů proti živé DB pokrývajících pgmq, kredity (měsíční okno), RLS izolaci A-vs-B + zápisy, DAG, stavové stroje, dedup, budget, suggestions convert, auto-deliver cap. Spuštění: připrav DB (viz „Ověřeno naostro"), pak `DATABASE_URL=… pnpm --filter @farm/integration test`. Ověřeno 25/25.

**Zbývající známé omezení:** media `jobs.ts` může v úzkém okně (provider uspěl, ale `storage.put`/DB update spadl → asset zůstal `generating`) při retry zaplatit generaci dvakrát; plná oprava vyžaduje perzistenci provider request-id. Nízké riziko, zdokumentováno.

## 🎉 CELÁ SMYČKA OVĚŘENA NAOSTRO (2026-07-05)

Farma **poprvé reálně proběhla celé přání od začátku do konce** — bez Dockeru a bez čínských modelů, přes lokální běhové prostředí (`LOCAL_RUNTIME=1`): manager → architekt (design + DAG) → worker (napsal REÁLNÝ kód) → judge (build/test **naostro** na hostu) → rebase-merge do main → **Tester ověřil** → `wish_done`. Vygenerovaný projekt (`src/todo.js` + `test/todo.test.js`) je skutečný a **`node --test` na něm dá 5/5 zelených**.

Spuštění: `bash scripts/dev/run-e2e.sh` (efemérní Postgres + shim + migrace + driver `apps/orchestrator/src/dev-e2e.ts` s in-process LLM/opencode mockem — prostředí zabíjí dlouhoběžící servery, takže se faktuje přes `globalThis.fetch`). Přepínače `LOCAL_RUNTIME` jsou v `docker.ts` (worker=fake, judge/tester běží na hostu) a `git.ts` (repo bez remote).

**Běhové bugy nalezené TÍMTO reálným během (build je neodhalil) a opravené:**
- `ensureRepo` vyžadoval GitHub PAT i pro `repo_mode='none'` → lokální projekt vůbec nešel spustit. Creds jsou teď nullable; GitHub se vyžaduje jen u `new`/clone/PR.
- **`.farm` kolize:** dispatch píše untracked `.farm/progress.md` do hlavního workspace, worker ho commitoval na branch → `git checkout branch` v merge selhal ("untracked files would be overwritten"). Oprava: `.gitignore` s `.farm/` při initu repa — handoff je čistě lokální, nikdy se necommituje (řeší i to, že by config-ráčna eskalovala každou aktualizaci progressu).
- **config-ráčna** eskalovala jakýkoliv dotyk chráněných souborů včetně PŘIDÁNÍ → první scaffolding úkol (nutně vytváří package.json) vždy eskaloval. Oprava: ráčnuje jen MODIFIKACE/MAZÁNÍ existujících harness souborů, ne přidání nových (scaffolding).

## Pořadí spuštění
1. `pnpm db:migrate` (rozšíření + tabulky + RLS + fronty + seed)
2. `pnpm bootstrap --email … --admin` (bucket + admin uživatel)
3. LiteLLM proxy (compose) — ověřit GLM passthrough
4. orchestrator → publisher → media-pipeline → telegram-bot → dashboard

## Známé odložené / TODO (nejsou blokery buildu)
- `middleware.ts` v dashboardu je v Next 16 označen jako deprecated (→ `proxy.ts`); funguje, jen varuje při buildu.
- Telegram in-memory kurzory (alerty/approvals/nevybraná přání) se resetují při restartu — durable varianta navržena v komentářích.
- Farm/projekt/wish stropy se vynucují v orchestrátoru (`checkBudget`); jejich propis do LiteLLM (global/team budget) je TODO — per-user stropy se synchronizují.
