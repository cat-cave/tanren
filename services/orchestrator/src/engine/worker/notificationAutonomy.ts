import { PgNotifyListener } from "@tanren/db";
import type pg from "pg";
import type { SecretStore } from "../contracts/secretStore.js";
import { buildNotificationDispatcher } from "../notifications/build.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { startNotificationSubscriber } from "../notifications/subscriber.js";

export async function startWorkerNotifications(input: {
  pool: pg.Pool;
  secrets: SecretStore;
  githubAppMinter?: GithubAppTokenMinter;
}) {
  const listener = new PgNotifyListener(input.pool);
  const { dispatcher } = buildNotificationDispatcher({
    pool: input.pool,
    secrets: input.secrets,
    ...(input.githubAppMinter === undefined ? {} : { githubAppMinter: input.githubAppMinter }),
  });
  const subscriber = await startNotificationSubscriber({ pool: input.pool, notifyListener: listener, dispatcher });
  return { listener, subscriber };
}
