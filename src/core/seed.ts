/** Everything `new` accepts as structured data: what `--from` carries and the API posts. */
export interface SeedShape {
  name?: string;
  zones?: unknown[];
  contacts?: unknown[];
  workflow?: unknown[];
  notes?: string;
  brief?: string;
  auto?: unknown;
}

export function parseSeed(text: string, where: string): SeedShape {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot read ${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`${where}: expected a JSON object with zones, contacts, notes`);
  const file = raw as Record<string, unknown>;
  for (const key of ["zones", "contacts", "workflow"])
    if (key in file && !Array.isArray(file[key])) throw new Error(`${where}: ${key} must be an array`);
  for (const key of ["brief", "notes", "name"])
    if (key in file && typeof file[key] !== "string") throw new Error(`${where}: ${key} must be a string`);
  return file as SeedShape;
}
