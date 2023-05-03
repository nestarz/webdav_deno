import "https://deno.land/std@0.184.0/dotenv/load.ts";
import { basicAuth } from "https://deno.land/x/basic_auth@v1.1.1/mod.ts";
import {
  router,
  type MatchHandler,
} from "https://deno.land/x/rutt@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.184.0/http/server.ts";
import { S3Client } from "https://denopkg.com/nestarz/deno-s3-lite-client@073c515633c6d2ac1aa9b33c14865a7a945e5b77/mod.ts";
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

const log = (req: Request, res: Response) => {
  const headers = Object.fromEntries(res.headers.entries());
  const pathname = req?.url ? new URL(req.url).pathname : null;
  console.log(
    JSON.stringify({
      request: {
        pathname,
        method: req?.method,
        headers: Object.fromEntries(req.headers.entries()),
      },
      response: { status: res.status, headers },
    })
  );
  return res;
};

const s3FileSystem = createS3FileSystem(s3);

await serve(
  router({
    "/:path(.*)": auth(async (req: Request, ctx, matches) => {
      const defaultOtherHandler = () => new Response(null, { status: 405 });
      const handler = methods[req.method] ?? defaultOtherHandler;
      return await log(
        req,
        await handler(req, { IO: s3FileSystem, ...ctx }, matches)
      );
    }),
  }),
  { port: 8004 }
);
