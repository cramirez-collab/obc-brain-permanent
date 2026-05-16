/**
 * Server-side GLB optimization pipeline.
 * 
 * PHILOSOPHY: Preserve ALL geometry details from the original model.
 * Never simplify or reduce vertex count — the user needs Revit-level fidelity.
 * 
 * Pipeline: dedup → weld → prune → meshopt (lossless compression)
 * 
 * NO simplify — preserves exact geometry (pipes, elbows, curves, details)
 * NO quantize — preserves full float precision for vertex positions
 * NO draco — quantizes positions causing gaps at joints and detail loss
 * meshopt — lossless byte-level compression, zero geometry distortion
 */
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, weld, prune, meshopt } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";

let _io: NodeIO | null = null;

async function getIO(): Promise<NodeIO> {
  if (_io) return _io;
  const encoderModule = await draco3d.createEncoderModule({});
  const decoderModule = await draco3d.createDecoderModule({});
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  _io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression, EXTMeshoptCompression])
    .registerDependencies({
      "draco3d.encoder": encoderModule,
      "draco3d.decoder": decoderModule,
      "meshopt.encoder": MeshoptEncoder,
      "meshopt.decoder": MeshoptDecoder,
    });
  return _io;
}

export type OptimizationLevel = "lossless" | "mep";

export interface OptimizeResult {
  buffer: Uint8Array;
  originalSize: number;
  optimizedSize: number;
  ratio: number;
  level: OptimizationLevel;
  stats: {
    verticesBefore: number;
    verticesAfter: number;
    meshesBefore: number;
    meshesAfter: number;
  };
}

function countVertices(doc: Document): number {
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (pos) total += pos.getCount();
    }
  }
  return total;
}

/**
 * Lossless optimization pipeline for ALL file types.
 * Preserves every vertex, every triangle, every detail.
 * Only removes duplicates and applies lossless byte-level compression.
 */
export async function optimizeGLB(
  inputBuffer: Uint8Array | Buffer,
  forceLevel?: OptimizationLevel
): Promise<OptimizeResult> {
  const originalSize = inputBuffer.length;
  const level = forceLevel ?? "lossless";

  console.log(`[Optimize] Starting ${level} lossless optimization for ${(originalSize / 1024 / 1024).toFixed(1)}MB file`);

  try {
    const io = await getIO();

    const doc: Document = await io.readBinary(new Uint8Array(inputBuffer));

    const meshesBefore = doc.getRoot().listMeshes().length;
    const verticesBefore = countVertices(doc);

    if (meshesBefore === 0) {
      return {
        buffer: new Uint8Array(inputBuffer),
        originalSize,
        optimizedSize: originalSize,
        ratio: 1,
        level,
        stats: { verticesBefore: 0, verticesAfter: 0, meshesBefore: 0, meshesAfter: 0 },
      };
    }

    // Lossless pipeline for ALL specialties:
    // dedup: remove duplicate accessors/materials/textures (lossless)
    // weld: merge coincident vertices (lossless, improves compression)
    // prune: remove unused nodes/materials (lossless)
    // meshopt: byte-level lossless compression (zero geometry distortion)
    await doc.transform(
      dedup(),
      weld(),
      prune(),
      meshopt({ encoder: MeshoptEncoder })
    );

    const meshesAfter = doc.getRoot().listMeshes().length;
    const verticesAfter = countVertices(doc);

    const optimizedUint8 = await io.writeBinary(doc);
    const optimizedSize = optimizedUint8.length;
    const ratio = optimizedSize / originalSize;

    console.log(
      `[Optimize] ${level}: ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(optimizedSize / 1024 / 1024).toFixed(1)}MB ` +
      `(${((1 - ratio) * 100).toFixed(0)}% reduction) | ` +
      `Vertices: ${verticesBefore.toLocaleString()} → ${verticesAfter.toLocaleString()} | ` +
      `Meshes: ${meshesBefore} → ${meshesAfter}`
    );

    // Only use optimized if smaller
    if (optimizedSize < originalSize) {
      return {
        buffer: optimizedUint8,
        originalSize,
        optimizedSize,
        ratio,
        level,
        stats: { verticesBefore, verticesAfter, meshesBefore, meshesAfter },
      };
    }

    return {
      buffer: new Uint8Array(inputBuffer),
      originalSize,
      optimizedSize: originalSize,
      ratio: 1,
      level,
      stats: { verticesBefore, verticesAfter: verticesBefore, meshesBefore, meshesAfter: meshesBefore },
    };
  } catch (err) {
    console.error("[Optimize] Pipeline failed, returning original:", err);
    return {
      buffer: new Uint8Array(inputBuffer),
      originalSize,
      optimizedSize: originalSize,
      ratio: 1,
      level,
      stats: { verticesBefore: 0, verticesAfter: 0, meshesBefore: 0, meshesAfter: 0 },
    };
  }
}

/**
 * Generate a simplified LOD version for quick preview.
 * This is ONLY for the preview thumbnail, not the actual model.
 * Uses moderate simplification since it's just a preview.
 */
export async function generateLOD(
  inputBuffer: Uint8Array | Buffer
): Promise<{ buffer: Uint8Array; vertexReduction: number }> {
  try {
    const io = await getIO();
    const { MeshoptSimplifier } = await import("meshoptimizer");
    await MeshoptSimplifier.ready;
    const { simplify, quantize, draco } = await import("@gltf-transform/functions");

    const doc: Document = await io.readBinary(new Uint8Array(inputBuffer));
    const verticesBefore = countVertices(doc);

    await doc.transform(
      dedup(),
      weld(),
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: 0.15,  // 15% of original for preview only
        error: 0.02,
      }),
      prune(),
      quantize({ quantizePosition: 10, quantizeNormal: 8 }),
      draco({
        method: "edgebreaker",
        encodeSpeed: 7,
        decodeSpeed: 7,
        quantizePosition: 10,
        quantizeNormal: 8,
      })
    );

    const verticesAfter = countVertices(doc);
    const lodBuffer = await io.writeBinary(doc);

    console.log(
      `[LOD] Generated preview: ${verticesBefore.toLocaleString()} → ${verticesAfter.toLocaleString()} vertices ` +
      `(${(lodBuffer.length / 1024 / 1024).toFixed(1)}MB)`
    );

    return {
      buffer: lodBuffer,
      vertexReduction: verticesAfter / verticesBefore,
    };
  } catch (err) {
    console.error("[LOD] Generation failed:", err);
    throw err;
  }
}
