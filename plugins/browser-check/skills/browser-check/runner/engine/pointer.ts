/**
 * The element a user clicks to act on `control`: the control itself, or one of its labels. HTML gives a label its
 * control's activation behaviour, so a click on either is the same action. A styled checkbox often hides its input
 * and draws the box beside it inside the label, which the pointer then reaches only through the label; a visually
 * hidden label is the reverse. The first of them the pointer reaches at its centre wins, the control first; when none
 * is reached the control is returned, so Playwright's actionability check reports what covers it.
 *
 * Runs in the page, so it must not reference anything outside its own body.
 */
export const pointerTargetOf = (control: Element): Element => {
  const reachedAtCentre = (element: Element) => {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const box = element.getBoundingClientRect();
    const root = element.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot)) {
      return false;
    }
    const hit = root.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && element.contains(hit);
  };
  const labels =
    "labels" in control && control.labels instanceof NodeList
      ? [...control.labels].filter((label) => label instanceof HTMLLabelElement)
      : [];
  return [control, ...labels].find(reachedAtCentre) ?? control;
};
