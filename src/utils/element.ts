import type { UIElement, ElementQuery } from '../backends/types.js';

/**
 * Finds the element that matches the query. An exact match anywhere in the
 * tree wins over an earlier fuzzy one (`account-picker` must not return
 * `account-picker-avatar`); otherwise the first fuzzy match is returned.
 *
 * @param elements - The hierarchy to search.
 * @param query - The query.
 * @returns The matching element, or null.
 */
export function findElement(
  elements: UIElement[],
  query: ElementQuery,
): UIElement | null {
  return findFirst(elements, query, true) ?? findFirst(elements, query, false);
}

/**
 * @param elements - The hierarchy to search.
 * @param query - The query.
 * @param exact - Whether every query field must equal the element's.
 * @returns The first matching element in tree order, or null.
 */
function findFirst(
  elements: UIElement[],
  query: ElementQuery,
  exact: boolean,
): UIElement | null {
  for (const el of elements) {
    if (matchesQuery(el, query, exact)) {
      return el;
    }
    if (el.children) {
      const found = findFirst(el.children, query, exact);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * The chain of ancestors of `target` in a hierarchy, root first and parent
 * last. The target itself is not included. Identity is by reference: pass an
 * element that came from `elements` (as `findElement` returns).
 *
 * @param elements - The hierarchy to search.
 * @param target - The element whose ancestors to collect.
 * @returns The ancestors, or `null` when `target` is not in the hierarchy.
 */
export function findAncestors(
  elements: UIElement[],
  target: UIElement,
): UIElement[] | null {
  for (const element of elements) {
    if (element === target) {
      return [];
    }
    if (!element.children) {
      continue;
    }
    const below = findAncestors(element.children, target);
    if (below) {
      return [element, ...below];
    }
  }
  return null;
}

/**
 * @param element - The element.
 * @param query - The query. Every given field must match.
 * @param exact - Require equal strings instead of a fuzzy match
 * (case-insensitive, contains). Default false.
 * @returns True when the element matches.
 */
export function matchesQuery(
  element: UIElement,
  query: ElementQuery,
  exact = false,
): boolean {
  const match = exact ? exactMatch : fuzzyMatch;
  if (query.identifier && !match(element.identifier, query.identifier)) {
    return false;
  }
  if (query.label && !match(element.label, query.label)) {
    return false;
  }
  if (
    query.text &&
    !match(element.value, query.text) &&
    !match(element.label, query.text)
  ) {
    return false;
  }
  if (query.type && !match(element.type, query.type)) {
    return false;
  }

  const hasAtLeastOneFilter =
    query.identifier ?? query.label ?? query.text ?? query.type;
  return Boolean(hasAtLeastOneFilter);
}

function exactMatch(actual: string | undefined, expected: string): boolean {
  return actual === expected;
}

function fuzzyMatch(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  if (actual === expected) {
    return true;
  }
  if (actual.toLowerCase() === expected.toLowerCase()) {
    return true;
  }
  return actual.toLowerCase().includes(expected.toLowerCase());
}

/**
 * Whether two elements have the same frame.
 *
 * @param a - One element.
 * @param b - The other element.
 * @returns True when the frames are equal.
 */
export function sameFrame(a: UIElement, b: UIElement): boolean {
  return (
    a.frame.x === b.frame.x &&
    a.frame.y === b.frame.y &&
    a.frame.width === b.frame.width &&
    a.frame.height === b.frame.height
  );
}

export function describeElement(element: UIElement): string {
  const parts: string[] = [element.type];
  if (element.label) {
    parts.push(`label="${element.label}"`);
  }
  if (element.identifier) {
    parts.push(`id="${element.identifier}"`);
  }
  if (element.value) {
    parts.push(`value="${element.value}"`);
  }
  return parts.join(' ');
}

export function computeSwipeEnd(
  startX: number,
  startY: number,
  direction: 'up' | 'down' | 'left' | 'right',
  distance: number,
): [number, number] {
  switch (direction) {
    case 'up':
      return [startX, startY - distance];
    case 'down':
      return [startX, startY + distance];
    case 'left':
      return [startX - distance, startY];
    case 'right':
      return [startX + distance, startY];
    default:
      return [startX, startY];
  }
}

export type LocatorSuggestion = {
  strategy: 'identifier' | 'label' | 'text' | 'type';
  value: string;
  confidence: 'high' | 'medium' | 'low';
};

export type ElementLocator = {
  description: string;
  frame: { x: number; y: number; width: number; height: number };
  suggestions: LocatorSuggestion[];
};

const INTERACTIVE_TYPES = new Set([
  'Button',
  'TextField',
  'SecureTextField',
  'Switch',
  'Slider',
  'Picker',
  'Link',
  'SearchField',
  'TextArea',
  'Tab',
  'MenuItem',
  'Cell',
  'android.widget.Button',
  'android.widget.EditText',
  'android.widget.CheckBox',
  'android.widget.RadioButton',
  'android.widget.Switch',
  'android.widget.ToggleButton',
  'android.widget.Spinner',
  'android.widget.SeekBar',
  'android.widget.ImageButton',
]);

function isInteractive(element: UIElement): boolean {
  if (INTERACTIVE_TYPES.has(element.type)) {
    return true;
  }
  for (const t of INTERACTIVE_TYPES) {
    if (element.type.includes(t)) {
      return true;
    }
  }
  return element.enabled && Boolean(element.identifier);
}

function buildSuggestions(element: UIElement): LocatorSuggestion[] {
  const suggestions: LocatorSuggestion[] = [];

  if (element.identifier) {
    suggestions.push({
      strategy: 'identifier',
      value: element.identifier,
      confidence: 'high',
    });
  }

  if (element.label) {
    suggestions.push({
      strategy: 'label',
      value: element.label,
      confidence: element.identifier ? 'medium' : 'high',
    });
  }

  if (element.value && element.value !== element.label) {
    suggestions.push({
      strategy: 'text',
      value: element.value,
      confidence: 'low',
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      strategy: 'type',
      value: element.type,
      confidence: 'low',
    });
  }

  return suggestions;
}

export function generateLocators(elements: UIElement[]): ElementLocator[] {
  const results: ElementLocator[] = [];
  collectLocators(elements, results);
  return results;
}

function collectLocators(
  elements: UIElement[],
  results: ElementLocator[],
): void {
  for (const el of elements) {
    if (isInteractive(el)) {
      const suggestions = buildSuggestions(el);
      results.push({
        description: describeElement(el),
        frame: el.frame,
        suggestions,
      });
    }
    if (el.children) {
      collectLocators(el.children, results);
    }
  }
}

export function formatLocators(locators: ElementLocator[]): string {
  if (locators.length === 0) {
    return 'No interactive elements found on screen.';
  }

  const confidenceIcon: Record<string, string> = {
    high: '***',
    medium: '**',
    low: '*',
  };

  return locators
    .map((loc, i) => {
      const header = `${i + 1}. ${loc.description} (${loc.frame.x},${loc.frame.y} ${loc.frame.width}x${loc.frame.height})`;
      const strategies = loc.suggestions
        .map(
          (s) =>
            `   ${confidenceIcon[s.confidence]} { ${s.strategy}: "${s.value}" }`,
        )
        .join('\n');
      return `${header}\n${strategies}`;
    })
    .join('\n\n');
}

export function formatHierarchy(elements: UIElement[], depth: number): string {
  const indent = '  '.repeat(depth);
  return elements
    .map((el) => {
      const parts = [`${indent}[${el.type}]`];
      if (el.label) {
        parts.push(`label="${el.label}"`);
      }
      if (el.identifier) {
        parts.push(`id="${el.identifier}"`);
      }
      if (el.value) {
        parts.push(`value="${el.value}"`);
      }
      parts.push(
        `(${el.frame.x},${el.frame.y} ${el.frame.width}x${el.frame.height})`,
      );
      if (!el.enabled) {
        parts.push('DISABLED');
      }

      let result = parts.join(' ');
      if (el.children?.length) {
        result += `\n${formatHierarchy(el.children, depth + 1)}`;
      }
      return result;
    })
    .join('\n');
}

/**
 * The center of the part of the element's frame that lies inside the
 * viewport. Tapping there is safer than tapping the raw frame center, which
 * can fall outside the screen for off-screen or partly scrolled elements and
 * hit nothing or an unrelated control.
 *
 * @param element - The element to tap.
 * @param viewport - The viewport size, in the frame's units.
 * @param viewport.width - Viewport width.
 * @param viewport.height - Viewport height.
 * @returns The tap point.
 * @throws An error with `code: 'ELEMENT_NOT_IN_VIEWPORT'` when the frame
 * does not intersect the viewport (or has no area).
 */
export function visibleCenter(
  element: UIElement,
  { width, height }: { width: number; height: number },
): { x: number; y: number } {
  const x0 = Math.max(element.frame.x, 0);
  const y0 = Math.max(element.frame.y, 0);
  const x1 = Math.min(element.frame.x + element.frame.width, width);
  const y1 = Math.min(element.frame.y + element.frame.height, height);
  if (x1 <= x0 || y1 <= y0) {
    throw Object.assign(
      new Error(
        `Element is outside the ${width}x${height} viewport: ` +
          `${describeElement(element)} at (${Math.round(element.frame.x)}, ` +
          `${Math.round(element.frame.y)} ${Math.round(element.frame.width)}x` +
          `${Math.round(element.frame.height)}). ` +
          'Scroll it into view first (device_swipe or scroll_to_element).',
      ),
      { code: 'ELEMENT_NOT_IN_VIEWPORT' },
    );
  }
  return {
    x: Math.round((x0 + x1) / 2),
    y: Math.round((y0 + y1) / 2),
  };
}
