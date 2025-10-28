# Red Bucket

**Red Bucket** is an implementation of the [**token bucket**](https://en.wikipedia.org/wiki/Token_bucket) algorithm using **Redis** as storage for the buckets.

The **token bucket algorithm** is used for rate limiting, like when you want to rate limit an endpoint of your API:

```ts
import { initialize, createBucket } from "red-bucket";

// At your app's startup
const redisClientPool = (await createClientPool({
  url: process.env.REDIS_URL,
}).connect())!;

// First we initialize the lib with **your** Redis client.
await initialize(redisClientPool);

// At some controller of yours
app.get("/users", async (request, reply) => {
  const bucket = createBucket({
    // Some unique ID
    id: `USERS_ENDPOINT_${request.ip}`,
    capacity: 200,
    refillRateInTokensPerMinute: 60,
  });

  const { success } = await bucket.safeConsume(1);

  if (!success) {
    return reply.status(429).send("Too many requests!");
  }

  const users = await getUsers();

  return reply.status(200).send(users);
});
```

## API

### `initialize()`

Initializes the lib with **your** Redis client or client pool. It **must** be called before calling `createBucket`.

Usage:

```ts
// At your app's startup
const redisClient = (await createClient({
  url: process.env.REDIS_URL,
}).connect())!;

await initialize(redisClient);
```

Besides storing a reference to your Redis client/pool, this function also sets up the necessary lua scripts in Redis.

#### Parameters

- `redisClientOrPool: RedisClientOrPool`: Either a Redis client (created with `createClient`) or a Redis client pool (created with `createClientPool`).

#### Returns

A `Promise<void>`.

### `createBucket()`

Creates a token bucket.

The bucket that is returned by this function is **stateless**, in the sense that all state is stored in Redis, so in practice the bucket object acts more like a client. Because of that, it's okay and even expected for you to (re-)create a bucket every time you need to access the underlying bucket stored in Redis.

Note: For optimization reasons, calling this function **does not** cause the bucket to be stored in Redis, which in practice does not affect the algorithm per se.

#### Parameters

- `id: string` -> An id that **uniquely** identifies your bucket. You may compose this id by concatenating the operation name with the user's identifier (ip for anonymous users and the user's id for authenticated ones).
- `capacity: number` -> The maximum amount of tokens the bucket can hold.
- `refillRateInTokensPerMinute` -> How many tokens the bucket will be refilled with in the span of one minute.

#### Returns

A `Bucket` object.

### `bucket.getId()`

Returns the bucket id.

### `bucket.getCapacity()`

Returns the bucket capacity.

### `bucket.getRefillRate()`

Returns the bucket refill rate.

### `bucket.consume()`

Tries to consume a given amount of tokens from the bucket.

If there are enough tokens, it updates the bucket by consuming the tokens.

If there are **not** enough tokens, it throws a `TokenBucketError` with `NOT_ENOUGH_TOKENS` reason.

Usage:

```ts
// At some controller of yours
app.get("/users", async (request, reply) => {
  const bucket = createBucket({
    id: `USERS_ENDPOINT_${request.ip}`,
    capacity: 200,
    refillRateInTokensPerMinute: 60,
  });

  try {
    await bucket.consume();

    return reply.status(200).send("OK");
  } catch (error) {
    if (isTokenBucketError(error) && error.reason === "NOT_ENOUGH_TOKENS") {
      return reply.status(429).send("Too many requests");
    }

    throw error;
  }
});
```

#### Parameters

- `amount?: number` -> Specifies the amount of tokens to be consumed. Defaults to 1 token.

#### Returns

An object `{ tokenAmount: number }` where `tokenAmount` is the number of **remaining tokens** in the bucket.

### `bucket.safeConsume()`

Same as `bucket.consume()`, but it never throws and returns a result object instead.

Usage:

```ts
// At some controller of yours
app.get("/users", async (request, reply) => {
  const bucket = createBucket({
    id: `USERS_ENDPOINT_${request.ip}`,
    capacity: 200,
    refillRateInTokensPerMinute: 60,
  });

  const { success } = await bucket.safeConsume(1);

  if (!success) {
    return reply.status(429).send("Too many requests!");
  }

  const users = await getUsers();

  return reply.status(200).send(users);
});
```

#### Parameters

- `amount?: number` -> Specifies the amount of tokens to be consumed. Defaults to 1 token.

#### Returns

- `result`
  - `success: boolean` -> Whether the token had enough tokens to be consumed.
  - `tokenAmount: number` -> The number of tokens remaining.
  - `error?: TokenBucketError` -> The corresponding `TokenBucketError` when there are not enough tokens.

The `result` object is a **discriminated** union, which means that when you check for the presence/absence of `error` or the `success` to be true/false, TypeScript is able to **narrow down** the type.

### `bucket.getTokenAmount()`

Returns the amount of tokens in the bucket.

#### Returns

A `Promise<number>`.
