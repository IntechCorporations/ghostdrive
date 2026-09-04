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
    "Access-Control-Allow-Methods": "GET,HEAD,PUT,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Auth, Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
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
    // Normally the shared secret comes in as a header. A native <video>
    // element can't set headers on its own requests, though -- and letting
    // the browser stream a large file directly (with its own range
    // requests, seeking, and buffering) is far better than downloading the
    // whole thing in JS first. So the same secret is also accepted as a
    // query param for that case. Worth being clear about the tradeoff:
    // the secret then appears in the URL, which is more exposed than a
    // header (browser history, logs). That's an acceptable trade here only
    // because this same secret already ships inside the public frontend
    // JS anyway -- it isn't protecting anything from someone who reads the
    // page source.
    const auth = request.headers.get("X-Auth") || url.searchParams.get("auth");
    if (!env.SHARED_SECRET || auth !== env.SHARED_SECRET) return unauthorized();

    const path = url.searchParams.get("path");

    try {
      // ---- single-shot object ops ----
      if (url.pathname === "/object") {
        if (!path) return json({ error: "missing path" }, 400);

        if (request.method === "HEAD") {
          const head = await env.BUCKET.head(path);
          if (!head) return new Response(null, { status: 404, headers: corsHeaders() });
          return new Response(null, {
            status: 200,
            headers: Object.assign({ "Content-Length": String(head.size), "Accept-Ranges": "bytes" }, corsHeaders()),
          });
        }

        if (request.method === "GET") {
          // A Range header (bytes=start-end) lets the client pull a large
          // object as several parallel chunks instead of one single
          // connection -- genuinely faster on most links, since a lot of
          // ISPs/routers throttle per-connection rather than per-origin.
          const rangeHeader = request.headers.get("Range");
          let r2Options;
          if (rangeHeader) {
            const m = /bytes=(\d+)-(\d+)?/.exec(rangeHeader);
            if (m) {
              const offset = parseInt(m[1], 10);
              const end = m[2] ? parseInt(m[2], 10) : undefined;
              r2Options = { range: end !== undefined ? { offset: offset, length: end - offset + 1 } : { offset: offset } };
            }
          }
          const obj = r2Options ? await env.BUCKET.get(path, r2Options) : await env.BUCKET.get(path);
          if (!obj) return json({ error: "not found" }, 404);
          const headers = Object.assign({ "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes" }, corsHeaders());
          if (r2Options && obj.range) {
            const total = obj.size; // full object size, even though this response is a slice of it
            const start = obj.range.offset;
            const finish = start + (obj.range.length !== undefined ? obj.range.length : total - start) - 1;
            headers["Content-Range"] = "bytes " + start + "-" + finish + "/" + total;
            return new Response(obj.body, { status: 206, headers: headers });
          }
          return new Response(obj.body, { headers: headers });
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
