/**
 * One interactive node of the accessibility tree, as Playwright's AI-mode snapshot prints it:
 * `- button "Menu" [ref=e12] [disabled] [cursor=pointer]`. The ref is a locator (`aria-ref=e12`). The label keeps
 * only the role and the accessible name: the bracketed annotations carry momentary state such as `[active]`, so a
 * label that included them would name a different element from one moment to the next.
 */
export type Node = {
  ref: string;
  role: string;
  label: string;
  /** The accessible name: printed, or for a role named from content rebuilt from what it holds. */
  name: string | undefined;
  disabled: boolean;
  /** Playwright marks `[cursor=pointer]` on anything the page styles as clickable, whatever its role. */
  pointer: boolean;
};

/** A snapshot line in the `role "name" [annotation]… [: value]` form, its scalars both as printed and as text. */
type Head = {
  role: string;
  name?: { printed: string; text: string };
  /** Each one bracketed as printed: `[ref=e12]`, `[checked]`. */
  annotations: string[];
  value?: { printed: string; text: string };
};

/**
 * One line of the snapshot and the lines nested under it. A line outside the head form, such as the property
 * `- /url: /reports`, is kept as printed.
 */
type Entry = { head: Head | string; children: Entry[] };

/** A snapshot parsed once, for every question asked about it: a large page's tree runs to hundreds of KB. */
export type ParsedTree = { readonly entries: Entry[] };

/*
 * The roles ARIA 1.2 names from their content (https://www.w3.org/TR/wai-aria-1.2/#namefromcontent). Containers
 * are left out on purpose: they never take a name from content, and their subtree text would put whole page sections
 * into every candidate label.
 */
const NAMED_FROM_CONTENT = new Set([
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "rowheader",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
]);

/** Roles that take typed text. */
export const TYPEABLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);

/*
 * Roles a user acts on. Candidates are limited to these (plus anything styled clickable) because the tree also
 * holds every paragraph, cell and wrapper: offered all of them in document order, the candidate cap was spent before
 * a drawer's tabs or a footer's buttons were reached.
 */
const CONTROL_ROLES = new Set([
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

/** A node a click step may act on: a control, or anything the page styles as clickable. */
export const isActionable = (node: Node) => !node.disabled && (CONTROL_ROLES.has(node.role) || node.pointer);

/** A field a typing step may type into. */
export const isTypeable = (node: Node) => !node.disabled && TYPEABLE_ROLES.has(node.role);

/** A YAML scalar as Playwright writes it: plain, or double-quoted with JSON escapes plus `\xNN`. */
const unquote = (scalar: string): string =>
  scalar.startsWith('"')
    ? (JSON.parse(
        scalar.replace(/\\(?:x([0-9a-f]{2})|[\s\S])/g, (escape, hex?: string) =>
          hex === undefined ? escape : `\\u00${hex}`,
        ),
      ) as string)
    : scalar;

const scalarOf = (printed: string | undefined) =>
  printed === undefined ? undefined : { printed, text: unquote(printed) };

const headOf = (line: string): Head | string => {
  const parts =
    /^- (?<role>[a-z]+)(?: (?<name>"(?:[^"\\]|\\.)*"))?(?<annotations>(?: \[[^\]]*\])*)(?::(?: (?<value>.*))?)?$/.exec(
      line,
    )?.groups;
  if (parts?.role === undefined) {
    return line;
  }
  return {
    role: parts.role,
    name: scalarOf(parts.name),
    annotations: [...(parts.annotations ?? "").matchAll(/\[[^\]]*\]/g)].map(([annotation]) => annotation),
    value: scalarOf(parts.value),
  };
};

/** The snapshot as a tree: a line indented deeper than the one before it is nested under that one. */
export const parseTree = (snapshot: string): ParsedTree => {
  const entries: Entry[] = [];
  const open: { indent: number; children: Entry[] }[] = [{ indent: -1, children: entries }];
  for (const line of snapshot.split("\n")) {
    const text = line.trimStart();
    if (text === "") {
      continue;
    }
    const indent = line.length - text.length;
    while ((open.at(-1)?.indent ?? -1) >= indent) {
      open.pop();
    }
    const entry: Entry = { head: headOf(text), children: [] };
    open.at(-1)?.children.push(entry);
    open.push({ indent, children: entry.children });
  }
  return { entries };
};

const refIn = (annotation: string) => /^\[ref=(?<ref>[a-z0-9]+)\]$/.exec(annotation)?.groups?.ref;

const refOf = (head: Head) => head.annotations.map(refIn).find((ref) => ref !== undefined);

