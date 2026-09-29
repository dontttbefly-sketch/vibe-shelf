import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPublicUsage } from "../lib/public-usage.mjs";
import { writeJsonAtomic, readJson } from "../lib/json-store.mjs";
import { makeTempDir } from "./helpers.mjs";

function setup(t) {
  const root = makeTempDir(t), dataDir = path.join(root, "data"), publicDir = path.join(root, "public");
  let clock = Date.UTC(2026, 8, 28);
  const options = { root, dataDir, publicDir, generationLimit: 2, now: () => clock };
  return { options, generation: id => path.join(dataDir, "projects", id, "generation.json"),
    advance: () => ++clock, publish: id => {
      const file = path.join(publicDir, "projects", id, "books", "main", "index.html");
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "delivered");
    } };
}

test("restart releases orphaned generation, marks retryable failure, and settles a delivered book once", t => {
  const state = setup(t), first = createPublicUsage(state.options);
  first.reserve("unfinished");
  writeJsonAtomic(state.generation("unfinished"), { status: "generating", stage: "writing", startedAt: state.advance(), updatedAt: state.advance() });
  first.reserve("finished");
  writeJsonAtomic(state.generation("finished"), { status: "ready", bookId: "main", startedAt: state.advance(), updatedAt: state.advance() });
  state.publish("finished");
  const restarted = createPublicUsage(state.options);
  assert.deepEqual(restarted.summary().generation, { limit: 2, used: 1, reserved: 0, remaining: 1 });
  assert.equal(readJson(state.generation("unfinished")).status, "failed");
  assert.match(readJson(state.generation("unfinished")).error, /重试/);
  assert.equal(restarted.summary().generation.used, 1);
  assert.ok(restarted.reserve("unfinished"));
});

test("old ready book or missing delivery cannot consume a crashed new reservation", t => {
  const state = setup(t);
  writeJsonAtomic(state.generation("old"), { status: "ready", bookId: "main", startedAt: 1, updatedAt: 2 });
  state.publish("old");
  const first = createPublicUsage(state.options);
  first.reserve("old");
  first.reserve("missing");
  writeJsonAtomic(state.generation("missing"), { status: "ready", bookId: "main", startedAt: state.advance(), updatedAt: state.advance() });
  const restarted = createPublicUsage(state.options);
  assert.deepEqual(restarted.summary().generation, { limit: 2, used: 0, reserved: 0, remaining: 2 });
});

test("generation identity distinguishes a new delivered run even when its timestamps equal the previous run", t => {
  const state = setup(t);
  const before = { status: "ready", bookId: "main", startedAt: 100, updatedAt: 100, generationId: "previous" };
  writeJsonAtomic(state.generation("quick"), before); state.publish("quick");
  const first = createPublicUsage(state.options);
  first.reserve("quick");
  writeJsonAtomic(state.generation("quick"), { ...before, generationId: "new" });
  assert.equal(first.summary().generation.used, 1);
});

test("shared model wrapper enforces two in-flight calls and counts failed attempts toward daily limit", async t => {
  const state = setup(t), usage = createPublicUsage({ ...state.options, dailyModelLimit: 2 });
  const finish = [];
  const client = usage.modelClient({ complete: () => new Promise((resolve, reject) => finish.push({ resolve, reject })) });
  const one = client.complete({}), two = client.complete({});
  await assert.rejects(client.complete({}), error => error.kind === "model-concurrency");
  finish[0].resolve("one"); finish[1].reject(new Error("controlled failure"));
  assert.equal(await one, "one"); await assert.rejects(two, /controlled failure/);
  await assert.rejects(client.complete({}), error => error.kind === "model-quota");
  assert.equal(usage.summary().model.used, 2);
});
