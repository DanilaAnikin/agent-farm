# Worker image — opencode + git + node + pnpm.
# Spouští ho orchestrátor on-demand, jeden kontejner = jeden slot workera,
# svázaný s jedním projektem (label project_id), mount jen volume projektu.
# Na produkci běží pod runsc (gVisor) s egress allowlistem: jen LiteLLM + npm.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/usr/local/bin \
    OPENCODE_DISABLE_AUTOUPDATE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# pnpm + opencode CLI (headless server + SDK cíl)
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN npm install -g opencode-ai@latest

# Neroot uživatel — worker kód běží bez privilegií.
RUN useradd -ms /bin/bash worker
USER worker
WORKDIR /home/worker/project

# opencode konfigurace (custom agenti + permissions) se mountuje z hostu
# jako /home/worker/.config/opencode. Server poslouchá jen na privátní síti.
EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
