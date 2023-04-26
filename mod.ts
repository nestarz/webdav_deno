import {
  parse as parseXml,
  stringify as stringifyXml,
} from "https://deno.land/x/xml@2.1.1/mod.ts";

import {
  transformKeys,
  buildPropFindResponse,
  getPropertyNames,
} from "./buildPropFindResponse.ts";
import {
  type FileSystem,
  createS3FileSystem,
  createDenoFileSystem,
} from "./fileSystems.ts";

export interface Handler {
  (req: Request, ctx: { IO: FileSystem }, matches: Record<string, string>):
    | Response
    | Promise<Response>;
}

export const handleGET: Handler = async (_req: Request, { IO }, { path }) => {
  if (await IO.stat(path).catch(() => false)) {
    if (IO.getPresignedUrl)
      return Response.redirect(await IO.getPresignedUrl("GET", path), 307);
    const content = await IO.readFile(path);
    return new Response(content, { status: 200 });
  } else {
    return new Response("Not Found", { status: 404 });
  }
};

export const handleOPTIONS: Handler = (_req: Request) => {
  const headers = new Headers({
    DAV: "1, 2",
    "Ms-Author-Via": "DAV",
    Allow: "OPTIONS, DELETE, PROPFIND",
    "Content-Length": "0",
    Date: new Date().toUTCString(),
  });
  return new Response(null, { status: 200, headers });
};

export const handlePUT: Handler = async (req: Request, { IO }, { path }) => {
  if (IO.getPresignedUrl) {
    const presignedUrl = await IO.getPresignedUrl("PUT", path);
    return Response.redirect(presignedUrl, 307);
  }
  const body =
    req.headers.get("content-length") === "0" ? new Uint8Array([0]) : req.body;
  await IO.writeFile(path, body);
  return new Response("Created", { status: 201 });
};

const calcKey = (url: string) =>
  decodeURIComponent(new URL(url).pathname.slice(1));

export const handleCOPY: Handler = async (req: Request, { IO }, { path }) => {
  const dest = req.headers.get("Destination");
  if (dest) {
    await IO.copy(path, calcKey(dest));
    return new Response("Created", { status: 201 });
  } else return new Response("Bad Request", { status: 400 });
};

export const handleMOVE: Handler = async (req: Request, { IO }, { path }) => {
  const dest = req.headers.get("Destination");
  if (dest) {
    await IO.move(path, calcKey(dest));
    return new Response("Created", { status: 201 });
  } else return new Response("Bad Request", { status: 400 });
};

export const handleDELETE: Handler = async (
  _req: Request,
  { IO },
  { path }
) => {
  await IO.remove(path).catch(console.warn);
  return new Response(null, { status: 204 });
};

export const handleMKCOL: Handler = async (_req: Request, { IO }, { path }) => {
  await IO.ensureDir(path);
  return new Response("Created", { status: 201 });
};

export const handleLOCK: Handler = async (req: Request, _ctx, { path }) => {
  const depthStr = req.headers.get("depth");
  const depth = depthStr ? +(depthStr ?? "") : null;
  const xml = await req.text();
  const parsedXml = parseXml(xml);

  const lockToken = Math.random().toString(36).substring(2, 15);
  const responseXml: any = {
    xml: {
      "@version": "1.0",
      "@encoding": "UTF-8",
    },
    prop: {
      "@xmlns:D": "DAV:",
      lockdiscovery: {
        activelock: {
          locktype: { write: null },
          lockscope: { exclusive: null },
          depth,
          owner: { href: parsedXml["D:lockinfo"]?.["D:owner"]?.["D:href"] },
          timeout: "Second-600",
          locktoken: { href: lockToken },
          lockroot: { href: path },
        },
      },
    },
  };

  const responseString = stringifyXml(transformKeys(responseXml));
  return new Response(responseString, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Lock-Token": `<${lockToken}>`,
      "Content-Length": responseString.length.toString(),
      Date: new Date().toUTCString(),
    },
  });
};

export const handleUNLOCK: Handler = (req: Request) => {
  const lockToken = req.headers.get("Lock-Token");
  return new Response(null, {
    status: 204,
    headers: { Date: new Date().toUTCString() },
  });
};

export const handlePROPFIND: Handler = async (
  req: Request,
  { IO },
  { path }
) => {
  const depthStr = req.headers.get("depth");
  const depth = depthStr ? +(depthStr ?? "") : null;
  const xml = await req.text();
  const parsedXml = parseXml(xml);

  // Example: Retrieve the displayname property
  const properties = getPropertyNames(parsedXml);
  const responseXml = await buildPropFindResponse(IO, properties, path, depth);

  return responseXml["D:multistatus"]["D:response"].length === 0
    ? new Response("Not Found", {
        status: 404,
        headers: new Headers({ "Content-Type": "text/plain; charset=utf-8" }),
      })
    : new Response(stringifyXml(responseXml), {
        status: 207,
        headers: new Headers({
          "Content-Type": "text/xml; charset=utf-8",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*",
        }),
      });
};

export const methods = {
  GET: handleGET,
  OPTIONS: handleOPTIONS,
  PROPFIND: handlePROPFIND,
  DELETE: handleDELETE,
  MOVE: handleMOVE,
  LOCK: handleLOCK,
  UNLOCK: handleUNLOCK,
  MKCOL: handleMKCOL,
  COPY: handleCOPY,
  PUT: handlePUT,
};

export { createS3FileSystem, createDenoFileSystem };
