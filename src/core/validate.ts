/** Canonical guard for untyped JSON input; every validator uses this one. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Invalid <kind> at <path>: <message>` thrower shared by all validators. */
export function invalidAt(
  kind: string,
  path: string,
): (message: string) => never {
  return (message: string): never => {
    throw new Error(`Invalid ${kind} at ${path}: ${message}`);
  };
}

/** `field must be one of …` member picker bound to a validator's `fail`. */
export function enumPicker(fail: (message: string) => never) {
  return <T extends string>(field: string, raw: unknown, allowed: readonly T[]): T => {
    if (typeof raw !== "string" || !allowed.includes(raw as T)) return fail(`${field} must be one of ${allowed.join(", ")}`);
    return raw as T;
  };
}

/** One serialized operation.json document never exceeds 1 MiB (UTF-8 bytes). */
export const MAX_OPERATION_BYTES = 1024 * 1024;
