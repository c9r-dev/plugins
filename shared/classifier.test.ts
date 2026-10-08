import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, mock, test } from "node:test";

import {
  ClassifierError,
  classify,
  GATEWAY_CACHE_TTL_SECONDS,
  parseModel,
  replyFrom,
  requestFor,
  resolveModel,
} from "./classifier.ts";
import type { Questions } from "./classifier.ts";

const cloudflare = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" };
const gateway = { ...cloudflare, CLOUDFLARE_AI_GATEWAY: "gateway-name" };
const typesafe = { TYPESAFE_API_KEY: "key" };

describe("parseModel", () => {
  test("splits a provider-qualified name at the first colon, so a model id may hold colons", () => {
    assert.deepStrictEqual(parseModel("cloudflare:@cf/x:y"), {
      provider: "cloudflare",
      id: "@cf/x:y",
      name: "cloudflare:@cf/x:y",
    });
  });

  test("an unknown provider is an error naming both known ones", () => {
    assert.throws(() => parseModel("openai:gpt"), /must start with typesafe: or cloudflare:/u);
  });

  test("a name with no provider is an error", () => {
    assert.throws(() => parseModel("typesafe/jev"), /must start with typesafe: or cloudflare:/u);
  });

  test("a TypeSafe model id is left for TypeSafe to accept or refuse", () => {
    assert.equal(parseModel("typesafe:clef").id, "clef");
  });

  test("a provider with no model id is an error", () => {
    assert.throws(() => parseModel("cloudflare:"), /names no model id/u);
  });
});

describe("resolveModel", () => {
  test("with no model named and only TypeSafe credentials, it is Jev on TypeSafe", () => {
    assert.equal(resolveModel(typesafe, undefined, "TOOL_MODEL").name, "typesafe:jev-latest");
  });

  test("with no model named and only Cloudflare credentials, it is Jev on Cloudflare", () => {
    assert.equal(resolveModel(cloudflare, undefined, "TOOL_MODEL").name, "cloudflare:typesafe/jev");
  });

  test("with no model named and both providers' credentials, it is an error asking for the model setting", () => {
    assert.throws(
      () => resolveModel({ ...typesafe, ...cloudflare }, undefined, "TOOL_MODEL"),
      /ambiguous; set TOOL_MODEL, such as TOOL_MODEL=typesafe:jev-latest or TOOL_MODEL=cloudflare:typesafe\/jev$/u,
    );
  });

  test("with no model named and no credentials, it is an error naming both sets of variables", () => {
    assert.throws(
      () => resolveModel({}, undefined, "TOOL_MODEL"),
      /TOOL_MODEL is not set, so the classifier is Jev, which needs TYPESAFE_API_KEY, or CLOUDFLARE_ACCOUNT_ID and/u,
    );
  });

  test("half a set of Cloudflare credentials does not count", () => {
    assert.equal(resolveModel({ CLOUDFLARE_ACCOUNT_ID: "account", ...typesafe }, undefined, "TOOL_MODEL").name, "typesafe:jev-latest");
  });

  test("a named model settles the choice when both providers have credentials", () => {
    const model = resolveModel({ ...typesafe, ...cloudflare }, "cloudflare:@cf/cloudflare/clef", "TOOL_MODEL");
    assert.equal(model.id, "@cf/cloudflare/clef");
  });

  test("a named model whose provider lacks credentials is an error naming its variables", () => {
    assert.throws(
      () => resolveModel(typesafe, "cloudflare:typesafe/jev", "TOOL_MODEL"),
      /cloudflare:typesafe\/jev needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/u,
    );
  });
});

const isIt = { r: { type: "noul", instructions: "Is it?" } } satisfies Questions;
const state = { path: "a.ts", hunk: "+x" };
const jevOnCloudflare = parseModel("cloudflare:typesafe/jev");
const clef = parseModel("cloudflare:@cf/cloudflare/clef");
const jevOnTypesafe = parseModel("typesafe:jev-latest");

