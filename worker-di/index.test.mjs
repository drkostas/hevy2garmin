// Unit tests for the #214 rate-limit cooldown helpers in the DI Worker.
// Run: node --test worker-di/
//
// Covers the pure helpers (email hashing + remaining-seconds math) and the KV
// round-trip (set -> remaining > 0 -> clear -> remaining 0) against a Map-backed
// fake KV that mimics the Cloudflare KV get/put/delete surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker, {
  hashEmail,
  remainingSeconds,
  cooldownRemaining,
  setCooldown,
  clearCooldown,
} from "./index.js";

// A minimal fake of the Cloudflare KV binding.
function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

test("hashEmail is deterministic and normalizes case + whitespace", async () => {
  const a = await hashEmail("Foo@Example.com");
  const b = await hashEmail("  foo@example.com  ");
  assert.equal(a, b, "casing/whitespace variants hash the same");
  assert.match(a, /^[0-9a-f]{64}$/, "is a 64-char sha-256 hex");

  const c = await hashEmail("other@example.com");
  assert.notEqual(a, c, "different accounts hash differently");
});

test("remainingSeconds floors at 0 and ceils partial seconds", () => {
  const now = 1_000_000;
  assert.equal(remainingSeconds(now - 5000, now), 0, "past -> 0");
  assert.equal(remainingSeconds(now, now), 0, "exactly now -> 0");
  assert.equal(remainingSeconds(now + 7200_000, now), 7200, "2h future -> 7200");
  assert.equal(remainingSeconds(now + 1, now), 1, "partial second ceils up");
});

test("cooldown round-trip: set -> active -> clear", async () => {
  const env = { MFA_SESSIONS: fakeKV() };
  const email = "athlete@garmin.test";

  assert.equal(await cooldownRemaining(env, email), 0, "no cooldown initially");

  const secs = await setCooldown(env, email);
  assert.equal(secs, 7200, "cooldown length is the 2h base");

  const rem = await cooldownRemaining(env, email);
  assert.ok(rem > 7100 && rem <= 7200, `remaining ~2h, got ${rem}`);

  await clearCooldown(env, email);
  assert.equal(await cooldownRemaining(env, email), 0, "cleared -> 0");
});

test("cooldown is per-account (one account's cooldown doesn't gate another)", async () => {
  const env = { MFA_SESSIONS: fakeKV() };
  await setCooldown(env, "a@garmin.test");
  assert.ok((await cooldownRemaining(env, "a@garmin.test")) > 0, "a is gated");
  assert.equal(
    await cooldownRemaining(env, "b@garmin.test"),
    0,
    "b is not gated by a's cooldown",
  );
});

test("fails open when KV is unavailable", async () => {
  assert.equal(await cooldownRemaining({}, "x@garmin.test"), 0, "no binding -> 0");
  assert.equal(
    await cooldownRemaining(undefined, "x@garmin.test"),
    0,
    "no env -> 0",
  );

  const throwingEnv = {
    MFA_SESSIONS: {
      async get() {
        throw new Error("KV down");
      },
      async put() {
        throw new Error("KV down");
      },
      async delete() {
        throw new Error("KV down");
      },
    },
  };
  assert.equal(
    await cooldownRemaining(throwingEnv, "x@garmin.test"),
    0,
    "KV get error -> 0 (proceed to Garmin)",
  );
  // setCooldown still reports the cooldown length even if the KV write fails,
  // so the caller can tell the user the real 429 they just hit.
  assert.equal(
    await setCooldown(throwingEnv, "x@garmin.test"),
    7200,
    "KV put error -> still returns cooldown length",
  );
});

// ── Integration: drive the Worker's fetch handler with a mocked global fetch ──

function loginRequest(email, password = "pw") {
  return new Request("https://worker.test/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

test("a 429 from Garmin records a per-account cooldown (#214, constraint 3)", async () => {
  const env = { MFA_SESSIONS: fakeKV() };
  const email = "flow@garmin.test";
  const orig = globalThis.fetch;
  let loginPosts = 0;
  globalThis.fetch = async (_url, opts = {}) => {
    if ((opts.method || "GET") === "POST") {
      loginPosts += 1;
      return new Response("", { status: 429 }); // Garmin throttles the login POST
    }
    // warmup GET establishes cookies
    return new Response("", { status: 200, headers: { "set-cookie": "s=1" } });
  };
  try {
    const res = await worker.fetch(loginRequest(email), env);
    const body = await res.json();
    assert.equal(body.status, "rate_limited", "surfaces rate_limited");
    assert.equal(body.retry_after_seconds, 7200, "reports the cooldown length");

    // The cooldown must have landed in KV under THIS account's key.
    const hash = await hashEmail(email);
    assert.ok(
      env.MFA_SESSIONS.store.has("cooldown:" + hash),
      "cooldown key recorded for the account",
    );
    // And it must NOT gate a different account.
    assert.equal(
      await cooldownRemaining(env, "other@garmin.test"),
      0,
      "different account is not gated",
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("an active cooldown short-circuits /login WITHOUT calling Garmin (#214 pre-gate)", async () => {
  const email = "gated@garmin.test";
  const hash = await hashEmail(email);
  const env = { MFA_SESSIONS: fakeKV() };
  // Pre-seed an active cooldown (1h out).
  env.MFA_SESSIONS.store.set(
    "cooldown:" + hash,
    JSON.stringify({ until: Date.now() + 3600_000 }),
  );

  const orig = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Garmin must not be contacted during a cooldown");
  };
  try {
    const res = await worker.fetch(loginRequest(email), env);
    const body = await res.json();
    assert.equal(body.status, "rate_limited", "short-circuits to rate_limited");
    assert.ok(
      body.retry_after_seconds > 3500 && body.retry_after_seconds <= 3600,
      `reports the decaying remainder, got ${body.retry_after_seconds}`,
    );
    assert.equal(fetchCalls, 0, "Garmin was never contacted");
  } finally {
    globalThis.fetch = orig;
  }
});