/**
 * The text `entries` contribute, in document order. `textOf` says what an entry contributes itself: a string, or
 * undefined to take what its children contribute. A `/url`-style property contributes nothing.
 */
const textWithin = (entries: Entry[], textOf: (head: Head) => string | undefined): string =>
  entries
    .map(({ head, children }) => (typeof head === "string" ? "" : (textOf(head) ?? textWithin(children, textOf))))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/*
 * An entry's printed name or inline value stands for its whole subtree, as in accessible-name computation; `skipped`
 * refs, and everything they hold, contribute nothing.
 */
const contentWithout = (entries: Entry[], skipped: ReadonlySet<string>) =>
  textWithin(entries, (head) => {
    const ref = refOf(head);
    return ref !== undefined && skipped.has(ref) ? "" : (head.name?.text ?? head.value?.text);
  });

const NOTHING_SKIPPED: ReadonlySet<string> = new Set();

/*
 * Playwright's AI mode drops a name computed from content that it still prints as children (`removeRedundantNames`),
 * so `<button><p>Save</p></button>` prints as a bare `button`. Rebuilding the name keeps such a control choosable.
 * `skipped` refs are left out of a rebuilt name.
 */
const nameOf = (head: Head, children: Entry[], skipped = NOTHING_SKIPPED) => {
  if (head.name !== undefined) {
    return head.name.text;
  }
  if (head.value !== undefined || !NAMED_FROM_CONTENT.has(head.role)) {
    return undefined;
  }
  const content = contentWithout(children, skipped);
  return content === "" ? undefined : content;
};

/** A head as printed, with the given annotations: `button "Menu" [ref=e12]`, `paragraph: Text`. */
const printedHead = (head: Head, annotations: readonly string[]) => {
  const name = head.name === undefined ? "" : ` ${head.name.printed}`;
  const value = head.value === undefined ? "" : `: ${head.value.printed}`;
  return `${head.role}${name}${annotations.map((annotation) => ` ${annotation}`).join("")}${value}`;
};

const labelOf = (head: Head, name: string | undefined) =>
  head.name === undefined && name !== undefined ? `${head.role} ${JSON.stringify(name)}` : printedHead(head, []);

const nodesWithin = (entries: Entry[]): Node[] =>
  entries.flatMap(({ head, children }) => {
    const ref = typeof head === "string" ? undefined : refOf(head);
    if (typeof head === "string" || ref === undefined) {
      return nodesWithin(children);
    }
    const name = nameOf(head, children);
    const node: Node = {
      ref,
      role: head.role,
      label: labelOf(head, name),
      name,
      disabled: head.annotations.includes("[disabled]"),
      pointer: head.annotations.includes("[cursor=pointer]"),
    };
    return [node, ...nodesWithin(children)];
  });

/** Every node in the tree that carries a ref, in document order. */
export const nodesOf = (tree: ParsedTree): Node[] => nodesWithin(tree.entries);

/** A node with no accessible name prints as its bare role, or with an empty name: `generic`, `textbox ""`. */
export const isUnnamed = (description: string) => /^[a-z]+(\s+"")?$/.test(description);

const firstNameIn = (entries: Entry[]): string | undefined => {
  for (const { head, children } of entries) {
    const name = typeof head === "string" ? undefined : (head.name?.text ?? firstNameIn(children));
    if (name !== undefined) {
      return name;
    }
  }
  return undefined;
};

/*
 * A heading's own text, for telling copies apart. Its accessible name joins every descendant, so `## Install` with
 * an anchor link and a "Post a comment" button would read "Install Install # Post a comment"; the text outside its
 * named descendants, or else the first of their names, is the heading as a reader sees it.
 */
const headingTextOf = (head: Head, children: Entry[]) =>
  head.name?.text ??
  head.value?.text ??
  (textWithin(children, (child) => (child.name === undefined ? child.value?.text : "")) ||
    firstNameIn(children) ||
    "");

/*
 * A named node as context for what it holds: its printed name, or for a role named from content (a row) its own
 * text, the cells it shows without the controls among them ("Select row", "Open menu") that every row repeats.
 */
const ancestorOf = (head: Head, children: Entry[], candidates: ReadonlySet<string>) => {
  const name = nameOf(head, children, candidates);
  if (name === undefined || name.trim() === "") {
    return undefined;
  }
  return { printed: `${head.role} ${head.name?.printed ?? JSON.stringify(name)}`, name };
};

/** Where a node sits: the heading it is inside or follows, and its named ancestors, innermost first. */
type Place = {
  heading?: { text: string; inside: boolean };
  ancestors: string[];
};