describe("requestFor", () => {
  test("goes through AI Gateway with the bare state and questions, asking it to cache for a month", async () => {
    const request = await requestFor(gateway, jevOnCloudflare, { state, questions: isIt });
    assert.deepStrictEqual(
      {
        url: request.url,
        auth: request.headers.get("Authorization"),
        ttl: request.headers.get("cf-aig-cache-ttl"),
        body: JSON.parse(request.body),
      },
      {
        url: "https://gateway.ai.cloudflare.com/v1/account/gateway-name/workers-ai/run/typesafe/jev",
        auth: "Bearer token",
        ttl: String(GATEWAY_CACHE_TTL_SECONDS),
        body: { state, questions: isIt },
      },
    );
  });

  test("the gateway cache key is the SHA-256 of the qualified model name and the exact body", async () => {
    const request = await requestFor(gateway, jevOnCloudflare, { state, questions: isIt });
    const expected = createHash("sha256")
      .update(JSON.stringify(["cloudflare:typesafe/jev", request.body]))
      .digest("hex");
    assert.equal(request.headers.get("cf-aig-cache-key"), expected);
  });

  test("the gateway cache key changes when a question changes", async () => {
    const keyFor = async (instructions: string) =>
      (
        await requestFor(gateway, jevOnCloudflare, { state, questions: { r: { type: "noul", instructions } } })
      ).headers.get("cf-aig-cache-key");
    assert.notEqual(await keyFor("Is it?"), await keyFor("Is it not?"));
  });

  test("the gateway cache key differs between models, since it overrides the model in the URL", async () => {
    const keyFor = async (name: string) =>
      (await requestFor(gateway, parseModel(name), { state, questions: isIt })).headers.get("cf-aig-cache-key");
    assert.notEqual(await keyFor("cloudflare:@cf/cloudflare/clef"), await keyFor("cloudflare:@cf/cloudflare/clef-flash"));
  });

  test("the model id goes into the gateway URL's path", async () => {
    const request = await requestFor(gateway, clef, { state, questions: isIt });
    assert.equal(
      request.url,
      "https://gateway.ai.cloudflare.com/v1/account/gateway-name/workers-ai/run/@cf/cloudflare/clef",
    );
  });

  test("images go into the request beside the state and questions", async () => {
    const images = ["data:image/png;base64,AAAA"];
    const request = await requestFor(cloudflare, clef, { state, images, questions: isIt });
    assert.deepStrictEqual(JSON.parse(request.body), {
      model: "@cf/cloudflare/clef",
      input: { state, questions: isIt, images },
    });
  });

  test("without a gateway, Cloudflare goes to /ai/run with the model id in the body and no cache headers", async () => {
    const request = await requestFor(cloudflare, jevOnCloudflare, { state, questions: isIt });
    assert.deepStrictEqual(
      { url: request.url, cacheKey: request.headers.get("cf-aig-cache-key"), body: JSON.parse(request.body) },
      {
        url: "https://api.cloudflare.com/client/v4/accounts/account/ai/run",
        cacheKey: null,
        body: { model: "typesafe/jev", input: { state, questions: isIt } },
      },
    );
  });

  test("TypeSafe gets its key and the model id alongside the state and questions", async () => {
    const request = await requestFor(typesafe, parseModel("typesafe:jev-latest"), { state, questions: isIt });
    assert.deepStrictEqual(
      { url: request.url, auth: request.headers.get("Authorization"), body: JSON.parse(request.body) },
      {
        url: "https://api.typesafe.ai/v1/systemone",
        auth: "Bearer key",
        body: { model: "jev-latest", state, questions: isIt },
      },
    );
  });
});

const pick = {
  target: { type: "choice", instructions: "Which?", criteria: { e1: "button OK", e2: "link Help" } },
} satisfies Questions;
const picked = { type: "choice", choice: "e2", confidence: 0.9, probabilities: { e1: 0.1, e2: 0.9 } };
const usage = { input_tokens: 1200, output_tokens: 3 };

const body = (answers: unknown) => JSON.stringify({ answers, usage });

