import { writeFileSync } from "node:fs";

import type { Locator, Page, TestInfo } from "@playwright/test";

import { evidenceFiles, keepsEvidence } from "./evidence";
import type { ChoiceQuestion, EntryType } from "./classifier";
import { askClassifier, classifierModel, classifierUsage } from "./ask";
import type { Thresholds } from "./thresholds";
import { thresholdsFor } from "./thresholds";
import type { Node } from "./tree";
import { isUnnamed, nodesOf } from "./tree";
import { judgeVisually } from "./visual";

export type StepKind = "click" | "type" | "goto" | "verify" | "other";
/**
 * `unsupported`: the step asks for something the page cannot do. `for-caller`: a visual claim, captured as a full-page
 * screenshot for the calling agent to judge, since the classifier reads only the accessibility tree. A visual claim is
 * `passed` only by the visual judge, when one is configured.
 */
export type StepStatus = "passed" | "failed" | "unsupported" | "for-caller";

/** Why a step cannot be judged from a settled page; `ok` means it can. */
export type StepFlag = "ok" | "transient" | "derived" | "visual" | "external";

export type StepResult = {
  /** 1-based position in the checklist. */
  number: number;
  step: string;
  kind: StepKind;
  status: StepStatus;
  /** The chosen element for an action, the yes-probability for a verify, or the reason for a failure. */
  detail: string;
  confidence?: number;
  elapsed_ms: number;
  /** Preflight verdict. A step flagged anything but `ok` runs as advisory: its result is reported but never fails the run. */
  flag: StepFlag;
  /** Time spent waiting for spinners, loading grids and the network after this step's actions. */
  settle_ms: number;
  /** Absolute path of this step's `step-N.png`, when one was taken. */
  screenshot?: string;
  /**
   * Absolute path of this step's `step-N.aria.yml`, the tree the classifier decided the step from, when one was
   * written.
   */
  tree?: string;
};

export type QaReport = {
  steps: StepResult[];
  usage: { calls: number; input_tokens: number; output_tokens: number };
};

type Outcome = Pick<StepResult, "status" | "detail" | "confidence">;

/**
 * The step being run, the one before it (which the classifier uses to resolve "then", "again" and "back"), and the
 * actions already carried out for this step, so a step that names several actions is worked through in order.
 */
type StepContext = {
  step: string;
  /** 1-based position of `step` in `checklist`. */
  number: number;
  /** Every step in the checklist, so "step 6", "the replacement text" and "again" resolve. */
  checklist: string[];
  actionsTaken: string[];
  /** Quoted payloads the step still has to type, in the order it names them. */
  payloads: string[];
  /** How many actions the step's wording names, counted in preflight. */
  actionBudget: number;
  /** Accumulated by `settle` across every action in the step. */
  settleMs: number;
  /** Preflight verdict for this step. */
  flag: StepFlag;
  /** The classifier model's thresholds for refusing a target and passing a verify. */
  thresholds: Thresholds;
  /*
   * The last tree fetched for this step, which is the one its outcome was decided from: a verify's judged tree, a
   * refused action's candidates, and for a step of several actions the tree its final choice was made from.
   */
  tree?: string;
};

/*
 * The shared state sees only the step itself: given the whole checklist, Jev runs ahead and performs the next step's
 * action as a follow-up. The verify question carries the checklist in its own instructions instead, so "the text
 * saved in step 6" still resolves.
 */
/*
 * Every element choice carries the page tree: offered bare labels, Jev put "none" at 0.47 against the Link field at
 * 0.40 for "the URL shown in the Link field", and 0.97 on the field once the tree was in view.
 */
const stateFor = (
  page: Page,
  { step, actionsTaken }: StepContext,
  tree: string,
) => ({
  step,
  actions_already_taken_for_this_step: actionsTaken,
  current_url: page.url(),
  page: { tree },
});

