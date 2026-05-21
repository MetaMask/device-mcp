export function errorResult(error: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}
