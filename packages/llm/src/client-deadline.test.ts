import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { chat } from "./client.js";

test("chat has an absolute body deadline even when a provider sends keepalives", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("\n");
    const keepalive = setInterval(() => res.write("\n"), 10);
    res.once("close", () => clearInterval(keepalive));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const oldUrl = process.env.LITELLM_BASE_URL;
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const start = Date.now();
    await assert.rejects(chat({ model: "cheap", apiKey: "fixture-only", messages: [
      { role: "user", content: "local fixture" },
    ], requestTimeoutMs: 150 }), (error: Error) => /Timeout|Abort/.test(error.name));
    assert.ok(Date.now() - start < 2_000, "keepalives must not extend the deadline");
  } finally {
    if (oldUrl === undefined) delete process.env.LITELLM_BASE_URL;
    else process.env.LITELLM_BASE_URL = oldUrl;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("chat retains caller cancellation and accepts an ordinary completed response", async () => {
  const server = createServer((_req, res) => res.end(JSON.stringify({
    model: "cheap", choices: [{ message: { content: "OK" } }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const oldUrl = process.env.LITELLM_BASE_URL;
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const opts = { model: "cheap" as const, apiKey: "fixture-only", messages: [
    { role: "user" as const, content: "local fixture" },
  ], requestTimeoutMs: 2_000 };
  try {
    assert.equal((await chat(opts)).content, "OK");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(chat({ ...opts, signal: controller.signal }), { name: "AbortError" });
  } finally {
    if (oldUrl === undefined) delete process.env.LITELLM_BASE_URL;
    else process.env.LITELLM_BASE_URL = oldUrl;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