const numbered = (checklist: string[]) =>
  checklist.map((text, index) => `${index + 1}. ${text}`);

/** Jev accepts at most 255 choice labels. */
const MAX_CANDIDATES = 250;

const KINDS = {
  click:
    "Select, click, press, open, choose or navigate to something on the page (a button, link, row, menu item, tab, nav entry)",
  type: "Type, enter, fill, or replace text in a field or editor (the text to type is quoted in the step)",
  goto: "Open a URL or path in the browser address bar: one written out in the step, or one the page shows (a link, or a field or text holding a URL)",
  verify:
    "Confirm, check or assert something about what the page currently shows",
  other:
    "Anything the page cannot do by clicking, typing or opening a URL — keyboard shortcuts, external tools, a URL built from pieces the step describes",
};

/** Strip a leading `N.` or `N)` and drop blank lines. */
const parseSteps = (lines: string[]) =>
  lines
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);

/** A page still loading after this long is a failure of the step, not something to wait out. */
const SETTLE_TIMEOUT_MS = 8000;

/** Visible loading indicators: ARIA progress bars that say they are busy, and data grids showing skeleton rows. */
const LOADING_SELECTOR =
  '[role="progressbar"][aria-busy="true"]:visible, [data-is-loading="true"]:visible';

const TYPEABLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);

/*
 * Roles a user acts on. Candidates are limited to these (plus anything styled clickable) because the tree also
 * holds every paragraph, cell and wrapper: offered all of them in document order, the candidate cap was spent before
 * a drawer's tabs or a footer's buttons were reached.
 */
