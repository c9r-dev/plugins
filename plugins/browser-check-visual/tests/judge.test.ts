import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import judge from "../judge.mjs";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const input = { claim: "Confirm the logo is centred", claimNumber: 2, checklist: ["Open /", "Confirm the logo is centred"], screenshot: PNG };
const realFetch = globalThis.fetch;
const SETTINGS = ["BROWSER_CHECK_VISUAL_ACCOUNT_ID", "BROWSER_CHECK_VISUAL_API_TOKEN", "BROWSER_CHECK_VISUAL_AI_GATEWAY", "BROWSER_CHECK_VISUAL_MODEL"];

type Request = { url: string; headers: Record<string, string>; body: any };

/** Replaces fetch with one that records the request and answers with `status` and `body`. */
const respond = (status: number, body: unknown) => {
  const requests: Request[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return requests;
};

const scored = (noul: number) => ({ result: { answers: { holds: { type: "noul", noul } } }, success: true });

describe("browser-check-visual judge", () => {
  beforeEach(() => {
    process.env.BROWSER_CHECK_VISUAL_ACCOUNT_ID = "acct";
    process.env.BROWSER_CHECK_VISUAL_API_TOKEN = "tok";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const name of SETTINGS) delete process.env[name];
  });

  it("sends the claim, the checklist and the screenshot as a data URL to Clef by default", async () => {
    const requests = respond(200, scored(0.9));
    await judge(input);
    const sent = requests[0]!;
    assert.equal(sent.url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/run");
    assert.equal(sent.headers.Authorization, "Bearer tok");
    assert.equal(sent.headers["cf-aig-gateway-id"], undefined);
    assert.equal(sent.body.model, "@cf/cloudflare/clef");
    assert.deepEqual(sent.body.input.state, { claim: input.claim, claim_number: 2, checklist: input.checklist });
    assert.deepEqual(sent.body.input.images, ["data:image/png;base64,iVBORw=="]);
    assert.equal(sent.body.input.questions.holds.type, "noul");
  });

  it("sends the gateway id and uses the configured model when set", async () => {
    process.env.BROWSER_CHECK_VISUAL_AI_GATEWAY = "gw";
    process.env.BROWSER_CHECK_VISUAL_MODEL = "@cf/cloudflare/clef-flash";
    const requests = respond(200, scored(0.9));
    await judge(input);
    assert.equal(requests[0]!.headers["cf-aig-gateway-id"], "gw");
    assert.equal(requests[0]!.body.model, "@cf/cloudflare/clef-flash");
  });

  it("passes at a score of 0.5", async () => {
    respond(200, scored(0.5));
    assert.deepEqual(await judge(input), { status: "passed", detail: "@cf/cloudflare/clef score 0.50" });
  });

  it("hands the step back below 0.5, with the score", async () => {
    respond(200, scored(0.49));
    assert.deepEqual(await judge(input), { status: "for-caller", detail: "@cf/cloudflare/clef score 0.49" });
  });

  it("throws on an error response, with its status and errors", async () => {
    respond(413, { success: false, errors: [{ message: "context window exceeded", code: 5021 }] });
    await assert.rejects(judge(input), /HTTP 413: .*context window exceeded/);
  });

  it("throws when the response has no score", async () => {
    respond(200, { success: true, result: {} });
    await assert.rejects(judge(input), /HTTP 200/);
  });

  it("throws when its own credentials are missing", async () => {
    delete process.env.BROWSER_CHECK_VISUAL_API_TOKEN;
    respond(200, scored(0.9));
    await assert.rejects(judge(input), /set BROWSER_CHECK_VISUAL_API_TOKEN/);
  });
});
