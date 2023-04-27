import "https://deno.land/std@0.184.0/dotenv/load.ts";
import { basicAuth } from "https://deno.land/x/basic_auth@v1.1.1/mod.ts";
import {
  router,
  type MatchHandler,
} from "https://deno.land/x/rutt@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.184.0/http/server.ts";
import { S3Client } from "https://raw.githubusercontent.com/nestarz/deno-s3-lite-client/patch-1/mod.ts";
import { createS3FileSystem, methods } from "./mod.ts";

const auth = (fn: MatchHandler) => {
  const handler: MatchHandler = (req: Request, ...props) => {
    const unauthorized = basicAuth(req, "Realm", {
      [Deno.env.get("BASIC_AUTH_KEY")!]: Deno.env.get("BASIC_AUTH_PASSWORD")!,
    });
    if (unauthorized) return unauthorized;
    else return fn(req, ...props);
  };
  return handler;
};

const s3 = new S3Client({
  accessKey: Deno.env.get("AWS_ACCESS_KEY_ID")!,
  secretKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
  endPoint: Deno.env.get("S3_ENDPOINT_URL")!,
  region: Deno.env.get("AWS_BUCKET_REGION")!,
  bucket: Deno.env.get("DEFAULT_BUCKET")!,
  useSSL: true,
  pathStyle: true,
});

const log = {
  req: (req: Request, matches: any) => {
    const headers = Object.fromEntries(req.headers.entries());
    const pathname = new URL(req.url).pathname;
    console.log(
      JSON.stringify({ method: req.method, pathname, headers, matches })
    );
    return req;
  },
  res: (res: Response) => {
    const headers = Object.fromEntries(res.headers.entries());
    console.log(JSON.stringify({ status: res.status, headers }));
    return res;
  },
};

const s3FileSystem = createS3FileSystem(s3);

await serve(
  router({
    "/:path(.*)": auth(async (req: Request, ctx, matches) => {
      log.req(req, matches);
      const defaultOtherHandler = () => new Response(null, { status: 405 });
      const handler = methods[req.method] ?? defaultOtherHandler;
      return log.res(await handler(req, { IO: s3FileSystem, ...ctx }, matches));
    }),
  }),
  { port: 8004 }
);
