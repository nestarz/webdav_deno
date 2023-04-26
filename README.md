# webdav_deno

## Usage

```ts
import "https://deno.land/std@0.184.0/dotenv/load.ts";
import { basicAuth } from "https://deno.land/x/basic_auth@v1.1.1/mod.ts";
import {
  router,
  type MatchHandler,
} from "https://deno.land/x/rutt@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.184.0/http/server.ts";
import { S3Client } from "https://deno.land/x/s3_lite_client@0.5.0/mod.ts";
import { createS3FileSystem, methods } from "https://deno.land/x/webdav_deno@0.1.0/mod.ts";

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

const s3FileSystem = createS3FileSystem(
  new S3Client({
    accessKey: Deno.env.get("AWS_ACCESS_KEY_ID")!,
    secretKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
    endPoint: Deno.env.get("S3_ENDPOINT_URL")!,
    region: Deno.env.get("AWS_BUCKET_REGION")!,
    bucket: Deno.env.get("DEFAULT_BUCKET")!,
    useSSL: true,
    pathStyle: true,
  })
);

await serve(
  router({
    "/:path(.*)": auth(async (req: Request, ctx, matches) => {
      const defaultOtherHandler = () => new Response(null, { status: 405 });
      const handler = methods[req.method] ?? defaultOtherHandler;
      return await handler(req, { IO: s3FileSystem, ...ctx }, matches);
    }),
  }),
  { port: 8004 }
);
```
