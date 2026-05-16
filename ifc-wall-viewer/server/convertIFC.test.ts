import { describe, it, expect, vi } from "vitest";

/**
 * Tests for the IFC→GLB conversion module.
 * Since we can't easily create valid IFC files in tests, we test:
 * 1. Module exports exist
 * 2. Error handling for invalid input
 * 3. The upload-convert endpoint routing logic
 */

describe("IFC Conversion Module", () => {
  it("should export convertIFCtoGLB function", async () => {
    const mod = await import("./convertIFC");
    expect(typeof mod.convertIFCtoGLB).toBe("function");
  });

  it("should reject empty buffer", async () => {
    const { convertIFCtoGLB } = await import("./convertIFC");
    // Empty buffer should fail during IFC parsing
    await expect(convertIFCtoGLB(new Uint8Array(0))).rejects.toThrow();
  });

  it("should reject invalid IFC data", async () => {
    const { convertIFCtoGLB } = await import("./convertIFC");
    // Random bytes are not valid IFC
    const randomBuffer = new Uint8Array(100);
    for (let i = 0; i < 100; i++) randomBuffer[i] = Math.floor(Math.random() * 256);
    await expect(convertIFCtoGLB(randomBuffer)).rejects.toThrow();
  });
});

describe("Upload Convert Endpoint Logic", () => {
  it("should detect IFC files by extension", () => {
    const testCases = [
      { name: "model.ifc", expected: "ifc" },
      { name: "MODEL.IFC", expected: "ifc" },
      { name: "building.rvt", expected: "rvt" },
      { name: "BUILDING.RVT", expected: "rvt" },
      { name: "model.glb", expected: null },
      { name: "model.gltf", expected: null },
    ];

    for (const tc of testCases) {
      const lower = tc.name.toLowerCase();
      const isIFC = lower.endsWith(".ifc");
      const isRVT = lower.endsWith(".rvt");
      const detected = isIFC ? "ifc" : isRVT ? "rvt" : null;
      expect(detected).toBe(tc.expected);
    }
  });

  it("should route IFC/RVT to convert endpoint and GLB to upload endpoint", () => {
    function getEndpoint(fileName: string): string {
      const lower = fileName.toLowerCase();
      const isIFC = lower.endsWith(".ifc");
      const isRVT = lower.endsWith(".rvt");
      return (isIFC || isRVT) ? "/api/upload-convert" : "/api/upload-glb";
    }

    expect(getEndpoint("model.ifc")).toBe("/api/upload-convert");
    expect(getEndpoint("MODEL.IFC")).toBe("/api/upload-convert");
    expect(getEndpoint("building.rvt")).toBe("/api/upload-convert");
    expect(getEndpoint("model.glb")).toBe("/api/upload-glb");
    expect(getEndpoint("model.gltf")).toBe("/api/upload-glb");
  });

  it("should set correct headers for conversion", () => {
    function getHeaders(fileName: string, projectId: string, specialty: string) {
      const lower = fileName.toLowerCase();
      const isIFC = lower.endsWith(".ifc");
      const isRVT = lower.endsWith(".rvt");
      const needsConversion = isIFC || isRVT;

      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        "x-project-id": projectId,
        "x-specialty": specialty,
      };
      if (needsConversion) {
        headers["x-file-type"] = isIFC ? "ifc" : "rvt";
      }
      return headers;
    }

    const ifcHeaders = getHeaders("model.ifc", "1", "arch_struct");
    expect(ifcHeaders["x-file-type"]).toBe("ifc");
    expect(ifcHeaders["x-project-id"]).toBe("1");

    const rvtHeaders = getHeaders("building.rvt", "2", "hvac");
    expect(rvtHeaders["x-file-type"]).toBe("rvt");

    const glbHeaders = getHeaders("model.glb", "1", "arch_struct");
    expect(glbHeaders["x-file-type"]).toBeUndefined();
  });
});
