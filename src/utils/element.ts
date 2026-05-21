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
