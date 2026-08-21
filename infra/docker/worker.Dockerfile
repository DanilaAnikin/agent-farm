# Worker image — opencode + git + node + pnpm.
# Spouští ho orchestrátor on-demand, jeden kontejner = jeden slot workera,
# svázaný s jedním projektem (label project_id), mount jen volume projektu.
# Na produkci běží pod runsc (gVisor) s egress allowlistem: jen LiteLLM + npm.
FROM node:22-bookworm-slim
# farm.keep=1 chrání on-demand image před `docker image prune` (image nemá
# trvalý kontejner mezi spawny → prune ho jinak smaže; homelab prune ho vylučuje
# přes --filter label!=farm.keep=1). NEODSTRAŇOVAT.
LABEL farm.keep=1

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/usr/local/bin \
    OPENCODE_DISABLE_AUTOUPDATE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# pnpm + opencode CLI (headless server + SDK cíl)
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN npm install -g opencode-ai@latest undici

# Neroot uživatel — worker kód běží bez privilegií.
RUN useradd -ms /bin/bash worker
RUN mkdir -p /home/worker/.config/opencode
COPY --chown=worker:worker infra/opencode/opencode.json /home/worker/.config/opencode/opencode.json
COPY infra/docker/undici-no-timeout.mjs /opt/undici-no-timeout.mjs
# --import platí pro KAŽDÝ node proces v kontejneru, tedy i pro opencode server.
ENV NODE_OPTIONS="--import=file:///opt/undici-no-timeout.mjs"

USER worker
WORKDIR /home/worker/project

# opencode konfigurace (custom agenti + permissions) se mountuje z hostu
# jako /home/worker/.config/opencode. Server poslouchá jen na privátní síti.
EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
