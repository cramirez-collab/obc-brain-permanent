import { storageGet } from "../server/storage.ts";

const fileKeys = [
  "projects/60001/structure-kwmuub53.glb",
  "projects/60001/fire_protection-6l4q7xeo.glb",
  "projects/60001/architecture-gwktlfqp.glb",
  "projects/60001/electrical-1772431817.glb",
  "projects/60001/hydraulic-1772432682296.glb",
];

for (const key of fileKeys) {
  const result = await storageGet(key);
  const resp = await fetch(result.url, { method: "HEAD" });
  const size = resp.headers.get("content-length");
  const sizeMB = size ? (parseInt(size) / 1024 / 1024).toFixed(1) : "?";
  console.log(`${key.split("/").pop()}: ${resp.status} (${sizeMB}MB)`);
}
