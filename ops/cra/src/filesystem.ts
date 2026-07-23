import { chmod, lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const linkInfo = await lstat(path);
  if (!linkInfo.isDirectory() || linkInfo.isSymbolicLink()) throw new Error(`unsafe CRA directory: ${path}`);
  const info = await stat(path);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`CRA directory is not owned by the current user: ${path}`);
  }
  if ((info.mode & 0o077) !== 0) throw new Error(`CRA directory is accessible by group or others: ${path}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = resolve(directory, `.${basename(path)}.tmp-${process.pid}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, path);
  await chmod(path, 0o600);
  await syncDirectory(directory);
}

export async function immutableWriteFile(path: string, contents: string): Promise<boolean> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  let handle;
  try {
    handle = await open(path, "wx", 0o400);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
  await syncDirectory(directory);
  return true;
}

export async function removeTemporarySiblings(directory: string): Promise<void> {
  await ensurePrivateDirectory(directory);
  for (const entry of await readdir(directory)) {
    if (/^\..+\.tmp-\d+$/u.test(entry)) await rm(resolve(directory, entry), { force: true });
  }
}
