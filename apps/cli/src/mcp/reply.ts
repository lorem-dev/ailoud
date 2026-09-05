/**
 * How a tool answers.
 *
 * JSON in the text block rather than prose: an agent parses a structure far
 * more reliably than a sentence, and a field name is a smaller thing to agree
 * on than a phrasing.
 *
 * `fail` exists so that a refusal this code decides on is marked the same way
 * a thrown error is. Without it, "summarize needs ids" came back as an
 * ordinary success carrying an `error` field, so a client's error handling
 * never engaged and an agent had to notice the field to know it had failed.
 */
export function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function fail(value: unknown) {
  return { ...ok(value), isError: true as const };
}
