import type { Locator, Page, TestInfo } from "@playwright/test";

import type { ChoiceQuestion, EntryType } from "./jev";
import { askJev, jevUsage } from "./jev";

export type StepKind = "click" | "type" | "goto" | "verify" | "other";
export type StepStatus = "passed" | "failed" | "unsupported";

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
};

export type QaReport = {
  steps: StepResult[];
  usage: { calls: number; input_tokens: number; output_tokens: number };
};

type Outcome = Pick<StepResult, "status" | "detail" | "confidence">;

/**
 * The step being run, the one before it (which Jev uses to resolve "then", "again" and "back"), and the actions
 * already carried out for this step, so a step that names several actions is worked through in order.
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

/*
 * Below this Jev confidence the chosen element is a guess, not the one the step names. Measured: right targets
 * score 0.89–1.00, while wrong ones ("External Contacts" for "Contacts", "Close" for "Write Retrospective") score
 * 0.38–0.53 and used to pass, surfacing as a failure several steps later.
 */
const ACTION_THRESHOLD = 0.7;
/** A verify passes when Jev puts at least this probability on the claim holding. */
const VERIFY_THRESHOLD = 0.7;
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

type Node = {
  ref: string;
  role: string;
  label: string;
  disabled: boolean;
  /** Playwright marks `[cursor=pointer]` on anything the page styles as clickable, whatever its role. */
  pointer: boolean;
};

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
 * interaction, so a disabled field counts: a copy-link field is often one.
 */
const mayHoldUrl = (node: Node) =>
  node.role === "link" ||
  TYPEABLE_ROLES.has(node.role) ||
  /https?:\/\//.test(node.label);

/**
 * The page as Playwright's accessibility tree with element refs. An open dialog is the whole tree, since nothing
 * behind it can be interacted with; the tree is what Jev reads for both element choice and verification.
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

/**
 * One interactive node of the accessibility tree, as Playwright's AI-mode snapshot prints it:
 * `- button "Menu" [ref=e12] [disabled] [cursor=pointer]`. The ref is a locator (`aria-ref=e12`). The label keeps
 * only the role and the accessible name: the bracketed annotations carry momentary state such as `[active]`, so a
 * label that included them would name a different element from one moment to the next.
 */
/** Every node in the tree that carries a ref, in document order. */
const nodesOf = (tree: string): Node[] =>
  [...tree.matchAll(/^\s*- (?<line>[^\n]*?\[ref=(?<ref>[a-z0-9]+)\][^\n]*)$/gm)].map(
    (match) => {
      const line = match.groups?.line ?? "";
      const ref = match.groups?.ref ?? "";
      const role = /^(?<role>[a-z]+)/.exec(line)?.groups?.role ?? "";
      return {
        ref,
        role,
        label: line
          .replace(/\s*\[[^\]]*\]/g, "")
          .replace(/:$/, "")
          .trim(),
        disabled: line.includes("[disabled]"),
        pointer: line.includes("[cursor=pointer]"),
      };
    },
  );

/*
 * A choice is scored only against the other options, so without a way out Jev picks the least-bad element even when
 * the step names one the page does not have ("Sign up" clicked "Learn more" at 0.88).
 */
const NONE = "none";

/**
 * Nodes as choice criteria keyed by ref, plus the option that no element matches. Jev has the tree in the state, so
 * a label needs no row context.
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

/** A node with no accessible name prints as its bare role, or with an empty name: `generic`, `textbox ""`. */
const isUnnamed = (description: string) => /^[a-z]+(\s+"")?$/.test(description);

/*
 * Refuse a target before acting on it, so a wrong click never leaves later steps on the wrong page. A confident
 * choice of an unnamed element is refused too: nothing in the tree ties it to the words of the step, so its score
 * says only that the page offered nothing better (an unnamed `textbox` scored 1.00 for "the End date field").
 */
