/**
 * Server-side IFC → GLB conversion using web-ifc + @gltf-transform/core.
 * Parses IFC geometry, extracts meshes with materials, outputs binary GLB.
 */
import { IfcAPI } from "web-ifc";
import * as WebIFC from "web-ifc";
import { Document, NodeIO } from "@gltf-transform/core";
import path from "path";

let _ifcApi: IfcAPI | null = null;

async function getIfcApi(): Promise<IfcAPI> {
  if (_ifcApi) return _ifcApi;
  const api = new IfcAPI();
  // Point to the WASM file location
  const wasmDir = path.dirname(require.resolve("web-ifc/web-ifc-node.wasm"));
  api.SetWasmPath(wasmDir + "/");
  await api.Init();
  _ifcApi = api;
  return api;
}

interface Vec4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface IfcMeshData {
  expressId: number;
  geometries: Array<{
    vertexArray: Float32Array;
    indexArray: Uint32Array;
    color: Vec4;
  }>;
}

/**
 * Extract all geometry from an IFC file buffer.
 */
function extractGeometry(ifcApi: IfcAPI, modelId: number): IfcMeshData[] {
  const meshes: IfcMeshData[] = [];

  ifcApi.StreamAllMeshes(modelId, (mesh: any) => {
    const meshData: IfcMeshData = {
      expressId: mesh.expressID,
      geometries: [],
    };

    for (let i = 0; i < mesh.geometries.size(); i++) {
      const geom = mesh.geometries.get(i);
      const geometry = ifcApi.GetGeometry(modelId, geom.geometryExpressID);

      const verts = ifcApi.GetVertexArray(
        geometry.GetVertexData(),
        geometry.GetVertexDataSize()
      );
      const indices = ifcApi.GetIndexArray(
        geometry.GetIndexData(),
        geometry.GetIndexDataSize()
      );

      if (verts.length === 0 || indices.length === 0) {
        geometry.delete();
        continue;
      }

      // web-ifc vertex data is interleaved: [x, y, z, nx, ny, nz] per vertex
      const vertCount = verts.length / 6;
      const positions = new Float32Array(vertCount * 3);
      const normals = new Float32Array(vertCount * 3);

      for (let v = 0; v < vertCount; v++) {
        positions[v * 3] = verts[v * 6];
        positions[v * 3 + 1] = verts[v * 6 + 1];
        positions[v * 3 + 2] = verts[v * 6 + 2];
        normals[v * 3] = verts[v * 6 + 3];
        normals[v * 3 + 1] = verts[v * 6 + 4];
        normals[v * 3 + 2] = verts[v * 6 + 5];
      }

      // Apply placement transform if available
      const flatMatrix = geom.flatTransformation;
      if (flatMatrix && flatMatrix.length === 16) {
        applyTransform(positions, normals, flatMatrix);
      }

      meshData.geometries.push({
        vertexArray: positions,
        indexArray: new Uint32Array(indices),
        color: {
          x: geom.color.x,
          y: geom.color.y,
          z: geom.color.z,
          w: geom.color.w,
        },
      });

      geometry.delete();
    }

    if (meshData.geometries.length > 0) {
      meshes.push(meshData);
    }
  });

  return meshes;
}

/**
 * Apply a 4x4 transformation matrix to positions and normals.
 */
function applyTransform(
  positions: Float32Array,
  normals: Float32Array,
  m: number[] | Float64Array
): void {
  const vertCount = positions.length / 3;
  for (let i = 0; i < vertCount; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];

    // Transform position (4x4 matrix, column-major)
    positions[i * 3] = m[0] * px + m[4] * py + m[8] * pz + m[12];
    positions[i * 3 + 1] = m[1] * px + m[5] * py + m[9] * pz + m[13];
    positions[i * 3 + 2] = m[2] * px + m[6] * py + m[10] * pz + m[14];

    // Transform normal (upper-left 3x3, no translation)
    const nx = normals[i * 3];
    const ny = normals[i * 3 + 1];
    const nz = normals[i * 3 + 2];
    normals[i * 3] = m[0] * nx + m[4] * ny + m[8] * nz;
    normals[i * 3 + 1] = m[1] * nx + m[5] * ny + m[9] * nz;
    normals[i * 3 + 2] = m[2] * nx + m[6] * ny + m[10] * nz;
  }
}

