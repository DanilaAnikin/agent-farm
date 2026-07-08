# Judge / build / QA runner — čistý kontejner, kde judge spouští install/build/test/lint
# na branchi pokusu A KDE Tester spouští aplikaci + Playwright E2E/vizuální testy.
# Spouští arbitrární (potenciálně nepřátelský) kód, proto BĚŽÍ POD STEJNOU IZOLACÍ
# jako worker: runsc (gVisor) + egress allowlist (jen npm). Výsledky si vytahuje
# orchestrátor (přes host-mountnutý /out), kontejner nikam nepushuje (žádný git
# remote, žádný Supabase).
#
# gVisor pozn.: chromium se spouští s --no-sandbox a --disable-dev-shm-usage
# (runner to nastavuje), protože user-namespace sandbox pod runsc nefunguje.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# Prohlížeče se instalují do sdílené, čitelné cesty (ne do ~judge), ať k nim
# runner najde cestu bez ohledu na uživatele.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Playwright + chromium (vč. systémových závislostí) — GLOBÁLNĚ, ať je runner
# přes NODE_PATH/createRequire najde. Browsery jdou do /ms-playwright a zpřístupní
# se všem uživatelům (Tester může běžet i jako non-root).
RUN npm install -g playwright@1.49.1 \
    && npx --yes playwright@1.49.1 install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

RUN useradd -ms /bin/bash judge
USER judge
WORKDIR /home/judge/project

# Orchestrátor přebíjí ENTRYPOINT/CMD (docker run ... judge-runner <cmd>):
#  - judge:  install/build/test/lint;
#  - tester: bash /out/run-qa.sh (start appky + Playwright scénáře).
ENTRYPOINT ["/bin/bash", "-lc"]
CMD ["echo 'judge-runner ready'"]
