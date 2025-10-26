import type { createClient, createClientPool } from "@redis/client";
import { checkLibIsLoaded, loadLib } from "./lib.js";

export type RedisClientOrPool =
  | ReturnType<typeof createClient>
  | ReturnType<typeof createClientPool>;
// /\ Typing with any because it seems there is no
// "good" solution for this -> https://github.com/redis/node-redis/issues/1865

export let redisClientOrPool: RedisClientOrPool;

export const initialize = async (redisClientOrPoolArg: RedisClientOrPool) => {
  redisClientOrPool = redisClientOrPoolArg;

  if (!redisClientOrPool.isOpen) {
    await redisClientOrPool.connect();
  }

  const libIsAlreadyLoaded = await checkLibIsLoaded();

  if (libIsAlreadyLoaded) {
    return;
  }

  await loadLib();
};
