# Multi-stage build dashboardu. Kontext buildu = kořen monorepa (agent-farm/).
#   docker build -f apps/dashboard/Dockerfile -t agent-farm-dashboard .
# Next.js standalone output → malý runtime image.

# --- deps: nainstaluj závislosti celého workspace -----------------------------
FROM node:22-slim AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps/dashboard ./apps/dashboard
RUN pnpm install --frozen-lockfile

# --- builder: sestav sdílené balíčky a dashboard ------------------------------
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo ./
COPY . .
# Předsestav @farm/* balíčky (dist), pak Next build.
RUN pnpm --filter "@farm/db" --filter "@farm/storage" --filter "@farm/core" --filter "@farm/llm" run build || true
RUN pnpm --filter "@farm/dashboard" run build

# --- runner: minimální runtime -----------------------------------------------
FROM node:22-slim AS runner
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
# Standalone bundle obsahuje jen potřebné node_modules.
COPY --from=builder /repo/apps/dashboard/.next/standalone ./
COPY --from=builder /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder /repo/apps/dashboard/public ./apps/dashboard/public
USER nextjs
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
