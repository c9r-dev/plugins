import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import judge from "../judge.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const input = {
  claim: "Confirm the logo is centred",
  claimNumber: 2,
  checklist: ["Open /", "Confirm the logo is centred"],
  screenshot: PNG,
};
const realFetch = globalThis.fetch;
const SETTINGS = [
  "BROWSER_CHECK_VISUAL_MODEL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_AI_GATEWAY",
  "TYPESAFE_API_KEY",
];

/* The /ai/run body; a gateway request carries only `input`'s contents, which these tests do not read. */
type SentBody = {
  model: string;
  input: { state: unknown; images: string[]; questions: Record<string, { type: string }> };
};
type Sent = { url: string; headers: Headers; body: SentBody };

/** Replaces fetch with one that records the request and answers with `status` and `body`. */
const respond = (status: number, body: unknown) => {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return sent;
};

/* Clef's reply on Workers AI's /ai/run: the answers one level down, under `result`. */
const scored = (noul: number) => ({ success: true, result: { answers: { holds: { type: "noul", noul } } } });

describe("browser-check-visual judge", () => {
  beforeEach(() => {
    for (const name of SETTINGS) delete process.env[name];
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    process.env.CLOUDFLARE_API_TOKEN = "tok";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const name of SETTINGS) delete process.env[name];
  });

  it("sends the claim, the checklist and the screenshot as a data URL to Clef on Cloudflare by default", async () => {
    const sent = respond(200, scored(0.9));
    await judge(input);
    const request = sent[0]!;
    assert.equal(request.url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/run");
    assert.equal(request.headers.get("Authorization"), "Bearer tok");
    assert.equal(request.body.model, "@cf/cloudflare/clef");
    assert.deepEqual(request.body.input.state, { claim: input.claim, claim_number: 2, checklist: input.checklist });
    assert.deepEqual(request.body.input.images, ["data:image/png;base64,iVBORw=="]);
    assert.equal(request.body.input.questions["holds"]?.type, "noul");
  });

  it("reports the default model by its provider-qualified name", async () => {
    respond(200, scored(0.9));
    assert.match((await judge(input)).detail, /^cloudflare:@cf\/cloudflare\/clef score/);
  });

  it("uses the configured model, and caches through the gateway when one is set", async () => {
    process.env.CLOUDFLARE_AI_GATEWAY = "gw";
    process.env.BROWSER_CHECK_VISUAL_MODEL = "cloudflare:@cf/cloudflare/clef-flash";
    const sent = respond(200, { answers: { holds: { type: "noul", noul: 0.9 } } });
    await judge(input);
    assert.equal(sent[0]!.url, "https://gateway.ai.cloudflare.com/v1/acct/gw/workers-ai/run/@cf/cloudflare/clef-flash");
    assert.notEqual(sent[0]!.headers.get("cf-aig-cache-key"), null);
  });

  it("passes at a score of 0.5", async () => {
    respond(200, scored(0.5));
    assert.deepEqual(await judge(input), { status: "passed", detail: "cloudflare:@cf/cloudflare/clef score 0.50" });
  });

  it("hands the step back below 0.5, with the score", async () => {
    respond(200, scored(0.49));
    assert.deepEqual(await judge(input), { status: "for-caller", detail: "cloudflare:@cf/cloudflare/clef score 0.49" });
  });

  it("throws on an error response, with its status and errors", async () => {
    respond(413, { success: false, errors: [{ message: "context window exceeded", code: 5021 }] });
    await assert.rejects(judge(input), /HTTP 413: .*context window exceeded/);
  });

  it("throws when the response has no valid score", async () => {
    respond(200, { success: true, result: { answers: {} } });
    await assert.rejects(judge(input), /no valid answer for holds/);
  });

  it("throws when the provider's credentials are missing, naming them", async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    respond(200, scored(0.9));
    await assert.rejects(judge(input), /needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/);
  });

  it("refuses a model id without its provider", async () => {
    process.env.BROWSER_CHECK_VISUAL_MODEL = "@cf/cloudflare/clef";
    respond(200, scored(0.9));
    await assert.rejects(judge(input), /must start with typesafe: or cloudflare:/);
  });
});
