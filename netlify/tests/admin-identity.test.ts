// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryAdmin } from "../lib/database.ts";
import { assertActiveAdminActor } from "../lib/admin-identity.ts";

vi.mock("../lib/database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/database.ts")>();
  return { ...actual, queryAdmin: vi.fn(), query: vi.fn() };
});

describe("administrative actor revalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts an active actor", async () => {
    vi.mocked(queryAdmin).mockResolvedValue([{ is_active: true }]);
    await expect(assertActiveAdminActor(7)).resolves.toBeUndefined();
    expect(queryAdmin).toHaveBeenCalledWith(
      expect.stringContaining("FROM public.app_users"),
      [7],
    );
  });

  it("rejects an inactive actor", async () => {
    vi.mocked(queryAdmin).mockResolvedValue([{ is_active: false }]);
    await expect(assertActiveAdminActor(7)).rejects.toMatchObject({
      status: 401,
      code: "admin_session_invalid",
    });
  });

  it("rejects an actor without a database identity", async () => {
    vi.mocked(queryAdmin).mockResolvedValue([]);
    await expect(assertActiveAdminActor(7)).rejects.toMatchObject({
      status: 401,
      code: "admin_session_invalid",
    });
  });

  it("rejects invalid actor identifiers without querying", async () => {
    await expect(assertActiveAdminActor(0)).rejects.toMatchObject({ status: 401 });
    await expect(assertActiveAdminActor(Number.NaN)).rejects.toMatchObject({ status: 401 });
    expect(queryAdmin).not.toHaveBeenCalled();
  });

  it("fails closed if the database is unavailable", async () => {
    const { DatabaseUnavailableError } = await import("../lib/database.ts");
    vi.mocked(queryAdmin).mockRejectedValueOnce(new DatabaseUnavailableError());
    await expect(assertActiveAdminActor(7)).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });
});
