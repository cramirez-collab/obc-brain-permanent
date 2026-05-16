import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

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

describe("project.getUploadUrl", () => {
  it("requires authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.project.getUploadUrl({
        projectId: 1,
        specialty: "architecture",
        fileType: "glb",
        fileName: "test.glb",
      })
    ).rejects.toThrow();
  });

  it("returns uploadUrl, fileKey, and authToken for GLB", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.project.getUploadUrl({
      projectId: 1,
      specialty: "architecture",
      fileType: "glb",
      fileName: "test.glb",
    });

    expect(result).toHaveProperty("uploadUrl");
    expect(result).toHaveProperty("fileKey");
    expect(result).toHaveProperty("authToken");
    expect(result.uploadUrl).toContain("/v1/storage/upload");
    expect(result.fileKey).toContain("projects/1/architecture-");
    expect(result.fileKey).toMatch(/\.glb$/);
    expect(result.authToken).toBeTruthy();
  });

  it("returns correct fileKey extension for RVT", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.project.getUploadUrl({
      projectId: 1,
      specialty: "hvac",
      fileType: "rvt",
      fileName: "model.rvt",
    });

    expect(result.fileKey).toContain("projects/1/hvac-");
    expect(result.fileKey).toMatch(/\.rvt$/);
  });

  it("returns correct fileKey extension for IFC", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.project.getUploadUrl({
      projectId: 1,
      specialty: "plumbing",
      fileType: "ifc",
      fileName: "pipes.ifc",
    });

    expect(result.fileKey).toContain("projects/1/plumbing-");
    expect(result.fileKey).toMatch(/\.ifc$/);
  });
});

describe("project.processUploadedFile", () => {
  it("requires authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.project.processUploadedFile({
        projectId: 1,
        specialty: "architecture",
        fileKey: "projects/1/architecture-test.rvt",
        fileType: "rvt",
        fileSize: 200000000,
        fileUrl: "https://example.com/test.rvt",
      })
    ).rejects.toThrow();
  });

  it("attempts RVT→IFC→GLB conversion via APS (fails gracefully on invalid URL)", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // RVT files now go through APS conversion pipeline, which requires downloading the file first
    // With a fake URL, it should throw an error about failing to download
    await expect(
      caller.project.processUploadedFile({
        projectId: 1,
        specialty: "architecture",
        fileKey: "projects/1/architecture-test.rvt",
        fileType: "rvt",
        fileSize: 200000000,
        fileUrl: "https://example.com/test.rvt",
      })
    ).rejects.toThrow();
  });
});
