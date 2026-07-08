# GitHub Actions – CI

Tato složka obsahuje CI pipeline pro AgentFarm monorepo.

## `ci.yml`

Workflow **CI** se spouští při každém `push` a `pull_request`.

Má jediný job `build` běžící na `ubuntu-latest`, který provede:

1. **Checkout** repozitáře (`actions/checkout@v4`).
2. **Setup pnpm** (`pnpm/action-setup@v4`, verze 9).
3. **Setup Node.js** (`actions/setup-node@v4`, Node 22, s cache pro pnpm).
4. **Instalaci závislostí** přes `pnpm install --frozen-lockfile`
   (fallback na `pnpm install`, pokud lockfile chybí).
5. **Testy** balíčku `@farm/core`: `pnpm -r --filter @farm/core test`.
6. **Typecheck**: `pnpm typecheck` (turbo přes všechny balíčky).
7. **Build**: `pnpm build` (turbo přes všechny balíčky a aplikace).

### Concurrency

Workflow používá `concurrency` skupinu podle větve/ref, takže při novém pushi
se předchozí rozběhnutý běh zruší (`cancel-in-progress: true`) a šetří runnery.

### Placeholder env proměnné

Dashboard staví přes `next build`, který vyžaduje Supabase proměnné už při buildu.
V CI proto nastavujeme **neškodné placeholder hodnoty** na úrovni jobu
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `LITELLM_MASTER_KEY`
a 64-znakový hex `CREDENTIALS_ENCRYPTION_KEY`). Tyto hodnoty slouží pouze k tomu,
aby build proběhl – žádné reálné tajné údaje se v CI nepoužívají.
