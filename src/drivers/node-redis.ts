import {
  type DriverFactory,
  importLib,
  joinKeys,
  type LibImport,
  type DriverDependencies,
} from "./utils/index.ts";
import { normalizeValue } from "./utils/redis.ts";
import type {
  RedisClientOptions,
  RedisClientType,
  RedisClusterOptions,
  RedisClusterType,
  SetOptions,
} from "redis";

export interface NodeRedisOptions extends RedisClientOptions {
  /**
   * Optional prefix to use for all keys. Can be used for namespacing.
   */
  base?: string;

  /**
   * Url to use for connecting to redis. Has the format `redis[s]://[[username][:password]@][host][:port][/db-number]`
   */
  url?: string;

  /**
   * Options to use for cluster mode (see [`createCluster`](https://github.com/redis/node-redis/blob/master/docs/clustering.md)).
   * When provided, the `url` and other client options are ignored.
   */
  cluster?: RedisClusterOptions;

  /**
   * Default TTL for all items in seconds.
   */
  ttl?: number;

  /**
   * How many keys to scan at once.
   *
   * [redis documentation](https://redis.io/docs/latest/commands/scan/#the-count-option)
   */
  scanCount?: number;

  /**
   * Whether to initialize the redis instance immediately.
   * Otherwise, it will be initialized on the first read/write call.
   * @default false
   */
  preConnect?: boolean;

  /**
   * Optionally provide the [`redis`](https://www.npmjs.com/package/redis) library
   * to avoid dynamically importing it.
   */
  lib?: LibImport<typeof import("redis")>;
}

export const DRIVER_DEPENDENCIES: DriverDependencies = {
  lib: { name: "redis", version: "^5 || ^6" },
};

const DRIVER_NAME = "node-redis";

type NodeRedisClient = RedisClientType | RedisClusterType;

const driver: DriverFactory<NodeRedisOptions, Promise<NodeRedisClient>> = (opts) => {
  let redisClient: Promise<NodeRedisClient> | undefined;
  const getRedisClient = () =>
    (redisClient ??= (async () => {
      const lib = await importLib(DRIVER_NAME, "redis", opts.lib);
      const {
        base: _base,
        cluster,
        ttl: _ttl,
        scanCount: _scanCount,
        preConnect: _preConnect,
        lib: _lib,
        ...clientOptions
      } = opts;
      const client = (
        cluster ? lib.createCluster(cluster) : lib.createClient(clientOptions)
      ) as NodeRedisClient;
      // node-redis throws on `error` events without a listener (e.g. while reconnecting)
      client.on("error", (error: unknown) => {
        console.error(`[unstorage] [${DRIVER_NAME}]`, error);
      });
      await client.connect();
      return client;
    })());

  // Client returning `Buffer`s instead of strings for (binary) raw values
  let bufferClient: Promise<NodeRedisClient> | undefined;
  const getBufferClient = () =>
    (bufferClient ??= (async () => {
      const [client, { RESP_TYPES }] = await Promise.all([
        getRedisClient(),
        importLib(DRIVER_NAME, "redis", opts.lib),
      ]);
      return client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }) as NodeRedisClient;
    })());

  const base = (opts.base || "").replace(/:$/, "");
  const p = (...keys: string[]) => joinKeys(base, ...keys); // Prefix a key. Uses base for backwards compatibility
  const d = (key: string) => (base ? key.replace(`${base}:`, "") : key); // Deprefix a key

  const setOptions = (ttl: number | undefined): SetOptions | undefined =>
    ttl ? { expiration: { type: "EX", value: ttl } } : undefined;

  if (opts.preConnect) {
    getRedisClient().catch((error) => {
      console.error(error);
    });
  }

  const scan = async (pattern: string): Promise<string[]> => {
    const client = await getRedisClient();
    // In cluster mode, keys are spread across the master nodes, so each of them has to be scanned.
    const nodeClients: RedisClientType[] = opts.cluster
      ? await Promise.all(
          (client as RedisClusterType).masters.map(
            (master) => (client as RedisClusterType).nodeClient(master) as Promise<RedisClientType>,
          ),
        )
      : [client as RedisClientType];
    const keys: string[] = [];
    for (const nodeClient of nodeClients) {
      for await (const scanKeys of nodeClient.scanIterator({
        MATCH: pattern,
        COUNT: opts.scanCount,
      })) {
        keys.push(...scanKeys);
      }
    }
    return keys;
  };

  return {
    name: DRIVER_NAME,
    options: opts,
    getInstance: getRedisClient,
    async hasItem(key) {
      return Boolean(await (await getRedisClient()).exists(p(key)));
    },
    async getItem(key) {
      const value = await (await getRedisClient()).get(p(key));
      return value ?? null;
    },
    async getItemRaw(key: string) {
      const value = await (await getBufferClient()).get(p(key));
      return value ?? null;
    },
    async getItems(items) {
      if (items.length === 0) {
        return [];
      }
      const client = await getRedisClient();
      const keys = items.map((item) => p(item.key));

      // In cluster mode `MGET` requires all keys to hash to the same slot,
      // so send individual `GET` commands instead (they get auto-pipelined).
      const data = opts.cluster
        ? await Promise.all(keys.map((key) => client.get(key)))
        : await client.mGet(keys);

      return keys.map((key, index) => {
        return {
          key: d(key),
          value: data[index] ?? null,
        };
      });
    },
    async setItem(key, value, tOptions) {
      const ttl = tOptions?.ttl ?? opts.ttl;
      await (await getRedisClient()).set(p(key), value, setOptions(ttl));
    },
    async setItems(items, commonOptions) {
      if (items.length === 0) {
        return;
      }
      const client = await getRedisClient();
      const defaultTtl = commonOptions?.ttl ?? opts.ttl;
      const hasTtl = defaultTtl || items.some((item) => item.options?.ttl);

      // `MSET` cannot set a per-key TTL and requires all keys to hash to the same slot
      // in cluster mode. In those cases send individual `SET` commands (mirroring `setItem`),
      // which node-redis automatically pipelines; otherwise use a single `MSET`.
      if (hasTtl || opts.cluster) {
        await Promise.all(
          items.map((item) =>
            client.set(p(item.key), item.value, setOptions(item.options?.ttl ?? defaultTtl)),
          ),
        );
      } else {
        await client.mSet(items.map((item) => [p(item.key), item.value] as [string, string]));
      }
    },
    async setItemRaw(key, value, tOptions) {
      const ttl = tOptions?.ttl ?? opts.ttl;
      await (await getRedisClient()).set(p(key), normalizeValue(value), setOptions(ttl));
    },
    async removeItem(key) {
      await (await getRedisClient()).unlink(p(key));
    },
    async getKeys(base) {
      const keys = await scan(p(base, "*"));
      return keys.map((key) => d(key));
    },
    async clear(base) {
      const keys = await scan(p(base, "*"));
      if (keys.length === 0) {
        return;
      }
      const client = await getRedisClient();
      // In cluster mode multi-key commands require all keys to hash to the same slot.
      await (opts.cluster
        ? Promise.all(keys.map((key) => client.unlink(key)))
        : client.unlink(keys));
    },
    async dispose() {
      if (!redisClient) {
        return;
      }
      const client = await redisClient;
      redisClient = bufferClient = undefined;
      if (client.isOpen) {
        await client.close();
      }
    },
  };
};

export default driver;
