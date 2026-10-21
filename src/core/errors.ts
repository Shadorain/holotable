/** The text of anything thrown: an Error's message, otherwise its string form. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
