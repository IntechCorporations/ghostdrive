/**
 * Ghostdrive R2 Worker
 * --------------------
 * Sits between the static Ghostdrive frontend (GitHub Pages) and a
 * Cloudflare R2 bucket. Uses the native R2 binding, so no AWS SigV4
 * signing is needed and the R2 secret key never has to leave Cloudflare.
 *
 * Routes (all require header  X-Auth: <SHARED_SECRET>):
 *   GET    /object?path=...                    -> stream object bytes
 *   PUT    /object?path=...                     -> single-shot upload (body = raw bytes)
 *   DELETE /object?path=...                     -> delete object
 *   POST   /mpu/create   { path }                -> { uploadId }
 *   PUT    /mpu/part?path=...&uploadId=...&partNumber=N   (body = chunk bytes) -> { etag }
 *   POST   /mpu/complete { path, uploadId, parts: [{partNumber, etag}] }
 *   POST   /mpu/abort    { path, uploadId }
 *   POST   /gphotos-proxy { url, token }         -> streams the Google Photos
 *                                                    baseUrl straight through
 *                                                    (used to work around
 *                                                    Google's CORS block on
 *                                                    direct browser fetches;
 *                                                    streamed instead of
 *                                                    buffered, so large
 *                                                    videos don't blow a
 *                                                    memory or time limit
 *                                                    the way the previous
 *                                                    Supabase Edge Function
 *                                                    version did)
 *
 * Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> paste this
 * file in the Quick Edit box -> Settings -> Bindings:
 *   - R2 bucket binding, variable name BUCKET, bucket = ghostdrive-storage
 *   - Secret, variable name SHARED_SECRET, value = (a long random string you pick)
 * Then set ALLOWED_ORIGIN below (or as another env var) to your Pages URL.
 */

const ALLOWED_ORIGIN = "https://intechcorporations.github.io";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Auth",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders()),
  });
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const auth = request.headers.get("X-Auth");
    if (!env.SHARED_SECRET || auth !== env.SHARED_SECRET) return unauthorized();

    const path = url.searchParams.get("path");

    try {
      // ---- single-shot object ops ----
      if (url.pathname === "/object") {
        if (!path) return json({ error: "missing path" }, 400);

        if (request.method === "GET") {
          const obj = await env.BUCKET.get(path);
          if (!obj) return json({ error: "not found" }, 404);
          return new Response(obj.body, {
            headers: Object.assign(
              { "Content-Type": "application/octet-stream" },
              corsHeaders()
            ),
          });
        }

        if (request.method === "PUT") {
          await env.BUCKET.put(path, request.body);
          return json({ ok: true });
        }

        if (request.method === "DELETE") {
          await env.BUCKET.delete(path);
          return json({ ok: true });
        }
      }

      // ---- multipart upload ops (for large files) ----
      if (url.pathname === "/mpu/create" && request.method === "POST") {
        const body = await request.json();
        if (!body.path) return json({ error: "missing path" }, 400);
        const mpu = await env.BUCKET.createMultipartUpload(body.path);
        return json({ uploadId: mpu.uploadId });
      }

      if (url.pathname === "/mpu/part" && request.method === "PUT") {
        const uploadId = url.searchParams.get("uploadId");
        const partNumber = parseInt(url.searchParams.get("partNumber"), 10);
        if (!path || !uploadId || !partNumber) return json({ error: "missing params" }, 400);
        const mpu = env.BUCKET.resumeMultipartUpload(path, uploadId);
        const uploadedPart = await mpu.uploadPart(partNumber, request.body);
        return json({ etag: uploadedPart.etag });
      }

      if (url.pathname === "/mpu/complete" && request.method === "POST") {
        const body = await request.json();
        if (!body.path || !body.uploadId || !body.parts) return json({ error: "missing params" }, 400);
        const mpu = env.BUCKET.resumeMultipartUpload(body.path, body.uploadId);
        await mpu.complete(body.parts);
        return json({ ok: true });
      }

      if (url.pathname === "/mpu/abort" && request.method === "POST") {
        const body = await request.json();
        if (!body.path || !body.uploadId) return json({ error: "missing params" }, 400);
        const mpu = env.BUCKET.resumeMultipartUpload(body.path, body.uploadId);
        await mpu.abort();
        return json({ ok: true });
      }

      if (url.pathname === "/gphotos-proxy" && request.method === "POST") {
        const body = await request.json();
        if (!body.url || !body.token) return json({ error: "missing url or token" }, 400);
        // A straight passthrough fetch -- Workers stream the response body
        // through to the client as it arrives rather than buffering the
        // whole thing in memory first, which is exactly what a multi-GB
        // video needs and what the previous (buffering) Edge Function
        // implementation couldn't do without hitting its own timeout.
        const upstream = await fetch(body.url, { headers: { Authorization: "Bearer " + body.token } });
        if (!upstream.ok) return json({ error: "Google returned " + upstream.status }, upstream.status);
        return new Response(upstream.body, {
          status: 200,
          headers: Object.assign(
            { "Content-Type": upstream.headers.get("Content-Type") || "application/octet-stream" },
            corsHeaders()
          ),
        });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }
  },
};
