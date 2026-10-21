/** The text of anything thrown: an Error's message, otherwise its string form. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The caller's input was rejected (validation, unknown field or value): a 400 on the board API. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** The request collides with what already exists (an id taken): a 409 on the board API. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Runs code that only checks or applies the caller's input. A plain `Error` from it is a validator
 * rejecting that input and becomes an InputError; typed errors and TypeErrors from bugs keep their meaning.
 */
export function asInput<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) throw new InputError(error.message);
    throw error;
  }
}