describe("replyFrom", () => {
  const run = { answers: { r: { type: "noul", noul: 0.25 } }, usage };
  const expected = { answers: run.answers, usage: { input: 1200, output: 3 } };

  test("reads a run at the top level: TypeSafe, and Clef through AI Gateway", () => {
    assert.deepStrictEqual(replyFrom(JSON.stringify({ model: "clef", ...run }), isIt, 200), expected);
  });

  test("reads a run under result: Jev through AI Gateway", () => {
    assert.deepStrictEqual(replyFrom(JSON.stringify({ state: "Completed", result: run }), isIt, 200), expected);
  });

  test("reads a run under result: Clef through Workers AI's /ai/run", () => {
    assert.deepStrictEqual(replyFrom(JSON.stringify({ success: true, result: run }), isIt, 200), expected);
  });

  test("reads a run under result.result: Jev through Workers AI's /ai/run", () => {
    const text = JSON.stringify({ success: true, result: { state: "Completed", result: run } });
    assert.deepStrictEqual(replyFrom(text, isIt, 200), expected);
  });

  test("reads a choice answer", () => {
    assert.deepStrictEqual(replyFrom(body({ target: picked }), pick, 200).answers.target, picked);
  });

  test("missing or malformed usage is null, not zero", () => {
    const missing = JSON.stringify({ answers: { r: { type: "noul", noul: 0.5 } } });
    const malformed = JSON.stringify({
      answers: { r: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: "1200", output_tokens: 3 },
    });
    assert.deepStrictEqual([replyFrom(missing, isIt, 200).usage, replyFrom(malformed, isIt, 200).usage], [
      null,
      null,
    ]);
  });

  test("a noul outside 0 to 1 is rejected, naming the question", () => {
    assert.throws(() => replyFrom(body({ r: { type: "noul", noul: 1.5 } }), isIt, 200), /no valid answer for r$/u);
  });

  test("a missing answer is rejected, naming every unanswered question", () => {
    const both = { ...isIt, s: { type: "noul" } } satisfies Questions;
    assert.throws(() => replyFrom(body({}), both, 200), /no valid answer for r, s$/u);
  });

  test("an answer of the other question type is rejected", () => {
    assert.throws(() => replyFrom(body({ r: picked }), isIt, 200), /no valid answer for r$/u);
  });

  test("a choice that is not one of the question's labels is rejected", () => {
    assert.throws(() => replyFrom(body({ target: { ...picked, choice: "e3" } }), pick, 200), /for target$/u);
  });

  test("a choice whose label is only inherited, not one of the criteria, is rejected", () => {
    assert.throws(() => replyFrom(body({ target: { ...picked, choice: "toString" } }), pick, 200), /for target$/u);
  });

  test("a choice with a non-numeric probability is rejected", () => {
    const answer = { ...picked, probabilities: { e1: "0.1", e2: 0.9 } };
    assert.throws(() => replyFrom(body({ target: answer }), pick, 200), /for target$/u);
  });

  test("a choice with a confidence outside 0 to 1 is rejected", () => {
    assert.throws(() => replyFrom(body({ target: { ...picked, confidence: 2 } }), pick, 200), /for target$/u);
  });

  test("a Cloudflare body reporting failure is an error carrying its errors", () => {
    const text = JSON.stringify({ success: false, errors: [{ message: "quota" }] });
    assert.throws(() => replyFrom(text, isIt, 200), /quota/u);
  });

  test("a Cloudflare body reporting failure is a ClassifierError with the response's status", () => {
    const text = JSON.stringify({ success: false, errors: [{ message: "quota" }] });
    assert.throws(() => replyFrom(text, isIt, 200), (error) => error instanceof ClassifierError && error.status === 200);
  });

  test("a run that has not completed is an error", () => {
    const text = JSON.stringify({ result: { state: "Queued", result: {} } });
    assert.throws(() => replyFrom(text, isIt, 200), /state Queued/u);
  });

  test("a body without answers is an error", () => {
    assert.throws(() => replyFrom("{}", isIt, 200), /no answers/u);
  });
});

