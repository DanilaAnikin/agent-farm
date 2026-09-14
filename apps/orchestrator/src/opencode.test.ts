import assert from "node:assert/strict";
import { test } from "node:test";
import { OpencodePromptError, parsePromptResponse, prompt, createSession } from "./opencode.js";

test("HTTP 200 containing provider error is not a successful worker completion", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    info: { role: "assistant", error: {
      name: "APIError", data: { statusCode: 402, message: "provider refused request" },
    } },
    parts: [{ type: "text", text: "Partial work exists" }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(prompt("http://fake-worker", "session", {
    agent: "worker-build", model: "worker", text: "task",
  }), (error: unknown) => {
    assert.ok(error instanceof OpencodePromptError);
    assert.equal(error.status, 402);
    assert.match(error.message, /budget exceeded/);
    return true;
  });
});

test("budget refusal wrapped in a provider 400 remains recognizable without leaking the body", () => {
  assert.throws(() => parsePromptResponse({
    info: { error: { name: "APIError", data: {
      statusCode: 400,
      responseBody: '{"error":"Budget has been exceeded", "api_key":"secret-test-value"}',
    } } }, parts: [],
  }), (error: unknown) => {
    assert.ok(error instanceof OpencodePromptError);
    assert.equal(error.status, 400);
    assert.match(error.message, /budget exceeded/);
    assert.doesNotMatch(String(error), /secret-test-value|api_key/);
    return true;
  });
});

test("ordinary provider and context errors never become budget pauses or success", () => {
  for (const detail of [
    { name: "APIError", data: { statusCode: 503, message: "temporarily unavailable" } },
    { name: "ContextOverflowError", data: { message: "context length exceeded" } },
    { name: "MessageAbortedError", data: {} },
  ]) {
    assert.throws(() => parsePromptResponse({ info: { error: detail }, parts: [] }), (error: unknown) => {
      assert.ok(error instanceof OpencodePromptError);
      assert.equal(error.errorType, detail.name);
      assert.doesNotMatch(error.message, /budget exceeded/);
      return true;
    });
  }
});

test("top-level or string errors are rejected and provider-controlled names are bounded", () => {
  for (const error of ["request failed", { name: "request contained secret-test-value" }, true]) {
    assert.throws(() => parsePromptResponse({ error }), (e: unknown) => {
      assert.ok(e instanceof OpencodePromptError);
      assert.equal(e.errorType, "ProviderError");
      assert.doesNotMatch(String(e), /secret-test-value/);
      return true;
    });
  }
});

test("successful responses retain text and raw artifact data", () => {
  const raw = { info: { role: "assistant" }, parts: [
    { type: "text", text: "Implemented" }, { type: "tool", state: { status: "completed" } },
    { type: "text", text: "Verified" },
  ] };
  assert.deepEqual(parsePromptResponse(raw), { text: "Implemented\nVerified", raw });
  assert.equal(parsePromptResponse({ text: "legacy" }).text, "legacy");
  assert.equal(parsePromptResponse({ message: { content: "legacy content" } }).text, "legacy content");
  assert.equal(parsePromptResponse({ info: { error: null }, parts: [] }).text, "");
});

test("HTTP 200 with malformed JSON is a protocol failure, not an empty successful diff", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("broken JSON", { status: 200 }));
  await assert.rejects(prompt("http://fake-worker", "session", {
    agent: "worker-build", model: "worker", text: "task",
  }), /InvalidJSON/);
  for (const malformed of [null, [], 7, {}, "text"]) {
    assert.throws(() => parsePromptResponse(malformed), /InvalidResponse/);
  }
});

test("non-200 provider responses keep the status and budget category but hide request details", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(
    'Budget exceeded; request Authorization=secret-test-value', { status: 429 },
  ));
  await assert.rejects(prompt("http://fake-worker", "session", {
    agent: "worker-build", model: "worker", text: "task",
  }), (error: unknown) => {
    assert.ok(error instanceof OpencodePromptError);
    assert.equal(error.status, 429);
    assert.match(error.message, /budget exceeded/);
    assert.doesNotMatch(String(error), /secret-test-value|Authorization/);
    return true;
  });
});

async function sessionServer(handler: import("node:http").RequestListener, run: (url: string) => Promise<void>) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.method === "GET" && ["/global/health", "/config"].includes(req.url ?? "")) {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url === "/config" ? { provider: { farm: {} } } : { healthy: true }));
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try { await run(`http://127.0.0.1:${port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("session startup retries a hung first POST and accepts the second response", async () => {
  let calls = 0;
  await sessionServer((_req, res) => {
    if (++calls === 1) return;
    res.setHeader("content-type", "application/json"); res.end('{"id":"session-recovered"}');
  }, async (url) => {
    assert.deepEqual(await createSession(url, undefined, { requestMs: 250, totalMs: 3000, retryDelayMs: 25 }), { id: "session-recovered" });
    assert.equal(calls, 2);
  });
});

test("repeated hung session requests stop at the absolute startup deadline", async () => {
  let calls = 0;
  await sessionServer(() => { calls++; }, async (url) => {
    const started = Date.now();
    await assert.rejects(createSession(url, undefined, { requestMs: 250, totalMs: 2500, retryDelayMs: 25 }), (err: unknown) => {
      assert.ok(err instanceof Error); assert.match(err.name, /TimeoutError|AbortError/); return true;
    });
    assert.ok(Date.now() - started < 5000);
    assert.ok(calls >= 2 && calls <= 10);
  });
});

test("external cancellation interrupts session startup including retry backoff", async () => {
  let calls = 0;
  const controller = new AbortController();
  await sessionServer(() => {
    calls++;
    // Trigger cancellation only after startup readiness completed and a POST arrived.
    setTimeout(() => controller.abort(), 500);
  }, async (url) => {
    await assert.rejects(createSession(url, controller.signal, { requestMs: 250, totalMs: 5000, retryDelayMs: 2000 }));
    assert.equal(calls, 1);
  });
});