const placesOf = (tree: ParsedTree, refs: ReadonlySet<string>, candidates: ReadonlySet<string>) => {
  const places = new Map<string, Place>();
  let lastHeading: string | undefined;
  const walk = (entries: Entry[], ancestors: { printed: string; name: string }[], inHeading?: string) => {
    for (const { head, children } of entries) {
      if (typeof head === "string") {
        walk(children, ancestors, inHeading);
        continue;
      }
      const isHeading = head.role === "heading";
      if (isHeading) {
        lastHeading = headingTextOf(head, children);
      }
      const ref = refOf(head);
      if (ref !== undefined && refs.has(ref)) {
        const own = nameOf(head, children);
        const heading = inHeading ?? lastHeading;
        places.set(ref, {
          heading: heading === undefined ? undefined : { text: heading, inside: inHeading !== undefined },
          /* An ancestor named as the node itself, such as a clickable row wrapper, tells nothing apart. */
          ancestors: ancestors.filter(({ name }) => name !== own).map(({ printed }) => printed),
        });
      }
      const ancestor = isHeading ? undefined : ancestorOf(head, children, candidates);
      const within = ancestor === undefined ? ancestors : [ancestor, ...ancestors];
      walk(children, within, isHeading ? lastHeading : inHeading);
    }
  };
  walk(tree.entries, []);
  return places;
};

type Parts = { heading: boolean; ancestors: number };

const describe = ({ heading, ancestors }: Place, parts: Parts) =>
  [
    ...(parts.heading && heading !== undefined
      ? [`${heading.inside ? "in" : "under"} heading ${JSON.stringify(heading.text)}`]
      : []),
    ...ancestors.slice(0, parts.ancestors).map((ancestor) => `in ${ancestor}`),
  ].join(", ");

/** The part sets to try, fewest first: the heading, the nearest ancestor, both, two ancestors, both and two, … */
const partSets = (depth: number): Parts[] => [
  { heading: true, ancestors: 0 },
  ...Array.from({ length: depth }, (_, index) => [
    { heading: false, ancestors: index + 1 },
    { heading: true, ancestors: index + 1 },
  ]).flat(),
];

/** How many times each of `labels` occurs. */
export const countsOf = (labels: string[]) => {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
};

/**
 * Copies of one element, each labelled `<label> — <context>` with the fewest parts of its place on the page that tell
 * it from the others: the heading it follows or is inside, and its named ancestors. When nothing tells every copy
 * apart, each gets its fullest context, so copies that still read the same show as equal labels. `candidates` are
 * the refs the choice offers, whose names a row's context leaves out.
 */
export const withContext = <Copy extends { ref: string; label: string }>(
  tree: ParsedTree,
  copies: Copy[],
  candidates: ReadonlySet<string>,
): Copy[] => {
  const places = placesOf(tree, new Set(copies.map(({ ref }) => ref)), candidates);
  const placeOf = (ref: string) => places.get(ref) ?? { ancestors: [] };
  const depth = Math.max(0, ...copies.map(({ ref }) => placeOf(ref).ancestors.length));
  /*
   * Copies of one element may differ in label already (an icon's text before a node's name), so the labels with
   * their context are what must differ.
   */
  const labelledBy = (parts: Parts) =>
    copies.map(({ ref, label }) => {
      const description = describe(placeOf(ref), parts);
      return description === "" ? label : `${label} — ${description}`;
    });
  const tellsApart = (labels: string[]) => countsOf(labels).size === labels.length;
  const distinguishing = partSets(depth).find((parts) => tellsApart(labelledBy(parts)));
  const labels = labelledBy(distinguishing ?? { heading: true, ancestors: depth });
  return copies.map((copy, index) => ({ ...copy, label: labels[index] ?? copy.label }));
};

/**
 * The refs of the nodes around `ref` and inside it: its wrappers, its row, its own checkbox or expand button. A
 * click on any of them is a click on the same control, so none of them is a copy of it.
 */
