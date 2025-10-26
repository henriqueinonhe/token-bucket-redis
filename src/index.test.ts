import { createClientPool } from "@redis/client";
import { describe, it, expect } from "vitest";
import {
  createBucket,
  initialize,
  isTokenBucketError,
  TokenBucketError,
} from "./index.js";
import { libName, libVersion } from "./lib.js";
import type { RedisClientOrPool } from "./client.js";
import { retex } from "return-exception";

describe("Initialization", () => {
  it("Loads lib properly", async () => {
    // Setup
    const redisClientPool = await setupRedisClientPool();

    await ensureLibIsNotLoadedYet(redisClientPool);

    // Act
    await initialize(redisClientPool);

    const result = await redisClientPool.functionList({
      LIBRARYNAME: libName,
    });

    const [first] = result;

    // Assert
    expect(result.length).toBe(1);
    expect(first!.library_name).toBe(libName);

    // Teardown
    await deleteLib(redisClientPool);
  });

  it("Doesn't load the lib if it is already loaded", async () => {
    // Setup
    const redisClientPool = await setupRedisClientPool();

    await ensureLibIsNotLoadedYet(redisClientPool);

    await initialize(redisClientPool);

    // Act && Assert
    expect(() => initialize(redisClientPool)).not.toThrow();

    // Teardown
    await deleteLib(redisClientPool);
  });
});

