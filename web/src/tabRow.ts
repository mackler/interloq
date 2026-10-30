// Where a row of tabs that scrolls sideways must stand so that its selected tab is in view (pure, no DOM; issue #202).
// M3's scrollable tabs keep the selected tab in view; ScrollableTabs.svelte applies this to the row's scrollLeft rather
// than calling Element.scrollIntoView, which may also scroll the page and the run area vertically.

/** A horizontal extent in CSS pixels: where it starts and how wide it is. */
export type Span = Readonly<{ left: number; width: number }>;

/** The scrollLeft a row of tabs needs so that `tab` lies wholly in view, changing nothing when it already is. */
export const tabScrollLeft = (view: Span, tab: Span, scrollWidth: number): number => {
  const max = Math.max(0, scrollWidth - view.width);
  const wanted =
    tab.width > view.width || tab.left < view.left
      ? tab.left // a tab wider than the view shows its start, which holds its name
      : tab.left + tab.width > view.left + view.width
        ? tab.left + tab.width - view.width
        : view.left;
  return Math.min(max, Math.max(0, wanted));
};
