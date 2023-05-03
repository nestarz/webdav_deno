import { lookup } from "https://deno.land/x/mrmime@v1.0.1/mod.ts";
import type { FileSystem } from "./fileSystems.ts";

function encodeObjectName(key: string) {
  const res = encodeURIComponent(key)
    .replace(/%2F/g, "/")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  return res;
}

export function transformKeys(obj: any, prefix = "D:"): any {
  if (Array.isArray(obj)) return obj.map((item) => transformKeys(item));
  if (typeof obj === "object" && obj !== null) {
    return Object.entries(obj).reduce((acc, [key, value]) => {
      const transformedKey =
        key === "xml" || key.startsWith("#") || key.startsWith("@")
          ? key
          : `${prefix}${key}`;
      acc[transformedKey] = transformKeys(value);
      return acc;
    }, {} as Record<string, any>);
  }

  return obj;
}

export function getPropertyNames(xml: any): string[] {
  const propFindElement = xml["D:propfind"] || xml.propfind;
  if (!propFindElement) return [];
  const propElement = propFindElement["D:prop"] || propFindElement.prop;
  if (!propElement) return [];
  const propertyNames: string[] = [];
  for (const key in propElement)
    if (Object.hasOwn(propElement, key))
      propertyNames.push(key.replace("D:", ""));

  return propertyNames;
}

export async function buildPropFindResponse(
  IO: FileSystem,
  properties: string[],
  path: string,
  depth: number | null = null
): Promise<any> {
  const resources = await getResources(IO, path, depth);

  const response: any = {
    xml: {
      "@version": "1.0",
      "@encoding": "UTF-8",
    },
    multistatus: {
      "@xmlns:D": "DAV:",
      response: [],
    },
  };

  for (const resource of resources) {
    const stat = await IO.stat(resource).catch(console.warn);
    if (!stat) continue;

    const isDir = stat?.isDirectory;
    const prop: any = {};
    const notFound: any = {};

    for (const propKey of properties) {
      switch (propKey) {
        case "displayname":
          prop.displayname = isDir ? resource : resource.split("/").pop();
          break;
        case "getcontentlength":
          if (!isDir) prop.getcontentlength = (stat.size ?? 0)?.toString();
          break;
        case "getcontenttype":
          if (!isDir) prop.getcontenttype = lookup(resource);
          break;
        case "resourcetype":
          prop.resourcetype = isDir
            ? { collection: { "@xmlns:D": "DAV:" } }
            : {};
          break;
        case "getlastmodified":
          prop.getlastmodified = stat.mtime?.toUTCString() || "";
          break;
        case "creationdate":
          prop.creationdate = stat.birthtime?.toUTCString() || "";
          break;
        case "getetag":
          prop.getetag = stat.etag;
          break;
      }
      if (typeof prop[propKey] === "undefined") {
        if (propKey.startsWith("s:"))
          notFound[propKey.slice(2)] = { "@xmlns:s": "SAR:" };
        else notFound[propKey] = "";
      }
    }

    response.multistatus.response.push({
      href: encodeObjectName((resource.startsWith("/") ? "" : "/") + resource),
      propstat: [
        { prop, status: "HTTP/1.1 200 OK" },
        { prop: notFound, status: "HTTP/1.1 404 Not Found" },
      ],
    });
  }

  return transformKeys(response);
}

async function getResources(
  IO,
  path: string,
  depth?: number | null
): Promise<string[]> {
  const fullPath = path;
  const stat = await IO.stat(fullPath).catch(() => null);
  const resources = [];

  if (stat?.isFile) {
    resources.push(fullPath);
  } else if (stat?.isDirectory) {
    if (depth === 0) {
      resources.push(fullPath);
    } else {
      resources.push(fullPath);
      for await (const entry of IO.readDir(fullPath)) {
        const entryPath = [fullPath, entry.name]
          .filter((v) => v)
          .join("/")
          .replaceAll("//", "/");
        resources.push(entry.isDirectory ? entryPath + "/" : entryPath);

        if (entry.isDirectory && (depth === 1 || depth === null)) {
          const nestedResources = await getResources(
            IO,
            entryPath,
            depth ? depth - 1 : depth
          );
          resources.push(...nestedResources);
        }
      }
    }
  }

  return [...new Set(resources)];
}
