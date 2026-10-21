import { open, mkdir, rename, rm, link } from "fs/promises";
import { randomBytes } from "crypto";
import { join } from "path";
import { messageOf } from "../core/errors.ts";

/** Write file atomically using tmp and rename. Includes fsync. */
export async function writeFileAtomic(target: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomBytes(12).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(tmp, "w", mode);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, target);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Create file exclusively, atomically writing its contents. Fails with EEXIST if present. */
export async function createFileAtomic(target: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomBytes(12).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(tmp, "w", mode);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(tmp, target);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw error;
    }
    throw new Error(`Cannot create file at ${target}: ${messageOf(error)}`);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}
