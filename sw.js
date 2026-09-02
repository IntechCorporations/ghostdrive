/* Ghostdrive service worker — exists purely to give already-in-flight
   uploads a chance to finish via the Background Sync API (Chrome/Edge)
   even if the tab that started them gets closed. It never sees a
   plaintext file, a filename, or any encryption key: the page fully
   encrypts every file (content, thumbnail, and metadata) and stores it
   in IndexedDB *before* this worker ever touches it, so all this does is
   push already-encrypted bytes to Supabase's REST endpoints.

   Background Sync isn't supported everywhere (Safari and Firefox don't
   have it, and a browser that's been fully quit won't run this either)
   — for those, app.js itself drains the same IndexedDB queue the next
   time Ghostdrive is opened, which is the part that always works. */

var UPLOAD_DB_NAME = "ghostdrive-upload-queue";
var UPLOAD_STORE = "queue";
var SUPABASE_URL = "https://tjhdhuduyksticwsvnac.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRqaGRodWR1eWtzdGljd3N2bmFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3ODg0ODIsImV4cCI6MjEwMzM2NDQ4Mn0.au9PvzGckId8r9UIz5VYeErdz0Z-NBTbLGQdDUmVBx4";
var BUCKET = "ghostdrive";

self.addEventListener("install", function (event) { self.skipWaiting(); });
self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });

// GitHub Pages sends a Cache-Control on index.html that lets the browser
// reuse a several-minutes-old copy on a normal navigation (closing and
// reopening a tab, typing the URL again) without even checking the server --
// only an actual hard refresh bypasses that. That's meant nobody testing
// right after a deploy went out was reliably seeing it: a just-shipped fix
// could silently still not be running. Forcing every navigation to the app
// itself to skip the HTTP cache closes that gap for good, with no more
// reliance on remembering to hard-refresh. Everything else this page loads
// (fonts, the Supabase/exifr CDN scripts) is left completely alone.
self.addEventListener("fetch", function (event) {
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request, { cache: "no-store" }).catch(function () { return fetch(event.request); }));
  }
});

function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(UPLOAD_DB_NAME, 1);
    req.onupgradeneeded = function () { req.result.createObjectStore(UPLOAD_STORE, { keyPath: "id" }); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}
function getAllEntries() {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(UPLOAD_STORE, "readonly");
      var req = tx.objectStore(UPLOAD_STORE).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  });
}
function removeEntry(id) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(UPLOAD_STORE, "readwrite");
      tx.objectStore(UPLOAD_STORE).delete(id);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function putEntry(entry) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(UPLOAD_STORE, "readwrite");
      tx.objectStore(UPLOAD_STORE).put(entry);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function putBlob(path, blob, token) {
  return fetch(SUPABASE_URL + "/storage/v1/object/" + BUCKET + "/" + path, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/octet-stream",
      "x-upsert": "false",
    },
    body: blob,
  }).then(function (r) { if (!r.ok) throw new Error("storage upload failed (" + r.status + ")"); });
}
function insertRow(payload, token) {
  return fetch(SUPABASE_URL + "/rest/v1/objects", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(payload),
  }).then(function (r) { if (!r.ok) throw new Error("record insert failed (" + r.status + ")"); });
}
function uploadEntry(entry) {
  return putBlob(entry.contentPath, entry.contentBlob, entry.accessToken)
    .then(function () {
      return (entry.thumbPath && entry.thumbBlob) ? putBlob(entry.thumbPath, entry.thumbBlob, entry.accessToken) : null;
    })
    .then(function () { return insertRow(entry.dbPayload, entry.accessToken); })
    .then(function () { return removeEntry(entry.id); })
    .catch(function (err) {
      // Leave it queued — either app.js resumes it on next open, or a
      // later sync event retries it (the access token snapshot is only
      // good for a while, so a very stale retry may need the page open).
      entry.lastError = String((err && err.message) || err);
      entry.attempts = (entry.attempts || 0) + 1;
      return putEntry(entry);
    });
}
function drainQueue() {
  return getAllEntries().then(function (entries) {
    // A freshly-picked file is queued in "raw" form (the original File,
    // not yet encrypted) the instant it's picked, before app.js has had a
    // chance to encrypt it -- see app.js's "Durable upload queue" comment.
    // This worker never has the master key, so it can't do that step;
    // a raw entry just sits there until the tab is open again to finish
    // preparing it, same as any other browser without Background Sync.
    var ready = entries.filter(function (entry) { return entry.stage === "prepared" || (!entry.stage && entry.dbPayload); });
    return ready.reduce(function (chain, entry) {
      return chain.then(function () { return uploadEntry(entry); });
    }, Promise.resolve());
  });
}

self.addEventListener("sync", function (event) {
  if (event.tag === "ghostdrive-upload-sync") event.waitUntil(drainQueue());
});
