/** A failure the board shows to the operator as `<code>: <message>` with an HTTP status. */
export class ActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ActionError";
  }
}
