import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredAuth {
  orchestratorUrl: string;
  token: string;
  tokenId?: string;
  name?: string;
  scopes?: string[];
  createdAt: string;
}

export function defaultAuthPath(): string {
  return process.env.TANREN_AUTH_FILE ?? join(homedir(), ".config", "tanren", "auth.json");
}

export async function readAuth(path = defaultAuthPath()): Promise<StoredAuth | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as StoredAuth;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeAuth(auth: StoredAuth, path = defaultAuthPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function deleteAuth(path = defaultAuthPath()): Promise<void> {
  try {
    await writeFile(path, "");
  } catch {
    /* swallow */
  }
}
