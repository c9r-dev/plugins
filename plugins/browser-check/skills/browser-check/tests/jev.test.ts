import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { askJev, chooseRoute } from "../runner/engine/jev.ts";

const CLOUDFLARE = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "cf-token" };
const TYPESAFE = { TYPESAFE_API_KEY: "ts-key" };

describe("chooseRoute", () => {
  it("uses the only route whose credentials are set", () => {
    assert.equal(chooseRoute(CLOUDFLARE), "cloudflare");
    assert.equal(chooseRoute(TYPESAFE), "typesafe");
  });

  it("does not count half a set of Cloudflare credentials", () => {
    assert.equal(chooseRoute({ CLOUDFLARE_ACCOUNT_ID: "acct", ...TYPESAFE }), "typesafe");
  });

  it("requires JEV_ROUTE when both are set, and follows it", () => {
    assert.throws(() => chooseRoute({ ...CLOUDFLARE, ...TYPESAFE }), /set JEV_ROUTE=cloudflare or JEV_ROUTE=typesafe/);
    assert.equal(chooseRoute({ ...CLOUDFLARE, ...TYPESAFE, JEV_ROUTE: "typesafe" }), "typesafe");
    assert.equal(chooseRoute({ ...CLOUDFLARE, ...TYPESAFE, JEV_ROUTE: "cloudflare" }), "cloudflare");
  });

  it("refuses a JEV_ROUTE without its credentials, or an unknown one", () => {
    assert.throws(() => chooseRoute({ ...CLOUDFLARE, JEV_ROUTE: "typesafe" }), /needs TYPESAFE_API_KEY/);
    assert.throws(() => chooseRoute({ ...CLOUDFLARE, JEV_ROUTE: "vercel" }), /must be cloudflare or typesafe/);
  });

  it("names both routes when no credentials are set", () => {
    assert.throws(() => chooseRoute({}), /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or TYPESAFE_API_KEY/);
  });
});

describe("askJev", () => {
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = { ...saved };
  });

  /** Sets the environment to exactly `env` and makes fetch record its request and answer with `status` and `body`. */
  const respond = (env: Record<string, string>, status: number, body: unknown) => {
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_AI_GATEWAY", "TYPESAFE_API_KEY", "JEV_ROUTE"]) {
      delete process.env[name];
    }
    Object.assign(process.env, env);
    const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return sent;
  };

  const questions = { holds: { type: "noul" as const, instructions: "Is it so?" } };
  const run = { answers: { holds: { type: "noul", noul: 0.98 } }, usage: { input_tokens: 341, output_tokens: 47 } };

  it("calls TypeSafe directly and reads the answers at the top level", async () => {
    const sent = respond(TYPESAFE, 200, { model: "jev-1.13.0", ...run });
    const result = await askJev({ page: "x" }, questions);
    assert.equal(result.answers.holds.noul, 0.98);
    assert.equal(sent[0]!.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(sent[0]!.headers.Authorization, "Bearer ts-key");
    assert.deepEqual(sent[0]!.body, { model: "jev-latest", state: { page: "x" }, questions });
  });

  it("calls Workers AI and reads the answers inside its envelope, with the gateway header when set", async () => {
    const sent = respond({ ...CLOUDFLARE, CLOUDFLARE_AI_GATEWAY: "default" }, 200, { success: true, result: { result: run } });
    const result = await askJev({ page: "x" }, questions);
    assert.equal(result.answers.holds.noul, 0.98);
    assert.equal(sent[0]!.url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/run");
    assert.equal(sent[0]!.headers["cf-aig-gateway-id"], "default");
    assert.deepEqual(sent[0]!.body, { model: "typesafe/jev", input: { state: { page: "x" }, questions } });
  });

  it("throws with the status when TypeSafe answers with an error", async () => {
    respond(TYPESAFE, 401, { detail: "invalid key" });
    await assert.rejects(askJev({}, questions), /HTTP 401: .*invalid key/);
  });
});
