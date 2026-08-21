// Node global fetch (undici) má defaultní headersTimeout i bodyTimeout 300 s.
// Agent uvnitř workeru volá LiteLLM přímo a u DeepSeeku s velkým kontextem trvá
// odpověď běžně přes pět minut → "TypeError: fetch failed". Orchestrátor si totéž
// řeší vlastním dispatcherem, sem ale nedosáhne, proto se limit vypíná i tady.
//
// KRITICKÉ: tenhle soubor se přes NODE_OPTIONS --import vkládá do KAŽDÉHO node
// procesu v kontejneru. Když by z něj vyletěla výjimka, neselže jen oprava, ale
// úplně všechno včetně `npm` a samotného opencode serveru. Proto try/catch a
// resolve přes absolutní cestu do globálních modulů.
try {
  const { Agent, setGlobalDispatcher } = await import(
    "/usr/local/lib/node_modules/undici/index.js"
  );
  setGlobalDispatcher(
    new Agent({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 60_000 }),
  );
} catch (err) {
  console.error("[undici-fix] nepodarilo se vypnout timeout:", err?.message ?? err);
}
