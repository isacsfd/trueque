// Kept as a distinct endpoint for older clients. Both paths return the same
// request detail, contact permissions and decision history.
export { default } from "./admin-workbench.ts";

export const config = { path: "/api/admin/workbench-v2" };
