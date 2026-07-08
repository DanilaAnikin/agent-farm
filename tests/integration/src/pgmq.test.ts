/**
 * Test 1 — pgmq round-trip proti ŽIVÉ frontě.
 *  - enqueue objekt → readOne vrátí deep-equal → ackDelete → fronta prázdná
 *  - extendVt: zpráva se skryje a po vypršení znovu objeví
 *  - více front je nezávislých
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { QUEUES, enqueue, readOne, ackDelete, extendVt } from "@farm/db";
import { purgeQueue, waitFor, decodeMsg, teardown } from "./helpers.js";

// Fronty (7×) jsou v prostředí už vytvořené migracemi; každý test si frontu
// před použitím vydrénuje → deterministický start bez ohledu na předchozí běhy.
after(teardown);

test("enqueue → readOne (deep-equal) → ackDelete → prázdno", async () => {
  await purgeQueue(QUEUES.tasks);
  const payload = {
    taskId: "11111111-1111-1111-1111-111111111111",
    kind: "code",
    attempt: 1,
    flags: { retry: false, shadow: true },
    tags: ["a", "b", "c"],
  };

  const msgId = await enqueue(QUEUES.tasks, payload);
  assert.ok(msgId, "enqueue vrátil msg_id");

  const got = await readOne<typeof payload>(QUEUES.tasks);
  assert.ok(got, "readOne našel zprávu");
  assert.deepStrictEqual(
    decodeMsg<typeof payload>(got!.message),
    payload,
    "zpráva se vrátila beze změny (round-trip integrity)",
  );
  assert.equal(got!.readCt, 1, "read_ct = 1 při prvním čtení");

  await ackDelete(QUEUES.tasks, got!.msgId);

  const empty = await readOne(QUEUES.tasks);
  assert.equal(empty, null, "po ackDelete je fronta prázdná");
});

test("readOne skryje zprávu na dobu vt (druhé čtení nic nevrátí)", async () => {
  await purgeQueue(QUEUES.media);
  await enqueue(QUEUES.media, { media: "reel-1" });

  const first = await readOne<{ media: string }>(QUEUES.media, 30);
  assert.ok(first, "první čtení zprávu dostalo");

  const second = await readOne(QUEUES.media, 30);
  assert.equal(second, null, "druhé čtení nic — zpráva je skrytá po dobu vt");

  await ackDelete(QUEUES.media, first!.msgId);
});

test("extendVt skryje zprávu a po vypršení se znovu objeví", async () => {
  await purgeQueue(QUEUES.judge);
  await enqueue(QUEUES.judge, { review: "attempt-9" });

  // Rezervuj na dlouho → skrytá.
  const got = await readOne<{ review: string }>(QUEUES.judge, 30);
  assert.ok(got, "zpráva přečtena a rezervována");
  assert.equal(await readOne(QUEUES.judge, 30), null, "hned poté je skrytá");

  // Zkrať viditelnost na 1 s → brzy se znovu objeví.
  await extendVt(QUEUES.judge, got!.msgId, 1);

  const reappeared = await waitFor(() => readOne<{ review: string }>(QUEUES.judge, 30), {
    timeoutMs: 8000,
    intervalMs: 250,
  });
  assert.ok(reappeared, "zpráva se po vypršení vt znovu objevila");
  assert.equal(reappeared!.msgId, got!.msgId, "je to tatáž zpráva");
  assert.ok(reappeared!.readCt >= 2, "read_ct narostl při opětovném čtení");

  await ackDelete(QUEUES.judge, reappeared!.msgId);
  assert.equal(await readOne(QUEUES.judge), null, "po acku prázdno");
});

test("více front je navzájem nezávislých", async () => {
  await purgeQueue(QUEUES.tasks);
  await purgeQueue(QUEUES.deploy);

  await enqueue(QUEUES.tasks, { which: "tasks" });
  await enqueue(QUEUES.deploy, { which: "deploy" });

  // q_tasks vrací jen svou zprávu; kompletně ji vyprázdníme.
  const t = await readOne<{ which: string }>(QUEUES.tasks);
  assert.equal(decodeMsg<{ which: string }>(t!.message).which, "tasks", "q_tasks vrací jen svou zprávu");
  await ackDelete(QUEUES.tasks, t!.msgId);
  assert.equal(await readOne(QUEUES.tasks), null, "q_tasks je po acku prázdná");

  // Operace nad q_tasks se NEDOTKLY q_deploy — ta má stále svou vlastní zprávu.
  const d = await readOne<{ which: string }>(QUEUES.deploy);
  assert.ok(d, "q_deploy má stále zprávu i po vyprázdnění q_tasks");
  assert.equal(decodeMsg<{ which: string }>(d!.message).which, "deploy", "q_deploy vrací jen svou zprávu");
  await ackDelete(QUEUES.deploy, d!.msgId);
  assert.equal(await readOne(QUEUES.deploy), null, "q_deploy prázdná");
});