describe("Bucket", () => {
  it("Methods that return data stored locally (`getId`, `getCapacity`, `getRefillRate`) work correctly", async () => {
    // Setup
    await setup();

    // Act
    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillRateInTokensPerMinute: 100,
    });

    // Assert
    expect(bucket.getId()).toBe("DUBA_DUBA");
    expect(bucket.getCapacity()).toBe(200);
    expect(bucket.getRefillRate()).toBe(100);
  });

  it("`getTokeAmount` works when bucket is not stored in Redis", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillRateInTokensPerMinute: 100,
    });

    // Act
    const tokenAmount = await bucket.getTokenAmount();

    // Assert
    expect(tokenAmount).toBe(200);

    // Teardown
    await teardown(redisClientPool);
  });

  it("`getTokenAmount` works when bucket IS stored in Redis", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const id = "DUBA_DUBA";
    const capacity = 200;
    const refillRateInTokensPerMinute = 100;

    const bucket = createBucket({
      id,
      capacity,
      refillRateInTokensPerMinute,
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

    const preExistingTokens = 100;
    const halfAMinuteInMilliseconds = 1000 * 30;
    const lastRefilledAtInMilliseconds = Date.now() - halfAMinuteInMilliseconds;

    await redisClientPool.hSet(key, {
      tokens: preExistingTokens,
      last_refilled_at_in_milliseconds: lastRefilledAtInMilliseconds,
    });

    // Act
    const tokenAmount = await bucket.getTokenAmount();

    // Assert
    expect(tokenAmount).toBeCloseTo(150);

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  it("`consume` creates bucket in Redis when it doesn't exist and works properly when there are enough tokens", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillRateInTokensPerMinute: 100,
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_DUBA_DUBA`;

    // Act
    const { tokenAmount } = await bucket.consume(10);

    // Assert
    const redisBucket = await redisClientPool.hGetAll(key);
    const redisBucketTtl = await redisClientPool.ttl(key);

    const refillRateInTokensPerSecond = 100 / 60;
    const timeToRefillInSeconds = 10 / refillRateInTokensPerSecond;

    const redisBucketTokens = parseFloat(redisBucket.tokens!);
    const redisBucketLastRefilledAt = parseInt(
      redisBucket.last_refilled_at_in_milliseconds!,
    );

    expect(tokenAmount).toBe(190);
    expect(redisBucketTokens).toBe(190);
    expect(redisBucketLastRefilledAt).toBeLessThanOrEqual(Date.now());
    expect(Date.now()).toBeLessThanOrEqual(redisBucketLastRefilledAt + 100);
    expect(redisBucketTtl).toBeLessThanOrEqual(timeToRefillInSeconds);
    expect(timeToRefillInSeconds).toBeLessThanOrEqual(redisBucketTtl + 1);

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  it("`consume` does NOT create a bucket in Redis when there are not enough tokens and a bucket does not already exists", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const bucket = createBucket({
      id: "DUBA_DUBA",
      capacity: 200,
      refillRateInTokensPerMinute: 100,
    });

    // Act
    const [, error] = await retex(
      () => bucket.consume(201),
      [isTokenBucketError],
    );

    // Assert
    const tokenAmount = await bucket.getTokenAmount();

    expect(error).toBeInstanceOf(TokenBucketError);
    expect(error!.reason).toBe("NOT_ENOUGH_TOKENS");
    expect(tokenAmount).toBe(200);

    // Teardown

    await teardown(redisClientPool);
  });

  it("`consume` reuses existing bucket in Redis and works properly when there are enough tokens, refilling first", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const id = "DUBA_DUBA";
    const capacity = 200;
    const refillRateInTokensPerMinute = 100;
    const refillRateInTokensPerSecond = refillRateInTokensPerMinute / 60;
    const refillRateInTokensPerMillisecond = refillRateInTokensPerSecond / 1000;

    const bucket = createBucket({
      id,
      capacity,
      refillRateInTokensPerMinute,
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

    const tokensToRefillInThisAccess = 50;
    const lastRefilledAtInMilliseconds =
      Date.now() -
      tokensToRefillInThisAccess / refillRateInTokensPerMillisecond;

    const preExistingTokenAmount = 100;

    await redisClientPool.hSet(key, {
      tokens: preExistingTokenAmount,
      last_refilled_at_in_milliseconds: lastRefilledAtInMilliseconds,
    });

    // Act
    const tokensToConsume = 130;
    const { tokenAmount } = await bucket.consume(tokensToConsume);

    // Assert
    const redisBucket = await redisClientPool.hGetAll(key);
    const redisBucketTtl = await redisClientPool.ttl(key);

    const remainingTokens =
      preExistingTokenAmount + tokensToRefillInThisAccess - tokensToConsume;
    const tokensToRefillCompletely = capacity - remainingTokens;
    const timeToRefillInSeconds =
      tokensToRefillCompletely / refillRateInTokensPerSecond;

    const redisBucketTokens = parseFloat(redisBucket.tokens!);
    const redisBucketLastRefilledAt = parseInt(
      redisBucket.last_refilled_at_in_milliseconds!,
    );

    expect(tokenAmount).toBeCloseTo(remainingTokens);
    expect(redisBucketTokens).toBeCloseTo(remainingTokens);
    expect(redisBucketLastRefilledAt).toBeLessThanOrEqual(Date.now());
    expect(Date.now()).toBeLessThanOrEqual(redisBucketLastRefilledAt + 100);
    expect(redisBucketTtl).toBeLessThanOrEqual(timeToRefillInSeconds);
    expect(timeToRefillInSeconds).toBeLessThanOrEqual(redisBucketTtl + 1);

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  it("`consume` reuses existing bucket in Redis and works properly when there are NOT enough tokens", async () => {
    // Setup
    const { redisClientPool } = await setup();

    const id = "DUBA_DUBA";
    const capacity = 200;
    const refillRateInTokensPerMinute = 100;
    const refillRateInTokensPerSecond = refillRateInTokensPerMinute / 60;
    const refillRateInTokensPerMillisecond = refillRateInTokensPerSecond / 1000;

    const bucket = createBucket({
      id,
      capacity,
      refillRateInTokensPerMinute,
    });

    const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

    const tokensToRefillInThisAccess = 50;
    const lastRefilledAtInMilliseconds =
      Date.now() -
      tokensToRefillInThisAccess / refillRateInTokensPerMillisecond;

    const preExistingTokenAmount = 100;

    await redisClientPool.hSet(key, {
      tokens: preExistingTokenAmount,
      last_refilled_at_in_milliseconds: lastRefilledAtInMilliseconds,
    });

    // Act
    const tokensToConsume = 160;
    const [, error] = await retex(
      () => bucket.consume(tokensToConsume),
      [isTokenBucketError],
    );

    // Assert
    const redisBucket = await redisClientPool.hGetAll(key);
    const redisBucketTtl = await redisClientPool.ttl(key);
    const tokenAmount = await bucket.getTokenAmount();

    const remainingTokens = preExistingTokenAmount + tokensToRefillInThisAccess;
    const tokensToRefillCompletely = capacity - remainingTokens;
    const timeToRefillInSeconds =
      tokensToRefillCompletely / refillRateInTokensPerSecond;

    const redisBucketTokens = parseFloat(redisBucket.tokens!);
    const redisBucketLastRefilledAt = parseInt(
      redisBucket.last_refilled_at_in_milliseconds!,
    );

    expect(error).toBeInstanceOf(TokenBucketError);
    expect(error!.reason).toBe("NOT_ENOUGH_TOKENS");
    expect(tokenAmount).toBeCloseTo(remainingTokens);
    expect(redisBucketTokens).toBeCloseTo(remainingTokens);
    expect(redisBucketLastRefilledAt).toBeLessThanOrEqual(Date.now());
    expect(Date.now()).toBeLessThanOrEqual(redisBucketLastRefilledAt + 100);
    expect(redisBucketTtl).toBeLessThanOrEqual(timeToRefillInSeconds);
    expect(timeToRefillInSeconds).toBeLessThanOrEqual(redisBucketTtl + 1);

    // Teardown
    await redisClientPool.del(key);

    await teardown(redisClientPool);
  });

  const setup = async () => {
    const redisClientPool = await setupRedisClientPool();

    await ensureLibIsNotLoadedYet(redisClientPool);

    await initialize(redisClientPool);

    return { redisClientPool };
  };

  const teardown = async (redisClientPool: RedisClientOrPool) => {
    await deleteLib(redisClientPool);
  };
});

const setupRedisClientPool = async () => {
  return (await createClientPool({
    url: "redis://localhost:6379",
  }).connect())!;
};

const ensureLibIsNotLoadedYet = async (redisClientPool: RedisClientOrPool) => {
  await deleteLib(redisClientPool);
};

const deleteLib = async (redisClientPool: RedisClientOrPool) => {
  await redisClientPool.functionDelete(libName).catch(() => {
    // Ignore error when lib not found!
  });
};
