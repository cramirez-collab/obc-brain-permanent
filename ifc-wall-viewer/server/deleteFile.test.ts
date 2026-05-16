import { describe, it, expect, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

// Mock DB
vi.mock("./db", () => ({
  addProjectFile: vi.fn().mockResolvedValue({ id: 99, projectId: 1, specialty: "hvac", label: "HVAC", url: "https://s3.example.com/test.glb", fileKey: "projects/1/hvac.glb", color: "#2196F3", transparent: 0, opacity: 100, showEdges: 0, fileSize: 1000 }),
  deleteProjectFile: vi.fn().mockResolvedValue(undefined),
  getProjectById: vi.fn().mockResolvedValue({ id: 1, userId: 1, name: "Test", status: "ready" }),
}));

vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ url: "https://s3.example.com/test.glb", key: "test.glb" }),
  storageGet: vi.fn().mockResolvedValue({ url: "https://s3.example.com/test.glb", key: "test.glb" }),
}));

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

describe("project.deleteFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should delete a file by ID", async () => {
    const { deleteProjectFile } = await import("./db");
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.project.deleteFile({ fileId: 99 });
    expect(result).toEqual({ success: true });
    expect(deleteProjectFile).toHaveBeenCalledWith(99);
  });

  it("should require authentication", async () => {
    const ctx: TrpcContext = {
      user: null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    };
    const caller = appRouter.createCaller(ctx);

    await expect(caller.project.deleteFile({ fileId: 99 })).rejects.toThrow();
  });
});
