/**
 * Off-main-thread GLB parser for the large MEP models (800-900MB).
 *
 * The expensive work — GLTF parse, Draco/Meshopt decode, world-matrix bake,
 * and geometry merging — runs entirely inside this worker. Only compact,
 * transferable typed arrays are posted back, so the UI thread never freezes
 * ("no responde") while a heavy model loads. The page falls back to the
 * proven main-thread path if the worker errors for any reason.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const ctx: any = self;

type GeoPayload = {
  position: Float32Array;
  normal: Float32Array | null;
  index: Uint32Array | Uint16Array | null;
};

type IMPayload = GeoPayload & {
  instanceMatrix: Float32Array;
  instanceColor: Float32Array | null;
  count: number;
  matrixWorld: number[];
};

const MAX_VERTS_PER_MERGE = 5_000_000;

/** Reduce a geometry to position [+ normal] [+ index] in world space. */
function bake(src: THREE.BufferGeometry, world: THREE.Matrix4, keepNormal: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = src.getAttribute("position");
  g.setAttribute("position", pos.clone());
  if (keepNormal && src.getAttribute("normal")) {
    g.setAttribute("normal", src.getAttribute("normal").clone());
  }
  if (src.index) g.setIndex(src.index.clone());
  g.applyMatrix4(world);
  return g;
}

function geoToPayload(g: THREE.BufferGeometry): GeoPayload {
  const position = (g.getAttribute("position").array as Float32Array);
  const nAttr = g.getAttribute("normal");
  const normal = nAttr ? (nAttr.array as Float32Array) : null;
  let index: Uint32Array | Uint16Array | null = null;
  if (g.index) index = g.index.array as Uint32Array | Uint16Array;
  return { position, normal, index };
}

ctx.onmessage = async (e: MessageEvent) => {
  const { buffer, dracoPath, cores } = e.data as { buffer: ArrayBuffer; dracoPath: string; cores: number };
  try {
    const draco = new DRACOLoader();
    draco.setDecoderPath(dracoPath);
    draco.setDecoderConfig({ type: "wasm" });
    draco.setWorkerLimit(Math.min(Math.max((cores || 4) - 1, 2), 8));

    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
    loader.setMeshoptDecoder(MeshoptDecoder as any);

    const gltf: any = await new Promise((resolve, reject) => {
      loader.parse(buffer, "", resolve, reject);
    });
    gltf.scene.updateMatrixWorld(true);

    const meshes: THREE.Mesh[] = [];
    const instanced: THREE.InstancedMesh[] = [];
    gltf.scene.traverse((c: any) => {
      if (c.isInstancedMesh) instanced.push(c as THREE.InstancedMesh);
      else if (c.isMesh) meshes.push(c as THREE.Mesh);
    });

    // Keep normals only if every mesh has them (otherwise the merge would
    // fail on attribute mismatch); recompute once on the merged buffer.
    const allHaveNormals = meshes.length > 0 && meshes.every((m) => !!m.geometry.getAttribute("normal"));

    const prepared: THREE.BufferGeometry[] = [];
    for (const m of meshes) {
      if (!m.geometry.getAttribute("position")) continue;
      prepared.push(bake(m.geometry, m.matrixWorld, allHaveNormals));
    }

    // Spatial bucketing: group geometry by XZ region instead of arbitrary
    // order. Each merged mesh then occupies a compact volume, so Three.js
    // frustum-culls whole off-screen regions — a big GPU win when walking
    // inside the model or in AR (most of the building is behind you).
    const sceneBox = new THREE.Box3();
    const centroids: THREE.Vector3[] = [];
    let totalVerts = 0;
    for (const g of prepared) {
      g.computeBoundingBox();
      const bb = g.boundingBox as THREE.Box3;
      centroids.push(bb.getCenter(new THREE.Vector3()));
      sceneBox.union(bb);
      totalVerts += g.getAttribute("position").count;
    }
    const size = sceneBox.getSize(new THREE.Vector3());
    const targetCells = Math.min(64, Math.max(1, Math.round(totalVerts / 1_500_000)));
    const div = Math.max(1, Math.min(12, Math.round(Math.sqrt(targetCells))));
    const cellX = size.x > 0 ? size.x / div : 1;
    const cellZ = size.z > 0 ? size.z / div : 1;

    const cells = new Map<string, THREE.BufferGeometry[]>();
    for (let i = 0; i < prepared.length; i++) {
      const c = centroids[i];
      const ix = Math.floor((c.x - sceneBox.min.x) / cellX);
      const iz = Math.floor((c.z - sceneBox.min.z) / cellZ);
      const key = `${ix}:${iz}`;
      let arr = cells.get(key);
      if (!arr) { arr = []; cells.set(key, arr); }
      arr.push(prepared[i]);
    }

    const mergedPayloads: GeoPayload[] = [];
    const emit = (batch: THREE.BufferGeometry[]) => {
      if (batch.length === 0) return;
      try {
        const merged = mergeGeometries(batch, false);
        if (merged) {
          if (!merged.getAttribute("normal")) merged.computeVertexNormals();
          mergedPayloads.push(geoToPayload(merged));
        }
      } catch {
        for (const g of batch) mergedPayloads.push(geoToPayload(g));
      }
    };
    const buckets = Array.from(cells.values());
    for (const arr of buckets) {
      // Keep each merged buffer under the GPU vertex cap.
      let batch: THREE.BufferGeometry[] = [];
      let verts = 0;
      for (const g of arr) {
        const c = g.getAttribute("position").count;
        if (verts + c > MAX_VERTS_PER_MERGE && batch.length > 0) {
          emit(batch);
          batch = [];
          verts = 0;
        }
        batch.push(g);
        verts += c;
      }
      emit(batch);
    }

    const imPayloads: IMPayload[] = [];
    for (const im of instanced) {
      const g = bake(im.geometry, new THREE.Matrix4(), !!im.geometry.getAttribute("normal"));
      const base = geoToPayload(g);
      imPayloads.push({
        ...base,
        instanceMatrix: im.instanceMatrix.array as Float32Array,
        instanceColor: im.instanceColor ? (im.instanceColor.array as Float32Array) : null,
        count: im.count,
        matrixWorld: im.matrixWorld.toArray(),
      });
    }

    const transfer: ArrayBuffer[] = [];
    const collect = (p: GeoPayload) => {
      transfer.push(p.position.buffer as ArrayBuffer);
      if (p.normal) transfer.push(p.normal.buffer as ArrayBuffer);
      if (p.index) transfer.push(p.index.buffer as ArrayBuffer);
    };
    mergedPayloads.forEach(collect);
    imPayloads.forEach((p) => {
      collect(p);
      transfer.push(p.instanceMatrix.buffer as ArrayBuffer);
      if (p.instanceColor) transfer.push(p.instanceColor.buffer as ArrayBuffer);
    });

    ctx.postMessage(
      { ok: true, merged: mergedPayloads, instanced: imPayloads, meshCount: meshes.length },
      transfer,
    );
  } catch (err) {
    ctx.postMessage({ ok: false, error: String((err as Error)?.message || err) });
  }
};
