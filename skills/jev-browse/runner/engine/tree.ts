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
  disabled: boolean;
  /** Playwright marks `[cursor=pointer]` on anything the page styles as clickable, whatever its role. */
  pointer: boolean;
};

/** One `- ` entry of the snapshot: `role "name" [annotation]…`, then `:` and an inline value or child entries. */
type Entry = {
  depth: number;
  body: string;
  role: string;
  name?: string;
  value?: string;
};

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

/** A YAML scalar as Playwright writes it: plain, or double-quoted with JSON escapes plus `\xNN`. */
const unquote = (scalar: string): string =>
  scalar.startsWith('"')
    ? (JSON.parse(
        scalar.replace(/\\(?:x([0-9a-f]{2})|[\s\S])/g, (escape, hex?: string) =>
          hex === undefined ? escape : `\\u00${hex}`,
        ),
      ) as string)
    : scalar;

const entriesOf = (tree: string): Entry[] =>
  [...tree.matchAll(/^(?<indent>\s*)- (?<body>[^\n]*)$/gm)].map((match) => {
    const body = match.groups?.body ?? "";
    const parts =
      /^(?<role>[a-z]+)(?: (?<name>"(?:[^"\\]|\\.)*"))?(?: \[[^\]]*\])*(?::(?: (?<value>.*))?)?$/.exec(body)?.groups;
    return {
      depth: match.groups?.indent.length ?? 0,
      body,
      role: parts?.role ?? "",
      name: parts?.name === undefined ? undefined : unquote(parts.name),
      value: parts?.value === undefined ? undefined : unquote(parts.value),
    };
  });

/**
 * The text an entry's descendants contribute to a name, in document order. A descendant's printed name or inline
 * value stands for its whole subtree, as in accessible-name computation; `/url`-style properties are not content.
 */
const contentOf = (descendants: Entry[]) => {
  const texts: string[] = [];
  let skipBelow = Number.POSITIVE_INFINITY;
  for (const entry of descendants) {
    if (entry.depth > skipBelow) {
      continue;
    }
    skipBelow = Number.POSITIVE_INFINITY;
    const text = entry.body.startsWith("/") ? "" : (entry.name ?? entry.value);
    if (text !== undefined) {
      texts.push(text);
      skipBelow = entry.depth;
    }
  }
  return texts.join(" ").replace(/\s+/g, " ").trim();
};

/** The entries nested under the one at `index`: those after it, up to the next at its depth or shallower. */
const descendantsOf = (entries: Entry[], index: number) => {
  const depth = entries[index]?.depth ?? 0;
  const end = entries.findIndex((other, at) => at > index && other.depth <= depth);
  return entries.slice(index + 1, end === -1 ? undefined : end);
};

/*
 * Playwright's AI mode drops a name computed from content that it still prints as children (`removeRedundantNames`),
 * so `<button><p>Save</p></button>` prints as a bare `button`. Rebuilding the name keeps such a control choosable.
 */
const labelOf = (entry: Entry, descendants: Entry[]) => {
  const label = entry.body
    .replace(/\s*\[[^\]]*\]/g, "")
    .replace(/:$/, "")
    .trim();
  if (entry.name !== undefined || entry.value !== undefined || !NAMED_FROM_CONTENT.has(entry.role)) {
    return label;
  }
  const name = contentOf(descendants);
  return name === "" ? label : `${entry.role} ${JSON.stringify(name)}`;
};

/** Every node in the tree that carries a ref, in document order. */
export const nodesOf = (tree: string): Node[] => {
  const entries = entriesOf(tree);
  return entries.flatMap((entry, index) => {
    const ref = /\[ref=(?<ref>[a-z0-9]+)\]/.exec(entry.body)?.groups?.ref;
    if (ref === undefined) {
      return [];
    }
    return [
      {
        ref,
        role: /^(?<role>[a-z]+)/.exec(entry.body)?.groups?.role ?? "",
        label: labelOf(entry, descendantsOf(entries, index)),
        disabled: entry.body.includes("[disabled]"),
        pointer: entry.body.includes("[cursor=pointer]"),
      },
    ];
  });
};

/** A node with no accessible name prints as its bare role, or with an empty name: `generic`, `textbox ""`. */
export const isUnnamed = (description: string) => /^[a-z]+(\s+"")?$/.test(description);
