# LiteLLM proxy

Jediná brána veškerého LLM traffiku farmy. Vynucuje rozpočtové stropy a ephemeral klíče **mimo dosah agentů** (princip č. 2).

## Co dělá

- **Vrstvené denní stropy** — farma (`max_budget` v `config.yaml`), uživatel a projekt (přes per-key `max_budget` na virtuálních klíčích, které orchestrátor generuje).
- **Per-attempt ephemeral klíče** — orchestrátor před každým pokusem workera vytvoří klíč s `max_budget=$0.50` a expirací 35 min (`POST /key/generate`), injektuje ho do opencode session a po skončení revokuje (`POST /key/delete`). Viz `packages/llm/src/keys.ts`.
- **Shadow pricing GLM paušálu** — GLM Coding Plan nemá marginální cenu za token; v `model_info` mu imputujeme list price a příznak `shadow_priced`, aby denní stropy a `cost_ledger` zůstaly smysluplné. Řádky v ledgeru mají `is_shadow=true`.
- **Failover** — `worker` (GLM plán) → `worker-fallback` (DeepSeek V4 Flash pay-as-you-go), aby vyčerpaná kvóta plánu farmu nezastavila.
- **Zápis nákladů** — LiteLLM spend logy jdou do stejného Postgresu (Supabase). Orchestrátor je periodicky slévá do `cost_ledger` s `user_id/project_id/task_id` z metadat requestu (posílá je `packages/llm` v `metadata`).

## Ověření ve Fázi 0 (KRITICKÉ)

Ověř, že **GLM Coding Plan reálně funguje skrz LiteLLM** (anthropic passthrough — auth, kvóta, hlavičky):

```bash
curl -s $LITELLM_BASE_URL/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"worker","messages":[{"role":"user","content":"reply with: ok"}]}'
```

Pokud passthrough nefunguje (Z.ai vrací auth/kvóta chybu), fallback plán: workeři míří na Z.ai přímo a náklady se sbírají orchestrátor-side pollingem. Zdokumentováno v OVERVIEW §5.4.

## Modely

| `model_name` | Skutečný model | Role |
|---|---|---|
| `manager` | deepseek-v4-pro | spec, plán, refill |
| `worker` / `worker-hard` | glm-4.7 / glm-5.2 | kódování |
| `worker-fallback` | deepseek-v4-flash | fallback kódování |
| `judge` | kimi-k2.6 | review |
| `cheap` | deepseek-v4-flash | sumarizace, captions |
| `media-vlm` / `-fallback` | glm-4.7v / qwen3-vl | kontrola médií |

> **Nikdy** nepoužívat `deepseek-chat` / `deepseek-reasoner` — aliasy končí 2026-07-24. Vždy `deepseek-v4-*`.
