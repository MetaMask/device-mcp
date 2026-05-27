import type { UIElement, ElementQuery } from '../backends/types.js';

export function findElement(
  elements: UIElement[],
  query: ElementQuery,
): UIElement | null {
  for (const el of elements) {
    if (matchesQuery(el, query)) {
      return el;
    }
    if (el.children) {
      const found = findElement(el.children, query);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export function matchesQuery(element: UIElement, query: ElementQuery): boolean {
  if (query.identifier && !fuzzyMatch(element.identifier, query.identifier)) {
    return false;
  }
  if (query.label && !fuzzyMatch(element.label, query.label)) {
    return false;
  }
  if (
    query.text &&
    !fuzzyMatch(element.value, query.text) &&
    !fuzzyMatch(element.label, query.text)
  ) {
    return false;
  }
  if (query.type && !fuzzyMatch(element.type, query.type)) {
    return false;
  }

  const hasAtLeastOneFilter =
    query.identifier ?? query.label ?? query.text ?? query.type;
  return Boolean(hasAtLeastOneFilter);
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
