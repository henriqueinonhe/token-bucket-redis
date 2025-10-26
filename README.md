# Red Bucket

**Red Bucket** is an implementation of the [**token bucket**](https://en.wikipedia.org/wiki/Token_bucket) algorithm using **Redis** as the bucket store.

The **token bucket algorithm** is used for rate limiting, like when you want to rate limit an endpoint of your API:

```ts
import { initialize } from "red-bucket";

// At your app's startup
const redisClientPool = (await createClientPool({
  url: process.env.REDIS_URL,
}).connect())!;

// First we initialize the lib with **your** Redis client.
await initialize(redisClientPool); // Also works with a plain client

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