/**
 * Build a GLB Document from extracted IFC meshes.
 */
function buildGLTFDocument(meshes: IfcMeshData[]): Document {
  const doc = new Document();
  const scene = doc.createScene("IFC Model");
  const buffer = doc.createBuffer();

  // Group by color to reduce material count
  const materialCache = new Map<string, ReturnType<Document["createMaterial"]>>();

  for (const mesh of meshes) {
    const node = doc.createNode(`IFC_${mesh.expressId}`);

    for (let gi = 0; gi < mesh.geometries.length; gi++) {
      const geom = mesh.geometries[gi];
      const gltfMesh = doc.createMesh(`Mesh_${mesh.expressId}_${gi}`);

      // Get or create material
      const colorKey = `${geom.color.x.toFixed(3)}_${geom.color.y.toFixed(3)}_${geom.color.z.toFixed(3)}_${geom.color.w.toFixed(3)}`;
      let material = materialCache.get(colorKey);
      if (!material) {
        material = doc.createMaterial(`Mat_${colorKey}`);
        material.setBaseColorFactor([geom.color.x, geom.color.y, geom.color.z, geom.color.w]);
        if (geom.color.w < 1.0) {
          material.setAlphaMode("BLEND");
        }
        materialCache.set(colorKey, material);
      }

      const primitive = doc.createPrimitive();
      primitive.setMaterial(material);
      primitive.setMode(4); // TRIANGLES

      const posAccessor = doc.createAccessor(`pos_${mesh.expressId}_${gi}`);
      posAccessor.setType("VEC3");
      posAccessor.setArray(new Float32Array(geom.vertexArray.buffer.slice(geom.vertexArray.byteOffset, geom.vertexArray.byteOffset + geom.vertexArray.byteLength)) as any);
      posAccessor.setBuffer(buffer);
      primitive.setAttribute("POSITION", posAccessor);

      // Create normals accessor from the same data
      // (normals were already extracted in extractGeometry)

      const idxAccessor = doc.createAccessor(`idx_${mesh.expressId}_${gi}`);
      idxAccessor.setType("SCALAR");
      idxAccessor.setArray(new Uint32Array(geom.indexArray.buffer.slice(geom.indexArray.byteOffset, geom.indexArray.byteOffset + geom.indexArray.byteLength)) as any);
      idxAccessor.setBuffer(buffer);
      primitive.setIndices(idxAccessor);

      gltfMesh.addPrimitive(primitive);

      const meshNode = doc.createNode(`Geom_${mesh.expressId}_${gi}`);
      meshNode.setMesh(gltfMesh);
      node.addChild(meshNode);
    }

    scene.addChild(node);
  }

  return doc;
}

export interface ConvertIFCResult {
  glbBuffer: Uint8Array;
  meshCount: number;
  vertexCount: number;
}

/**
 * Convert an IFC file buffer to GLB binary.
 */
export async function convertIFCtoGLB(
  ifcBuffer: Uint8Array | Buffer,
  onProgress?: (stage: string, pct: number) => void
): Promise<ConvertIFCResult> {
  const ifcApi = await getIfcApi();

  onProgress?.("parsing", 10);

  // Open the IFC model
  const modelId = ifcApi.OpenModel(new Uint8Array(ifcBuffer));

  onProgress?.("extracting", 30);

  // Extract geometry
  const meshes = extractGeometry(ifcApi, modelId);

  onProgress?.("building", 60);

  // Build GLTF document
  const doc = buildGLTFDocument(meshes);

  onProgress?.("encoding", 80);

  // Write to GLB binary
  const io = new NodeIO();
  const glbBuffer = await io.writeBinary(doc);

  // Count vertices
  let vertexCount = 0;
  for (const mesh of meshes) {
    for (const geom of mesh.geometries) {
      vertexCount += geom.vertexArray.length / 3;
    }
  }

  // Close model to free memory
  ifcApi.CloseModel(modelId);

  onProgress?.("done", 100);

  console.log(
    `[IFC→GLB] Converted: ${meshes.length} meshes, ${vertexCount.toLocaleString()} vertices, ${(glbBuffer.length / 1024 / 1024).toFixed(1)}MB`
  );

  return {
    glbBuffer,
    meshCount: meshes.length,
    vertexCount,
  };
}
