/*
 * Preloaded with `node --import` so the CLI can run without a network: every request is answered with
 * FAKE_CLASSIFIER_NOUL as the yes-probability of each question asked, or fails with FAKE_CLASSIFIER_STATUS when set.
 */
globalThis.fetch = async (_url, init) => {
  const status = Number(process.env.FAKE_CLASSIFIER_STATUS ?? 200);
  if (status !== 200) {
    return new Response("refused by the fake classifier", { status });
  }
  const { questions } = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
  const noul = Number(process.env.FAKE_CLASSIFIER_NOUL);
  const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul }]));
  return new Response(JSON.stringify({ answers }), { status: 200 });
};