const ACTIONABLE_ROLES = new Set([
  ...TYPEABLE_ROLES,
  "button",
  "checkbox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

const isActionable = (node: Node) =>
  !node.disabled && (ACTIONABLE_ROLES.has(node.role) || node.pointer);

const isTypeable = (node: Node) =>
  !node.disabled && TYPEABLE_ROLES.has(node.role);

/**
 * Where a URL can be read from: a link's href, a field's value, or a node whose text shows one. Reading needs no
 * interaction, so a disabled field counts: a copy-link field is often one. Unnamed nodes are left out: the choice
 * would be refused anyway, and a page's icon-only links split the score, holding the right field near 0.72.
 */
const mayHoldUrl = (node: Node) =>
  !isUnnamed(node.label) &&
  (node.role === "link" ||
    TYPEABLE_ROLES.has(node.role) ||
    /https?:\/\//.test(node.label));

/**
 * The page as Playwright's accessibility tree with element refs. An open dialog is the whole tree, since nothing
 * behind it can be interacted with; the tree is what the classifier reads for both element choice and verification.
 */
const snapshotTree = async (page: Page) => {
  const dialog = page.locator('[role="dialog"]').last();
  const root = (await dialog.isVisible()) ? dialog : page.locator("body");
  return root.ariaSnapshot({ mode: "ai" });
};

/** How long the DOM must go without a mutation for the page to count as settled. */
const QUIET_MS = 250;

/*
 * Wait for the page to finish loading and charge the wait to the step, so a slow spinner shows in the report even
 * when it clears. Network idle is only a hint (long polls keep it from ever firing), so its timeout is not an error;
 * a loading indicator still visible at the deadline is.
 *
 * A loading indicator that has not appeared yet cannot be waited for, so the last wait is for the DOM to stop
 * mutating. Without it the next step can read a page that has not re-rendered yet and choose an element from the
 * page it is leaving.
 */
const settle = async (page: Page, context: StepContext) => {
  const started = Date.now();
  await page
    .waitForLoadState("networkidle", { timeout: 5000 })
    .catch(() => undefined);
  try {
    await page
      .locator(LOADING_SELECTOR)
      .first()
      .waitFor({ state: "hidden", timeout: SETTLE_TIMEOUT_MS });
    await page.evaluate(() => {
      const quiet = globalThis as unknown as {
        qaLastMutation?: number;
        qaObserver?: MutationObserver;
      };
      quiet.qaLastMutation = Date.now();
      quiet.qaObserver?.disconnect();
      quiet.qaObserver = new MutationObserver(() => {
        quiet.qaLastMutation = Date.now();
      });
      quiet.qaObserver.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });
    await page.waitForFunction(
      (quietMs) => {
        const quiet = globalThis as unknown as { qaLastMutation?: number };
        return Date.now() - (quiet.qaLastMutation ?? 0) >= quietMs;
      },
      QUIET_MS,
      { timeout: SETTLE_TIMEOUT_MS, polling: 50 },
    );
  } catch (error) {
    throw new Error(`page still loading after ${SETTLE_TIMEOUT_MS}ms`, {
      cause: error,
    });
  } finally {
    context.settleMs += Date.now() - started;
  }
};

type Target = {
  locator: Locator;
  description: string;
  confidence: number;
};

/*
 * A choice is scored only against the other options, so without a way out the classifier picks the least-bad element
 * even when the step names one the page does not have ("Sign up" clicked "Learn more" at 0.88).
 */
const NONE = "none";

/**
 * Nodes as choice criteria keyed by ref, plus the option that no element matches. The classifier has the tree in the
 * state, so a label needs no row context.
 */
const criteriaFor = (nodes: Node[]) => ({
  ...Object.fromEntries(
    nodes
      .slice(0, MAX_CANDIDATES)
      .map((node) => [node.ref, node.label]),
  ),
  [NONE]: "No element on the page is the one the step names",
});

const targetFrom = (
  page: Page,
  criteria: Record<string, string>,
  { choice, confidence }: { choice: string; confidence: number },
): Target | null =>
  choice === NONE || criteria[choice] === undefined
    ? null
    : {
        locator: page.locator(`aria-ref=${choice}`),
        description: criteria[choice],
        confidence,
      };

/*
 * Refuse a target before acting on it, so a wrong click never leaves later steps on the wrong page. A confident
 * choice of an unnamed element is refused too: nothing in the tree ties it to the words of the step, so its score
 * says only that the page offered nothing better (an unnamed `textbox` scored 1.00 for "the End date field").
 */
const ensureTarget = (target: Target, { action }: Thresholds) => {
  if (isUnnamed(target.description)) {
    throw new Error(
      `chose ${target.description} with no accessible name (c=${target.confidence.toFixed(2)}); the tree cannot confirm it is the one the step names`,
    );
  }
  if (target.confidence < action) {
    throw new Error(
      `uncertain target ${target.description} (c=${target.confidence.toFixed(2)})`,
    );
  }
};

const actionOutcome = ({ description, confidence }: Target): Outcome => ({
  status: "passed",
  detail: description,
  confidence,
});

/*
 * The shared config sets `actionTimeout: 0`, so a click on a wrong or obscured target would wait for the whole
 * test budget. Bound it, and name the target in the error so the report says what was chosen.
 */
const clickTarget = async (target: Target) => {
  try {
    await target.locator.click({ timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `click on ${target.description} failed: ${String(error).split("\n")[0]}`,
      { cause: error },
    );
  }
};

/*
 * Select-all before typing so the same action covers an empty field and a "replace the text" step; on an empty
 * field the selection is a no-op.
 */
const typeInto = async (page: Page, target: Target, payload: string) => {
  await clickTarget(target);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+A" : "Control+A",
  );
  await page.keyboard.type(payload);
};

/** The text between the first pair of straight or curly double quotes. */
/** Every double-quoted run in the step, straight or curly, in order: one per field the step fills. */
const quotedTexts = (step: string) =>
  [...step.matchAll(/["“](?<text>[^"”]*)["”]/g)].map(
    (match) => match.groups?.text ?? "",
  );

/** The URL an element holds, exactly as the DOM has it: a link's resolved href, a field's value, or its text. */
const urlHeldBy = async (target: Target) => {
  const held = await target.locator.evaluate(
    (element) =>
      (element instanceof HTMLAnchorElement && element.href) ||
      (element instanceof HTMLInputElement && element.value) ||
      (element instanceof HTMLTextAreaElement && element.value) ||
      element.textContent ||
      "",
  );
  return /https?:\/\/\S+/.exec(held)?.[0];
};

/*
 * The classifier judges, it never generates, so it never writes a URL. A step either spells the destination out, or
 * names where on the page the URL is shown ("the URL in the Link field"): the classifier picks that element like a
 * click target, and the value is read from the DOM unchanged.
 */
const performGoto = async (
  page: Page,
  context: StepContext,
  tree: string,
): Promise<Outcome> => {
  const written = /(?<url>https?:\/\/\S+|\/\S+)/.exec(context.step)?.groups?.url;
  if (written !== undefined) {
    await page.goto(new URL(written.replace(/[.,;)]+$/, ""), page.url()).href);
    await settle(page, context);
    return { status: "passed", detail: `opened ${written}` };
  }
  const criteria = criteriaFor(nodesOf(tree).filter(mayHoldUrl));
  const { answers } = await askClassifier(stateFor(page, context, tree), {
    holder: {
      type: "choice",
      instructions: "Which element holds the URL the step says to open?",
      criteria,
    },
  });
  const holder = targetFrom(page, criteria, answers.holder);
  if (!holder) {
    throw new Error("no element on the page holds the URL the step names");
  }
  ensureTarget(holder, context.thresholds);
  const url = await urlHeldBy(holder);
  if (url === undefined) {
    throw new Error(`${holder.description} holds no URL`);
  }
  await page.goto(url);
  await settle(page, context);
  return {
    status: "passed",
    detail: `opened ${url} from ${holder.description}`,
    confidence: holder.confidence,
  };
};

/** What a verify judges: the tree (dialog first when open, by construction) plus the page's visible text. */
const snapshotPage = async (page: Page, tree: string) => {
  const text = await page.locator("body").innerText();
  return {
    url: page.url(),
    title: await page.title(),
    dialog_open: await page.locator('[role="dialog"]').last().isVisible(),
    tree,
    text: text.replace(/\s+/g, " ").trim().slice(0, 6000),
  };
};

/*
 * The kind, a click target and a typing target are independent questions over the same page, so one classifier call
 * answers all three; the answers not matching the kind are simply unused. A verify is asked on its own: folded into
 * this call its verdicts drift towards the middle, and a check deserves the model's whole attention.
 */
const classifyStep = async (page: Page, context: StepContext, tree: string) => {
  const nodes = nodesOf(tree);
  const click = criteriaFor(nodes.filter(isActionable));
  const type = criteriaFor(nodes.filter(isTypeable));
  const { answers } = await askClassifier(
    stateFor(page, context, tree),
    {
      kind: {
        type: "choice",
        instructions: "What kind of QA step is this?",
        criteria: KINDS,
      },
      click: {
        type: "choice",
        instructions:
          "If the step is carried out by clicking, which element should be clicked?",
        criteria: click,
      },
      type: {
        type: "choice",
        instructions:
          "If the step is carried out by typing, which field or editor should the text be typed into?",
        criteria: type,
      },
    },
  );
  return {
    kind: answers.kind.choice,
    click: targetFrom(page, click, answers.click),
    type: targetFrom(page, type, answers.type),
  };
};

const performVerify = async (
  page: Page,
  context: StepContext,
  tree: string,
): Promise<Outcome> => {
  const { answers } = await askClassifier(
    {
      claim: context.step,
      claim_number: context.number,
      checklist: numbered(context.checklist),
      page: await snapshotPage(page, tree),
    },
    {
      holds: {
        type: "noul",
        instructions:
          "Does the current page satisfy this QA claim? Judge only what the snapshot shows.",
        criteria: {
          true: "Every part of the claim is supported by the snapshot, or describes a transient state (loading, a brief spinner) that has resolved into what the snapshot shows",
          false: "Some part of the claim is contradicted or not shown",
        },
      },
    },
  );
  const probability = answers.holds.noul;
  return {
    status: probability >= context.thresholds.verify ? "passed" : "failed",
    detail: `yes-probability ${probability.toFixed(2)}`,
    confidence: probability,
  };
};

const FLAGS: Record<StepFlag, string> = {
  ok: "Can be carried out by clicking something on the page, typing text that is quoted in the step, or opening a URL or path spelled out in full in the step or shown on the page (a link, or a field or text holding it); or can be checked from the page's accessibility tree once it has finished loading: which elements exist, their roles, labels, text, values and states (checked, expanded, disabled, selected)",
  transient:
    "Asserts a state that has passed by the time the page settles: a brief spinner, a flash, a loading skeleton, an animation, an in-between step",
  derived:
    "Needs a value the step describes but does not state in full and the page does not show whole: a URL built by replacing part of the current one, a computed date, text to type that is copied from elsewhere on the page",
  visual:
    "Is about how something looks or where it sits, which the accessibility tree does not record: an icon or image's appearance, colour, size, position, alignment, spacing, one element overlapping or covering another, text clipped, cut off or overflowing, smoothness, a screenshot comparison",
  external:
    "Happens outside the page: another tab or app, an email, a terminal, the system clock, a network condition",
};

/*
 * One classifier call for the whole checklist before anything runs, one question per step, so steps the runner cannot
 * judge are reported up front rather than as puzzling failures in the middle of a run. The checklist is the state,
 * so a step that refers to another ("the text saved in step 6") is judged with that step in view.
 */
/**
 * How many elements a step's wording says to interact with. Counting from the words alone is what keeps a step out
 * of the next one's work; a step's own quoted values raise the count, since each one needs a field of its own.
 */
const COUNTS = {
  "1": "One: the step names a single element to click, type into or open",
  "2": "Two, such as a field to fill and then a button to press, or two things to select in turn",
  "3": "Three",
  "4": "Four or more",
};

export type StepPlan = { flag: StepFlag; actions: number };

/*
 * One classifier call for the whole checklist before anything runs: per step, whether the runner can judge it, and how
 * many actions its wording names. Both are questions about the words, so they are asked with the checklist as the
 * state and no page in sight. The count bounds each step's actions exactly, which is what stops a step from
 * carrying on into the next one's work. The checklist is the state, so a step that refers to another
 * ("the text saved in step 6") is judged with that step in view.
 */
export const preflight = async (steps: string[]): Promise<StepPlan[]> => {
  const questions: Record<
    string,
    ChoiceQuestion<Record<string, EntryType>>
  > = Object.fromEntries(
    steps.flatMap((_step, index) => [
      [
        `flag${index + 1}`,
        {
          type: "choice" as const,
          instructions: `Can a browser test carry out step ${index + 1}, or check it, from the page once it has finished loading?`,
          criteria: FLAGS,
        },
      ],
      [
        `count${index + 1}`,
        {
          type: "choice" as const,
          instructions: `How many separate elements does step ${index + 1} say to interact with — every field it gives a value for, plus every control it says to click? Count only what its own words name.`,
          criteria: COUNTS,
        },
      ],
    ]),
  );
  const { answers } = await askClassifier({ checklist: numbered(steps) }, questions);
  return steps.map((_step, index) => {
    const flag = answers[`flag${index + 1}`]?.choice;
    return {
      flag: flag !== undefined && flag in FLAGS ? (flag as StepFlag) : "ok",
      actions: Number(answers[`count${index + 1}`]?.choice ?? 1),
    };
  });
};

/*
 * The actions a step names after its first: a field takes the step's next quoted value, anything else is clicked.
 * The loop runs exactly as many times as preflight counted, so a step stops when its own words are exhausted
 * rather than when the page stops offering something plausible to press.
 */
const followUpActions = async (page: Page, context: StepContext) => {
  const details: string[] = [];
  for (let taken = 1; taken < context.actionBudget; taken += 1) {
    const payload = context.payloads.shift();
    /* An already-filled field is not a candidate, so a second value cannot land in the first field. */
    // oxlint-disable-next-line no-await-in-loop -- each action depends on the page the previous one left
    const tree = await snapshotTree(page);
    context.tree = tree;
    const nodes = nodesOf(tree).filter(
      (node) =>
        (payload === undefined && isActionable(node)) ||
        (isTypeable(node) && !context.actionsTaken.includes(node.label)),
    );
    if (nodes.length === 0) {
      break;
    }
    const criteria = criteriaFor(nodes);
    // oxlint-disable-next-line no-await-in-loop
    const { answers } = await askClassifier(stateFor(page, context, tree), {
      target: {
        type: "choice",
        instructions:
          payload === undefined
            ? "Which element does the step say to act on next?"
            : "Which field should this step's next quoted value be typed into?",
        criteria,
      },
    });
    const target = targetFrom(page, criteria, answers.target);
    if (!target) {
      break;
    }
    ensureTarget(target, context.thresholds);
    // oxlint-disable-next-line no-await-in-loop
    await (payload === undefined
      ? clickTarget(target)
      : typeInto(page, target, payload));
    // oxlint-disable-next-line no-await-in-loop
    await settle(page, context);
    details.push(target.description);
    context.actionsTaken.push(target.description);
  }
  return details;
};

const performClassified = async (
  page: Page,
  context: StepContext,
  classified: Awaited<ReturnType<typeof classifyStep>>,
  tree: string,
): Promise<Outcome> => {
  switch (classified.kind) {
    case "click": {
      if (!classified.click) {
        throw new Error("no element on the page matches the step");
      }
      ensureTarget(classified.click, context.thresholds);
      await clickTarget(classified.click);
      await settle(page, context);
      return actionOutcome(classified.click);
    }
    case "type": {
      const payload = context.payloads.shift();
      if (payload === undefined) {
        return { status: "failed", detail: "no quoted text to type" };
      }
      if (!classified.type) {
        throw new Error("no field on the page matches the step");
      }
      ensureTarget(classified.type, context.thresholds);
      await typeInto(page, classified.type, payload);
      await settle(page, context);
      return actionOutcome(classified.type);
    }
    case "goto":
      return performGoto(page, context, tree);
    case "verify":
      /*
       * The classifier sees only the accessibility tree, so its score on a visual claim is noise: a screenshot decides
       * it.
       */
      return context.flag === "visual"
        ? judgeVisually(page, {
            claim: context.step,
            claimNumber: context.number,
            checklist: context.checklist,
          })
        : performVerify(page, context, tree);
    default:
      return { status: "unsupported", detail: context.step };
  }
};

const runStep = async (
  page: Page,
  context: StepContext,
): Promise<Pick<StepResult, "kind" | "status" | "detail" | "confidence">> => {
  let kind: StepKind = "other";
  try {
    await settle(page, context);
    const tree = await snapshotTree(page);
    context.tree = tree;
    const classified = await classifyStep(page, context, tree);
    kind = classified.kind;
    const outcome = await performClassified(page, context, classified, tree);
    if (outcome.status !== "passed" || (kind !== "click" && kind !== "type")) {
      return { kind, ...outcome };
    }
    context.actionsTaken.push(outcome.detail);
    const more = await followUpActions(page, context);
    return { kind, ...outcome, detail: [outcome.detail, ...more].join(" → ") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind,
      status: "failed",
      detail: [...context.actionsTaken, message.split("\n")[0]].join(" → "),
    };
  }
};

/*
 * Written to the test's output directory, so it exists on disk whatever the reporter, and attached by path. Returns
 * that path, which is absolute. A visual claim can be about anything on the page, so its screenshot is the full page;
 * any other shows the viewport, which is what the step acted on.
 */
const attachScreenshot = async (
  page: Page,
  testInfo: TestInfo,
  name: string,
  fullPage: boolean,
) => {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage });
  await testInfo.attach(name, { path, contentType: "image/png" });
  return path;
};

/* Beside the screenshot and attached the same way; returns the absolute path. */
const attachTree = async (testInfo: TestInfo, name: string, tree: string) => {
  const path = testInfo.outputPath(name);
  writeFileSync(path, tree);
  await testInfo.attach(name, { path, contentType: "text/yaml" });
  return path;
};

const liveStatus = ({ status, flag }: StepResult) => {
  if (status === "for-caller") {
    return "for-caller (visual: for you to judge)";
  }
  if (flag === "visual" && status === "passed") {
    return "passed (visual judge)";
  }
  return flag === "ok" ? status : `${status} (advisory: ${flag})`;
};

/**
 * Run a natural-language QA checklist against `page`, one line per step. Every step runs even after a failure, since
 * a wrong page makes later verifies fail and that is more informative than stopping. Every step that did not pass
 * attaches a screenshot and the tree the classifier decided it from.
 */
export const runQaSteps = async (
  page: Page,
  lines: string[],
  testInfo: TestInfo,
): Promise<QaReport> => {
  /* Resolved before any step runs, so a model without measured thresholds stops the run before it starts. */
  const model = classifierModel();
  const thresholds = thresholdsFor(model.name);
  console.log(`[qa] classifier ${model.name}`);
  const results: StepResult[] = [];
  const steps = parseSteps(lines);
  const plans = await preflight(steps);
  for (const [index, plan] of plans.entries()) {
    if (plan.flag !== "ok") {
      console.log(`[qa] preflight ${index + 1} ${plan.flag}: ${steps[index]}`);
    }
  }
  for (const [index, step] of steps.entries()) {
    const started = Date.now();
    // oxlint-disable-next-line no-await-in-loop -- steps depend on each other, so they must run in order
    const context: StepContext = {
      step,
      number: index + 1,
      checklist: steps,
      actionsTaken: [],
      payloads: quotedTexts(step),
      /* A quoted value needs a field of its own, so the step's own values are a floor under the counted budget. */
      actionBudget: Math.max(plans[index]?.actions ?? 1, quotedTexts(step).length),
      settleMs: 0,
      flag: plans[index]?.flag ?? "ok",
      thresholds,
    };
    const outcome = await runStep(page, context);
    const elapsed = Date.now() - started;
    let screenshot: string | undefined;
    let tree: string | undefined;
    if (keepsEvidence(outcome.status, Boolean(process.env.QA_SCREENSHOTS))) {
      const files = evidenceFiles(index + 1);
      // oxlint-disable-next-line no-await-in-loop
      screenshot = await attachScreenshot(
        page,
        testInfo,
        files.screenshot,
        outcome.status === "for-caller",
      );
      if (context.tree !== undefined) {
        // oxlint-disable-next-line no-await-in-loop
        tree = await attachTree(testInfo, files.tree, context.tree);
      }
    }
    const result: StepResult = {
      number: index + 1,
      step,
      ...outcome,
      elapsed_ms: elapsed,
      flag: context.flag,
      settle_ms: context.settleMs,
      screenshot,
      tree,
    };
    results.push(result);
    /* Live progress: a long checklist is watched from the terminal while it runs. */
    console.log(
      `[qa] ${result.number} ${liveStatus(result)} ${result.kind} ${result.elapsed_ms}ms settle=${result.settle_ms}ms a=${context.actionBudget} c=${result.confidence?.toFixed(2) ?? "-"} ${step.slice(0, 70)} | ${result.detail.slice(0, 100)}`,
    );
  }
  return { steps: results, usage: classifierUsage() };
};