const ensureTarget = (target: Target) => {
  if (isUnnamed(target.description)) {
    throw new Error(
      `chose ${target.description} with no accessible name (c=${target.confidence.toFixed(2)}); the tree cannot confirm it is the one the step names`,
    );
  }
  if (target.confidence < ACTION_THRESHOLD) {
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
 * Jev judges, it never generates, so it never writes a URL. A step either spells the destination out, or names
 * where on the page the URL is shown ("the URL in the Link field"): Jev picks that element like a click target,
 * and the value is read from the DOM unchanged.
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
  const { answers } = await askJev(stateFor(page, context, tree), {
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
  ensureTarget(holder);
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
 * The kind, a click target and a typing target are independent questions over the same page, so one Jev call
 * answers all three; the answers not matching the kind are simply unused. A verify is asked on its own: folded into
 * this call its verdicts drift towards the middle, and a check deserves the model's whole attention.
 */
const judgeStep = async (page: Page, context: StepContext, tree: string) => {
  const nodes = nodesOf(tree);
  const click = criteriaFor(nodes.filter(isActionable));
  const type = criteriaFor(nodes.filter(isTypeable));
  const { answers } = await askJev(
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
  const { answers } = await askJev(
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
    status: probability >= VERIFY_THRESHOLD ? "passed" : "failed",
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
 * One Jev call for the whole checklist before anything runs, one question per step, so steps the runner cannot
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
 * One Jev call for the whole checklist before anything runs: per step, whether the runner can judge it, and how
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
  const { answers } = await askJev({ checklist: numbered(steps) }, questions);
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
    const { answers } = await askJev(stateFor(page, context, tree), {
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
    ensureTarget(target);
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

const performJudged = async (
  page: Page,
  context: StepContext,
  judged: Awaited<ReturnType<typeof judgeStep>>,
  tree: string,
): Promise<Outcome> => {
  switch (judged.kind) {
    case "click": {
      if (!judged.click) {
        throw new Error("no element on the page matches the step");
      }
      ensureTarget(judged.click);
      await clickTarget(judged.click);
      await settle(page, context);
      return actionOutcome(judged.click);
    }
    case "type": {
      const payload = context.payloads.shift();
      if (payload === undefined) {
        return { status: "failed", detail: "no quoted text to type" };
      }
      if (!judged.type) {
        throw new Error("no field on the page matches the step");
      }
      ensureTarget(judged.type);
      await typeInto(page, judged.type, payload);
      await settle(page, context);
      return actionOutcome(judged.type);
    }
    case "goto":
      return performGoto(page, context, tree);
    case "verify":
      /* Jev sees only the accessibility tree, so its score on a visual claim is noise: the screenshot is the evidence. */
      return context.flag === "visual"
        ? {
            status: "unsupported",
            detail: `visual claim, not judged: the accessibility tree does not show it; judge step-${context.number}.png`,
          }
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
    const judged = await judgeStep(page, context, tree);
    kind = judged.kind;
    const outcome = await performJudged(page, context, judged, tree);
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

/* Written to the test's output directory, so it exists on disk whatever the reporter, and attached by path. */
const attachScreenshot = async (page: Page, testInfo: TestInfo, name: string) => {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
};

/**
 * Run a natural-language QA checklist against `page`, one line per step. Every step runs even after a failure, since
 * a wrong page makes later verifies fail and that is more informative than stopping. Failed and unsupported steps
 * attach a screenshot to the test.
 */
export const runQaSteps = async (
  page: Page,
  lines: string[],
  testInfo: TestInfo,
): Promise<QaReport> => {
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
    };
    const outcome = await runStep(page, context);
    const result: StepResult = {
      number: index + 1,
      step,
      ...outcome,
      elapsed_ms: Date.now() - started,
      flag: context.flag,
      settle_ms: context.settleMs,
    };
    results.push(result);
    /* Live progress: a long checklist is watched from the terminal while it runs. */
    console.log(
      `[qa] ${result.number} ${result.status}${result.flag === "ok" ? "" : ` (advisory: ${result.flag})`} ${result.kind} ${result.elapsed_ms}ms settle=${result.settle_ms}ms a=${context.actionBudget} c=${result.confidence?.toFixed(2) ?? "-"} ${step.slice(0, 70)} | ${result.detail.slice(0, 100)}`,
    );
    if (result.status !== "passed" || process.env.QA_SCREENSHOTS) {
      // oxlint-disable-next-line no-await-in-loop
      await attachScreenshot(page, testInfo, `step-${result.number}`);
    }
  }
  return { steps: results, usage: jevUsage() };
};