describe("classify", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Makes fetch answer with `status`, `text` and `headers`, recording the URL of each request. */
  const respond = (status: number, text: string, headers: Record<string, string> = {}): string[] => {
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(text, { status, headers });
    };
    return urls;
  };

  test("reports a gateway cache hit from the response header", async () => {
    respond(200, JSON.stringify({ result: JSON.parse(body({ r: { type: "noul", noul: 0.5 } })) }), {
      "cf-aig-cache-status": "HIT",
    });
    assert.equal((await classify(gateway, jevOnCloudflare, { state, questions: isIt })).gatewayHit, true);
  });

  test("a response without the cache header is not a hit", async () => {
    respond(200, body({ r: { type: "noul", noul: 0.5 } }));
    assert.equal((await classify(typesafe, jevOnTypesafe, { state, questions: isIt })).gatewayHit, false);
  });

  test("an HTTP error throws with the status and the body", async () => {
    respond(401, JSON.stringify({ detail: "invalid key" }));
    await assert.rejects(classify(typesafe, jevOnTypesafe, { state, questions: isIt }), /HTTP 401: .*invalid key/u);
  });

  test("an HTTP error carries its status and TypeSafe's error code", async () => {
    respond(400, JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }));
    await assert.rejects(
      classify(typesafe, jevOnTypesafe, { state, questions: isIt }),
      (error) => error instanceof ClassifierError && error.status === 400 && error.code === "max_tokens_exceeded",
    );
  });

  test("an HTTP error carries the code Cloudflare relays inside its error message", async () => {
    const relayed = 'Model execution failed (User Input Error): {"detail":{"error_type":"max_tokens_exceeded"}}';
    respond(400, JSON.stringify({ success: false, result: [], error: [{ code: 7003, message: relayed }] }));
    await assert.rejects(
      classify(typesafe, jevOnTypesafe, { state, questions: isIt }),
      (error) => error instanceof ClassifierError && error.code === "max_tokens_exceeded",
    );
  });

  test("an HTTP error whose body is not JSON carries no code", async () => {
    respond(500, "<html>down</html>");
    await assert.rejects(
      classify(typesafe, jevOnTypesafe, { state, questions: isIt }),
      (error) => error instanceof ClassifierError && error.status === 500 && error.code === undefined,
    );
  });

  test("a request that outlasts the timeout throws naming the timeout", async () => {
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await assert.rejects(classify(typesafe, jevOnTypesafe, { state, questions: isIt }, { timeoutMs: 20 }), /did not answer within 20ms/u);
  });

  /**
   * Runs `promise` to completion with setTimeout and Date mocked: each time the code under test is left waiting on a
   * timer, the mock clock jumps straight to it. Returns the outcome so a rejection can be asserted on.
   */
  async function onMockClock<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
    let outcome: PromiseSettledResult<T> | undefined;
    const settled = promise.then(
      (value) => (outcome = { status: "fulfilled", value }),
      (reason: unknown) => (outcome = { status: "rejected", reason }),
    );
    while (outcome === undefined) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.runAll();
    }
    await settled;
    return outcome;
  }

  /** Makes fetch answer each request with the next of `responses`, recording the mock clock's time at each. */
  const respondInTurn = (responses: (() => Response)[]): number[] => {
    const times: number[] = [];
    globalThis.fetch = async () => {
      times.push(Date.now());
      const next = responses[times.length - 1];
      assert.ok(next, `unexpected request ${times.length}`);
      return next();
    };
    return times;
  };

  const rateLimited = (headers: Record<string, string> = {}) => () =>
    new Response("rate limited", { status: 429, headers });
  const answered = () => new Response(body({ r: { type: "noul", noul: 0.5 } }), { status: 200 });

  describe("retries", () => {
    afterEach(() => {
      mock.timers.reset();
    });

    test("retries a rate-limited request and returns the answer that follows", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const times = respondInTurn([rateLimited(), rateLimited(), answered]);
      const outcome = await onMockClock(classify(typesafe, jevOnTypesafe, { state, questions: isIt }, { timeoutMs: 30_000 }));
      assert.deepStrictEqual(
        { status: outcome.status, requests: times.length },
        { status: "fulfilled", requests: 3 },
      );
    });

    for (const status of [502, 503, 504]) {
      test(`retries an HTTP ${status} from the gateway`, async () => {
        mock.timers.enable({ apis: ["setTimeout", "Date"] });
        const times = respondInTurn([() => new Response("unavailable", { status }), answered]);
        await onMockClock(classify(typesafe, jevOnTypesafe, { state, questions: isIt }, { timeoutMs: 30_000 }));
        assert.equal(times.length, 2);
      });
    }

    test("waits the seconds Retry-After gives before retrying", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const times = respondInTurn([rateLimited({ "Retry-After": "7" }), answered]);
      await onMockClock(classify(typesafe, jevOnTypesafe, { state, questions: isIt }, { timeoutMs: 30_000 }));
      assert.equal(times[1]! - times[0]!, 7000);
    });

    test("waits until the HTTP date Retry-After gives before retrying", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-01-01T00:00:00Z") });
      const times = respondInTurn([rateLimited({ "Retry-After": "Thu, 01 Jan 2026 00:00:05 GMT" }), answered]);
      await onMockClock(classify(typesafe, jevOnTypesafe, { state, questions: isIt }, { timeoutMs: 30_000 }));
      assert.equal(times[1]! - times[0]!, 5000);
    });

    test("gives up once the next wait would pass the deadline, naming the attempts", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      respondInTurn([rateLimited({ "Retry-After": "4" }), rateLimited({ "Retry-After": "4" }), rateLimited({ "Retry-After": "4" })]);
      const outcome = await onMockClock(classify(typesafe, jevOnTypesafe, { state, questions: isIt }, { timeoutMs: 10_000 }));
      assert.match(
        String(outcome.status === "rejected" && outcome.reason),
        /request failed after 3 attempts: HTTP 429: rate limited/u,
      );
    });

    test("gives up after five attempts even with no deadline", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const times = respondInTurn(Array.from({ length: 5 }, () => rateLimited()));
      const outcome = await onMockClock(classify(typesafe, jevOnTypesafe, { state, questions: isIt }));
      assert.deepStrictEqual(
        { status: outcome.status, requests: times.length },
        { status: "rejected", requests: 5 },
      );
    });

    test("does not retry a 400", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const times = respondInTurn([() => new Response("bad request", { status: 400 })]);
      await onMockClock(classify(typesafe, jevOnTypesafe, { state, questions: isIt }, { timeoutMs: 30_000 }));
      assert.equal(times.length, 1);
    });

    test("does not retry an invalid answer", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const times = respondInTurn([() => new Response(body({}), { status: 200 })]);
      await onMockClock(classify(typesafe, jevOnTypesafe, { state, questions: isIt }, { timeoutMs: 30_000 }));
      assert.equal(times.length, 1);
    });
  });
});
