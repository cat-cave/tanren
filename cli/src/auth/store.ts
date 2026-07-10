import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isPlainObject } from "../json.js";

export interface StoredAuth {
  orchestratorUrl: string;
  token: string;
  tokenId?: string;
  name?: string;
  scopes?: string[];
  createdAt: string;
}

export class InvalidAuthFileError extends Error {
  constructor(
    readonly path: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`invalid auth file at ${path}: ${reason}`, options);
    this.name = "InvalidAuthFileError";
  }
}

export function defaultAuthPath(): string {
  return process.env["TANREN_AUTH_FILE"] ?? join(homedir(), ".config", "tanren", "auth.json");
}

/**
 * Runtime schema for the on-disk auth store. Rejects arrays, null, missing
 * required fields, and wrong types so a corrupted file cannot be treated as a
 * session.
 */
export function parseStoredAuth(value: unknown, path = defaultAuthPath()): StoredAuth {
  if (!isPlainObject(value)) {
    throw new InvalidAuthFileError(path, "expected a JSON object");
  }
  const orchestratorUrl = value["orchestratorUrl"];
  const token = value["token"];
  const createdAt = value["createdAt"];
  if (typeof orchestratorUrl !== "string" || orchestratorUrl.trim() === "") {
    throw new InvalidAuthFileError(path, 'missing non-empty string "orchestratorUrl"');
  }
  if (typeof token !== "string" || token === "") {
    throw new InvalidAuthFileError(path, 'missing non-empty string "token"');
  }
  if (typeof createdAt !== "string" || createdAt.trim() === "") {
    throw new InvalidAuthFileError(path, 'missing non-empty string "createdAt"');
  }

  const auth: StoredAuth = { orchestratorUrl, token, createdAt };

  if (value["tokenId"] !== undefined) {
    if (typeof value["tokenId"] !== "string") {
      throw new InvalidAuthFileError(path, '"tokenId" must be a string when present');
    }
    auth.tokenId = value["tokenId"];
  }
  if (value["name"] !== undefined) {
    if (typeof value["name"] !== "string") {
      throw new InvalidAuthFileError(path, '"name" must be a string when present');
    }
    auth.name = value["name"];
  }
  if (value["scopes"] !== undefined) {
    if (!Array.isArray(value["scopes"]) || !value["scopes"].every((s) => typeof s === "string")) {
      throw new InvalidAuthFileError(path, '"scopes" must be a string array when present');
    }
    auth.scopes = value["scopes"];
  }
  return auth;
}

export async function readAuth(path = defaultAuthPath()): Promise<StoredAuth | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    // Empty / whitespace-only is treated as logged-out (recovery for older
    // logout that wrote an empty file rather than removing it).
    if (raw.trim() === "") {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new InvalidAuthFileError(path, `not valid JSON (${detail})`, { cause: error });
    }
    return parseStoredAuth(parsed, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeAuth(auth: StoredAuth, path = defaultAuthPath()): Promise<void> {
  // Validate before write so we never persist a corrupt shape.
  const validated = parseStoredAuth(auth, path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * Logout: remove the auth file. Absence is the canonical empty/valid state —
 * `readAuth` returns `undefined` and subsequent login can recreate the file.
 * Never leaves an empty or partial file that would fail JSON parse.
 */
export async function deleteAuth(path = defaultAuthPath()): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
