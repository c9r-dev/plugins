import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { thresholdsFor } from "../runner/engine/thresholds.ts";

describe("thresholdsFor", () => {
  it("gives Jev's measured thresholds under either provider's name for it", () => {
    assert.deepEqual(thresholdsFor("cloudflare:typesafe/jev"), { action: 0.7, verify: 0.7 });
    assert.deepEqual(thresholdsFor("typesafe:jev-latest"), { action: 0.7, verify: 0.7 });
  });

  it("refuses a model whose thresholds have not been measured, naming the ones that have", () => {
    assert.throws(
      () => thresholdsFor("cloudflare:@cf/cloudflare/clef"),
      /not been measured for cloudflare:@cf\/cloudflare\/clef yet.*typesafe:jev-latest, cloudflare:typesafe\/jev/,
    );
  });

  it("does not take an inherited property name for a measured model", () => {
    assert.throws(() => thresholdsFor("toString"), /not been measured/);
  });
});