export const lineageOf = (tree: ParsedTree, ref: string): ReadonlySet<string> => {
  const walk = (entries: Entry[], ancestors: string[]): string[] | undefined => {
    for (const { head, children } of entries) {
      const own = typeof head === "string" ? undefined : refOf(head);
      if (own === ref) {
        return [...ancestors, ...nodesWithin(children).map((node) => node.ref)];
      }
      const found = walk(children, own === undefined ? ancestors : [...ancestors, own]);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return new Set(walk(tree.entries, []));
};

const WORD_START = /^[\p{L}\p{N}]/u;
const WORD_END = /[\p{L}\p{N}]$/u;

/** Whether `text` occurs in `name` as whole words: `3` does in `Option 3 (X-3)`, not in `Option 13`. */
const holdsWords = (name: string, text: string) => {
  for (let at = name.indexOf(text); at !== -1; at = name.indexOf(text, at + 1)) {
    const before = name.slice(0, at);
    const after = name.slice(at + text.length);
    const runsOnBefore = WORD_END.test(before) && WORD_START.test(text);
    const runsOnAfter = WORD_START.test(after) && WORD_END.test(text);
    if (!runsOnBefore && !runsOnAfter) {
      return true;
    }
  }
  return false;
};

/**
 * Whether two candidates may name one element as a step would: the same label, or names one of which holds the
 * other as whole words, whatever the roles. A tree node's name often carries its icon's text before it
 * (`treeitem "down parent 1-2"` around `generic "parent 1-2"`), so the copies a step's words fit differ in more than
 * position.
 */
export const isCopyOf = (
  candidate: { label: string; name: string | undefined },
  other: { label: string; name: string | undefined },
) => {
  if (candidate.label === other.label) {
    return true;
  }
  const { name } = candidate;
  const otherName = other.name;
  if (name === undefined || otherName === undefined || name === "" || otherName === "") {
    return false;
  }
  return holdsWords(name, otherName) || holdsWords(otherName, name);
};

const isBareGeneric = (head: Head) =>
  head.role === "generic" && head.name === undefined && head.annotations.length === 0 && head.value === undefined;

/*
 * The faithful tree keeps refs only where offered, drops every `[cursor=pointer]` and splices out a bare generic of at
 * most one entry. The compact tree also drops a text leaf an enclosing or sibling name holds and a name a child
 * repeats; on a technique grid those two took Jev from 0.94 to 0.70 on a claim about which checkboxes were ticked, so
 * they are kept for a tree that does not fit otherwise.
 */
type Trim = { offered: ReadonlySet<string>; compact: boolean };

/*
 * A text leaf an enclosing or sibling name already holds, such as `paragraph: X-3` under `generic "Option 3 (X-3)"`.
 * A control's value is its state, not text, so `textbox: hello` is never one.
 */
const isEchoedText = (head: Head, children: Entry[], enclosingNames: string[], siblingNames: string[]) => {
  const text = head.value?.text;
  if (
    text === undefined ||
    CONTROL_ROLES.has(head.role) ||
    head.name !== undefined ||
    head.annotations.length > 0 ||
    children.length > 0
  ) {
    return false;
  }
  const holds = (name: string) => holdsWords(name, text);
  return enclosingNames.some(holds) || siblingNames.some(holds);
};

const trimmed = (entries: Entry[], enclosingNames: string[], rules: Trim): Entry[] => {
  const siblingNames = rules.compact
    ? entries.flatMap(({ head }) => (typeof head === "string" || head.name === undefined ? [] : [head.name.text]))
    : [];
  return entries.flatMap(({ head, children }): Entry[] => {
    if (typeof head === "string") {
      return [{ head, children: trimmed(children, enclosingNames, rules) }];
    }
    const annotations = head.annotations.filter((annotation) => {
      const ref = refIn(annotation);
      return annotation !== "[cursor=pointer]" && (ref === undefined || rules.offered.has(ref));
    });
    if (rules.compact && isEchoedText({ ...head, annotations }, children, enclosingNames, siblingNames)) {
      return [];
    }
    const kept = trimmed(
      children,
      head.name === undefined || !rules.compact ? enclosingNames : [...enclosingNames, head.name.text],
      rules,
    );
    const { name } = head;
    const repeated =
      rules.compact &&
      name !== undefined &&
      kept.some((child) => typeof child.head !== "string" && child.head.name?.text === name.text);
    const rewritten: Head = { ...head, annotations, name: repeated ? undefined : name };
    return isBareGeneric(rewritten) && kept.length <= 1 ? kept : [{ head: rewritten, children: kept }];
  });
};

const lineOf = (head: Head | string, hasChildren: boolean) => {
  if (typeof head === "string") {
    return head;
  }
  return `- ${printedHead(head, head.annotations)}${head.value === undefined && hasChildren ? ":" : ""}`;
};

const printed = (entries: Entry[], depth: number): string[] =>
  entries.flatMap(({ head, children }) => [
    " ".repeat(depth) + lineOf(head, children.length > 0),
    ...printed(children, depth + 1),
  ]);

/*
 * The tree as sent to Jev, at one space of indent per level, faithful or compact as `rules` says. A ref is how an
 * answer names an element, so it is left only on the nodes a question offers; refs are the bulk of a large tree's
 * tokens (on a 108 KB tree of 1,524 refs Jev counted 28.7k input tokens with every ref, 17.5k with none).
 */
export const treeForJev = (tree: ParsedTree, rules: Trim) => printed(trimmed(tree.entries, [], rules), 0).join("\n");
