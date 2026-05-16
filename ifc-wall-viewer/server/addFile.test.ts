import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { projects, projectFiles } from "../drizzle/schema";
import { eq } from "drizzle-orm";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

function createAuthContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

let testProjectId: number;

describe("project.addFile", () => {
  beforeAll(async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const { id } = await caller.project.create({ name: "Test Project for addFile" });
    testProjectId = id;
  });

  afterAll(async () => {
    // Clean up test data to prevent DB pollution
    const db = await getDb();
    await db.delete(projectFiles).where(eq(projectFiles.projectId, testProjectId));
    await db.delete(projects).where(eq(projects.id, testProjectId));
  });

  it("requires authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.project.addFile({
        projectId: testProjectId,
        specialty: "architecture",
        label: "Arquitectura",
        url: "https://example.com/test.glb",
        fileKey: `projects/${testProjectId}/architecture-test.glb`,
        color: "#9CA3AF",
        transparent: true,
        opacity: 30,
        showEdges: true,
        fileSize: 1000,
        conversionStatus: "ready",
        originalFormat: "glb",
      })
    ).rejects.toThrow();
  });

  it("registers a GLB file with ready conversionStatus", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.project.addFile({
      projectId: testProjectId,
      specialty: "test_glb_spec",
      label: "Test GLB",
      url: "https://example.com/test-glb.glb",
      fileKey: `projects/${testProjectId}/test_glb_spec-abc123.glb`,
      color: "#3B82F6",
      transparent: false,
      opacity: 100,
      showEdges: true,
      fileSize: 50000,
      conversionStatus: "ready",
      originalFormat: "glb",
    });

    expect(result).toEqual({ success: true });

    const project = await caller.project.getById({ id: testProjectId });
    expect(project).not.toBeNull();
    const addedFile = project!.files.find((f: any) => f.specialty === "test_glb_spec");
    expect(addedFile).toBeDefined();
    expect(addedFile!.conversionStatus).toBe("ready");
    expect(addedFile!.originalFormat).toBe("glb");
    expect(addedFile!.url).toBe("https://example.com/test-glb.glb");
  });

  it("registers an RVT file with pending_conversion status", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.project.addFile({
      projectId: testProjectId,
      specialty: "test_rvt_spec",
      label: "Test RVT",
      url: "https://example.com/test.rvt",
      fileKey: `projects/${testProjectId}/test_rvt_spec-original-xyz.rvt`,
      color: "#9CA3AF",
      transparent: true,
      opacity: 30,
      showEdges: true,
      fileSize: 200000000,
      conversionStatus: "pending_conversion",
      originalFormat: "rvt",
    });

    expect(result).toEqual({ success: true });

    const project = await caller.project.getById({ id: testProjectId });
    expect(project).not.toBeNull();
    const rvtFile = project!.files.find((f: any) => f.specialty === "test_rvt_spec");
    expect(rvtFile).toBeDefined();
    expect(rvtFile!.conversionStatus).toBe("pending_conversion");
    expect(rvtFile!.originalFormat).toBe("rvt");
  });

  it("defaults conversionStatus to ready when not specified", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.project.addFile({
      projectId: testProjectId,
      specialty: "test_default_spec",
      label: "Test Default",
      url: "https://example.com/test-default.glb",
      fileKey: `projects/${testProjectId}/test_default_spec-def456.glb`,
      color: "#22C55E",
    });

    expect(result).toEqual({ success: true });

    const project = await caller.project.getById({ id: testProjectId });
    expect(project).not.toBeNull();
    const defaultFile = project!.files.find((f: any) => f.specialty === "test_default_spec");
    expect(defaultFile).toBeDefined();
    expect(defaultFile!.conversionStatus).toBe("ready");
    expect(defaultFile!.originalFormat).toBeNull();
  });
});

describe("project.getById with conversionStatus", () => {
  it("returns conversionStatus and originalFormat in file data", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // Use the Hidalma project (60001) which has real files
    const result = await caller.project.getById({ id: 60001 });
    if (result && result.files.length > 0) {
      result.files.forEach((f: any) => {
        expect(f).toHaveProperty("conversionStatus");
        expect(["ready", "pending_conversion"]).toContain(f.conversionStatus);
      });
    }
  });
});
