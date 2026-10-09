import { describe, it, expect, vi } from "vitest";
import { createClient, RESP_TYPES, type RedisClientType } from "redis";
import nodeRedisDriver from "../../src/drivers/node-redis.ts";
import { testDriver } from "./utils.ts";

// Requires a running redis server, e.g. `VITE_REDIS_URL=redis://localhost:6379/0`
const url = process.env.VITE_REDIS_URL;

describe.skipIf(!url)("drivers: node-redis", () => {
  const base = `test-${Math.round(Math.random() * 1_000_000).toString(16)}`;

  const withClient = async <T>(fn: (client: RedisClientType) => Promise<T>) => {
    const client = createClient({ url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  };

  testDriver({
    driver: () => nodeRedisDriver({ base, url }),
    additionalTests(ctx) {
      it("saves raw data as binary", async () => {
        const helloBuffer = Buffer.from("Hello, world!", "utf8");
        const byteArray = new Uint8Array([2, 0, 2, 5]);

        await ctx.storage.setItemRaw("s4:a", helloBuffer);
        await ctx.storage.setItemRaw("s5:a", byteArray);

        expect(await ctx.storage.getItemRaw("s4:a")).toEqual(helloBuffer);
        expect(await ctx.storage.getItemRaw("s5:a")).toEqual(Buffer.from([2, 0, 2, 5]));

        await withClient(async (client) => {
          const bufferClient = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
          expect(await bufferClient.get(`${base}:s4:a`)).toEqual(helloBuffer);
          expect(await bufferClient.get(`${base}:s5:a`)).toEqual(Buffer.from([2, 0, 2, 5]));
        });
      });

      it("setItem with ttl sets an expiry", async () => {
        await ctx.storage.setItem("s6:a", "a", { ttl: 1000 });

        await withClient(async (client) => {
          expect(await client.get(`${base}:s6:a`)).toBe("a");
          expect(await client.ttl(`${base}:s6:a`)).toBeGreaterThan(0);
        });
      });

      it("setItems with ttl sets each key with an expiry", async () => {
        await ctx.storage.setItems(
          [
            { key: "s7:a", value: "a" },
            { key: "s7:b", value: "b" },
          ],
          { ttl: 1000 },
        );

        await withClient(async (client) => {
          expect(await client.get(`${base}:s7:a`)).toBe("a");
          expect(await client.get(`${base}:s7:b`)).toBe("b");
          expect(await client.ttl(`${base}:s7:a`)).toBeGreaterThan(0);
        });
      });

      it("getItems returns null for missing keys", async () => {
        await ctx.storage.setItem("s8:a", "a");
        expect(await ctx.storage.getItems(["s8:a", "s8:missing"])).toMatchObject([
          { key: "s8:a", value: "a" },
          { key: "s8:missing", value: null },
        ]);
      });
    },
  });
});

// Requires a running redis cluster, e.g. `VITE_REDIS_CLUSTER_URLS=redis://localhost:7001,redis://localhost:7002`
const clusterUrls = process.env.VITE_REDIS_CLUSTER_URLS?.split(",");

describe.skipIf(!clusterUrls)("drivers: node-redis (cluster)", () => {
  testDriver({
    driver: () =>
      nodeRedisDriver({
        base: `test-${Math.round(Math.random() * 1_000_000).toString(16)}`,
        cluster: { rootNodes: clusterUrls!.map((url) => ({ url })) },
      }),
    additionalTests(ctx) {
      it("handles keys across hash slots", async () => {
        const items = Array.from({ length: 20 }, (_, i) => ({ key: `s9:${i}`, value: `v${i}` }));
        await ctx.storage.setItems(items);
        await ctx.storage.setItems(items, { ttl: 1000 });
        expect(await ctx.storage.getItems(items.map((item) => item.key))).toMatchObject(items);
        expect((await ctx.storage.getKeys("s9")).length).toBe(20);
        await ctx.storage.clear();
        expect(await ctx.storage.getKeys("s9")).toEqual([]);
      });
    },
  });
});

describe("drivers: node-redis (connection failures)", () => {
  // Fake `redis` library whose first client fails to connect
  const createFakeLib = () => {
    const clients: { connect: () => Promise<void>; destroy: () => void; isOpen: boolean }[] = [];
    const lib = {
      RESP_TYPES: { BLOB_STRING: 36 },
      createClient: vi.fn(() => {
        const failing = clients.length === 0;
        const client = {
          isOpen: false,
          on: () => client,
          connect: vi.fn(async () => {
            client.isOpen = true;
            if (failing) {
              throw new Error("ECONNREFUSED");
            }
          }),
          destroy: vi.fn(() => {
            client.isOpen = false;
          }),
          close: vi.fn(async () => {
            client.isOpen = false;
          }),
          get: vi.fn(async () => "value"),
        };
        clients.push(client);
        return client;
      }),
    };
    return { lib, clients };
  };

  it("retries after a failed connection", async () => {
    const { lib, clients } = createFakeLib();
    const driver = nodeRedisDriver({ lib: lib as any });

    await expect(driver.getItem("key", {})).rejects.toThrow("ECONNREFUSED");
    expect(clients[0]!.destroy).toHaveBeenCalled();

    expect(await driver.getItem("key", {})).toBe("value");
    expect(lib.createClient).toHaveBeenCalledTimes(2);

    await driver.dispose!();
    expect(clients[1]!.isOpen).toBe(false);
  });

  it("disposes without throwing after a failed connection", async () => {
    const { lib } = createFakeLib();
    const driver = nodeRedisDriver({ lib: lib as any });

    await expect(driver.getItem("key", {})).rejects.toThrow("ECONNREFUSED");
    await expect(driver.dispose!()).resolves.toBeUndefined();
  });
});
