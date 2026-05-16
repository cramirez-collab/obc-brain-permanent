/**
 * Server-side Draco compression for GLB files.
 * Uses @gltf-transform to read GLB, apply Draco compression, and return compressed buffer.
 * Typical reduction: 60-80% for mesh geometry.
 */
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression } from "@gltf-transform/extensions";
import { draco } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";

let _io: NodeIO | null = null;

async function getIO(): Promise<NodeIO> {
  if (_io) return _io;
  const encoderModule = await draco3d.createEncoderModule({});
  const decoderModule = await draco3d.createDecoderModule({});
  _io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({
      "draco3d.encoder": encoderModule,
      "draco3d.decoder": decoderModule,
    });
  return _io;
}

/**
 * Compress a GLB buffer using Draco.
 * Returns { buffer, originalSize, compressedSize, ratio }.
 * If compression fails or produces a larger file, returns the original buffer.
 */
export async function compressGLBWithDraco(
  inputBuffer: Uint8Array | Buffer
): Promise<{
  buffer: Uint8Array | Buffer;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  compressed: boolean;
}> {
  const originalSize = inputBuffer.length;

  try {
    const io = await getIO();
    const doc: Document = await io.readBinary(new Uint8Array(inputBuffer));

    // Check if there are meshes to compress
    const meshes = doc.getRoot().listMeshes();
    if (meshes.length === 0) {
      return { buffer: inputBuffer, originalSize, compressedSize: originalSize, ratio: 1, compressed: false };
    }

    // Apply Draco compression
    await doc.transform(
      draco({
        method: "edgebreaker",
        encodeSpeed: 5,
        decodeSpeed: 5,
        quantizePosition: 14,
        quantizeNormal: 10,
        quantizeTexcoord: 12,
        quantizeColor: 8,
        quantizeGeneric: 12,
      })
    );

    const compressedUint8 = await io.writeBinary(doc);
    const compressedBuffer = Buffer.from(compressedUint8);
    const compressedSize = compressedBuffer.length;

    // Only use compressed version if it's actually smaller
    if (compressedSize < originalSize) {
      const ratio = compressedSize / originalSize;
      console.log(
        `[Draco] Compressed ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(compressedSize / 1024 / 1024).toFixed(1)}MB (${((1 - ratio) * 100).toFixed(0)}% reduction)`
      );
      return { buffer: compressedBuffer, originalSize, compressedSize, ratio, compressed: true };
    }

    console.log(`[Draco] Compression not beneficial, keeping original (${(originalSize / 1024 / 1024).toFixed(1)}MB)`);
    return { buffer: inputBuffer, originalSize, compressedSize: originalSize, ratio: 1, compressed: false };
  } catch (err) {
    console.error("[Draco] Compression failed, using original:", err);
    return { buffer: inputBuffer, originalSize, compressedSize: originalSize, ratio: 1, compressed: false };
  }
}
