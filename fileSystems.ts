import type { S3Client } from "https://deno.land/x/s3_lite_client@0.5.0/mod.ts";
import type {
  S3Object,
  ObjectStatus,
} from "https://deno.land/x/s3_lite_client@0.5.0/client.ts";

interface FileSystem {
  remove(key: string): Promise<void>;
  stat(key: string): Promise<Partial<Deno.FileInfo> & { etag?: string }>;
  readFile(key: string): Promise<Uint8Array>;
  readDir(key: string): AsyncIterable<Deno.DirEntry>;
  writeFile(
    key: string,
    value: Request["body"],
    size?: number | null,
    contentType?: string | null
  ): Promise<void>;
  move(key: string, nextKey: string): Promise<void>;
  copy(key: string, nextKey: string): Promise<void>;
  ensureDir(key: string): Promise<void>;
  getPresignedUrl?(
    method: "GET" | "PUT" | "HEAD" | "DELETE",
    key: string
  ): Promise<string>;
  refreshCacheKey?(): void;
}

const createDenoFileSystem = (): FileSystem => ({
  remove: (key: string): Promise<void> => Deno.remove(key),
  stat: (key: string): Promise<Deno.FileInfo> => Deno.stat(key),
  readFile: (key: string): Promise<Uint8Array> => Deno.readFile(key),
  readDir: (key: string): AsyncIterable<Deno.DirEntry> => Deno.readDir(key),
  writeFile: async (key: string, value: Request["body"]): Promise<void> => {
    const destFile = await Deno.open(key, {
      create: true,
      write: true,
      truncate: true,
    });
    await value?.pipeTo(destFile.writable);
  },
  move: (key: string, nextKey: string): Promise<void> =>
    Deno.rename(key, nextKey),
  copy: (key: string, nextKey: string): Promise<void> =>
    Deno.copyFile(key, nextKey),
  ensureDir: (key: string): Promise<void> =>
    Deno.mkdir(key, { recursive: true }),
});

function createListObjects(s3Client: S3Client, getCacheKey: () => string) {
  let cache: Promise<S3Object[]> = Promise.resolve([]);
  let cacheKey: string;

  const listObjects = async function* ({
    prefix,
  }: {
    prefix: string;
  }): AsyncGenerator<S3Object> {
    const currentCacheKey = getCacheKey();
    if (currentCacheKey !== cacheKey || cacheKey === undefined) {
      cache = new Promise((res) =>
        (async () => {
          cacheKey = currentCacheKey;
          const cache = [];
          for await (const iterator of s3Client.listObjects())
            cache.push(iterator);
          return cache;
        })().then(res)
      );
    }

    for (const entry of await cache) {
      if (entry.key.startsWith(prefix)) yield entry;
    }
  };

  return listObjects;
}

function createStatObject(s3Client: S3Client, getCacheKey: () => string) {
  const cache: Record<string, ObjectStatus> = {};
  let cacheKey: string;

  const statObject = async (key: string): Promise<ObjectStatus> => {
    const currentCacheKey = getCacheKey();
    if (currentCacheKey !== cacheKey || !cache[key]) {
      cacheKey = currentCacheKey;

      cache[key] = await s3Client.statObject(key);
    }

    return cache[key];
  };

  return statObject;
}

export interface S3Options {
  partSize?: number;
}

const createS3FileSystem = (
  s3Client: S3Client,
  options?: S3Options
): FileSystem => {
  let cacheKey = "";
  const getRandomKey = () => Math.random().toString(36);
  const getCacheKey = () => cacheKey;
  const listObjects = createListObjects(s3Client, getCacheKey);
  const statObject = (key: string): Promise<S3Object> =>
    listObjects({ prefix: key })
      .next()
      .then((v) => {
        if (v.value?.key !== key) throw Error("Not found " + key);
        return v.value;
      });

  return {
    refreshCacheKey: () => void (cacheKey = getRandomKey()),
    remove: async (key: string): Promise<void> => {
      const isDirectory = key.endsWith("/") || key === "";
      if (!isDirectory) await s3Client.deleteObject(key);
      else
        for await (const iterator of listObjects({
          prefix: key,
        }))
          await s3Client.deleteObject(iterator.key);
      cacheKey = getRandomKey();
    },
    stat: async (
      key: string
    ): Promise<Partial<Deno.FileInfo> & { etag?: string }> => {
      const checkHasChilds = async (key: string) => {
        const nextChild = (await listObjects({ prefix: key }).next()).value;
        return (nextChild?.key !== key && nextChild) || nextChild?.size === 1;
      };
      return key === "" || (key.endsWith("/") && (await checkHasChilds(key)))
        ? { isFile: false, isDirectory: true }
        : await statObject(key).then((obj) => ({
            isFile: true,
            isDirectory: false,
            isSymlink: false,
            size: obj.size,
            mtime: obj.lastModified,
            atime: obj.lastModified,
            birthtime: obj.lastModified,
            etag: obj.etag,
          }));
    },
    readFile: async (key: string): Promise<Uint8Array> => {
      const response = await s3Client.getObject(key);
      return new Uint8Array(await response.arrayBuffer());
    },
    readDir: async function* (key: string): AsyncIterable<Deno.DirEntry> {
      const seen = new Set();
      for await (const object of listObjects({ prefix: key })) {
        const names = object.key.slice(key.length).split("/");
        const name = names[0];
        if (seen.has(name)) continue;
        seen.add(name);

        const isDirectory = names.length > 1;
        const obj = {
          name,
          isFile: !isDirectory,
          isDirectory,
          isSymlink: false,
        };
        yield obj;
      }
    },
    getPresignedUrl: async (method, key) => {
      return await s3Client.getPresignedUrl(method, key);
    },
    writeFile: async (
      key: string,
      value: Request["body"],
      size?: number,
      contentType?: string
    ): Promise<void> => {
      if (!value) return;
      await s3Client.putObject(key, value, {
        size,
        partSize: options?.partSize ?? 64 * 1024 * 1024,
        metadata: contentType ? { "Content-Type": contentType } : {},
      });
      cacheKey = getRandomKey();
    },
    move: async (key: string, nextKey: string): Promise<void> => {
      for await (const iterator of listObjects({
        prefix: key,
      })) {
        const suffix = iterator.key.slice(key.length);
        const objectKey = nextKey + suffix;
        await s3Client.copyObject({ sourceKey: iterator.key }, objectKey);
        await s3Client.deleteObject(iterator.key);
      }
      cacheKey = getRandomKey();
    },
    copy: async (key: string, nextKey: string): Promise<void> => {
      for await (const iterator of listObjects({
        prefix: key,
      })) {
        const suffix = iterator.key.slice(key.length);
        const objectKey = nextKey + suffix;
        await s3Client.copyObject({ sourceKey: iterator.key }, objectKey);
      }
      cacheKey = getRandomKey();
    },
    ensureDir: async (key: string): Promise<void> => {
      if (!key.endsWith("/")) key += "/";
      await s3Client.putObject(key, "/");
      cacheKey = getRandomKey();
    },
  };
};

export { type FileSystem, createDenoFileSystem, createS3FileSystem };
