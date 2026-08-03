# Generický image pro dlouho běžící Node služby farmy
# (orchestrator, publisher, media-pipeline, telegram-bot).
# Build arg SERVICE volí, kterou app z monorepa spustit.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/usr/local/bin
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN git config --system --add safe.directory '*'
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* turbo.json tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS build
RUN pnpm run build

FROM base AS runtime
ARG SERVICE=orchestrator
ENV SERVICE=${SERVICE}
COPY --from=build /app ./
WORKDIR /app/apps/${SERVICE}
# ffmpeg je v image kvůli media-pipeline (Remotion/FFmpeg render).
CMD ["node", "dist/index.js"]
