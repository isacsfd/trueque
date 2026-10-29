import type {
  AdminActionBody,
  AdminWorkbenchItem,
  CatalogItem,
  CreateRequestResponse,
  RequestStatusView,
  ReservationResponse,
  SubmissionView,
  AdminAccount,
  AdminAccountsView,
  AdminStats,
  BatchDetail,
  BatchInspection,
  BatchSummary,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ApiErrorBody {
  error?: { code?: unknown; message?: unknown };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, "network_error", "No se pudo conectar con el servicio.");
  }

  if (response.status === 204) return undefined as T;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const errorBody = (body ?? {}) as ApiErrorBody;
    const code = typeof errorBody.error?.code === "string" ? errorBody.error.code : "request_failed";
    const message =
      typeof errorBody.error?.message === "string"
        ? errorBody.error.message
        : "No se pudo completar la operación.";
    throw new ApiError(response.status, code, message);
  }

  return body as T;
}

export function fetchCatalog(): Promise<CatalogItem[]> {
  return request<{ items: CatalogItem[] }>("/api/catalog").then((result) => result.items);
}

export function createExchangeRequest(input: {
  copyId: string;
  participantName: string;
  participantEmail: string;
  participantDocument: string;
  offeredTitle: string;
  offeredAuthor: string;
  offeredPublisher?: string;
  offeredGenre?: string;
  offeredIsbn?: string;
  offeredCondition: "excellent" | "good" | "fair" | "poor";
  offeredObservations?: string;
  consent: boolean;
  idempotencyKey: string;
}): Promise<CreateRequestResponse> {
  return request<CreateRequestResponse>("/api/requests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function reserveCopy(input: {
  requestId: string;
  copyId: string;
  accessToken: string;
  idempotencyKey: string;
}): Promise<ReservationResponse> {
  return request<ReservationResponse>("/api/requests/reserve", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchRequestStatus(input: {
  requestCode: string;
  accessToken: string;
}): Promise<RequestStatusView> {
  return request<RequestStatusView>("/api/requests/status", {
    method: "POST",
    body: JSON.stringify({ code: input.requestCode, token: input.accessToken }),
  });
}


export interface OfferedBookDraftInput {
  copyId: string;
  accessToken: string;
  title: string;
  author: string;
  publisher?: string;
  genre?: string;
  isbn?: string;
  declaredCondition: "excellent" | "good" | "fair" | "poor";
  observations?: string;
  idempotencyKey: string;
}

export function createOfferedBookDraft(input: OfferedBookDraftInput): Promise<{ submissionId: string; status: string }> {
  return request<{ submissionId: string; status: string }>("/api/offered-books", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateOfferedBookDraft(
  input: Omit<OfferedBookDraftInput, "idempotencyKey"> & { submissionId: string },
): Promise<{ submissionId: string; status: string }> {
  return request<{ submissionId: string; status: string }>("/api/offered-books", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function fetchOfferedBookStatus(input: {
  submissionId: string;
  accessToken: string;
}): Promise<SubmissionView> {
  return fetch(`/api/offered-books/status?id=${encodeURIComponent(input.submissionId)}`, {
    credentials: "same-origin",
    headers: { "X-Submission-Token": input.accessToken, Accept: "application/json" },
  }).then(async (response) => {
    const body = await response.json().catch(() => null) as { submission?: SubmissionView; error?: { code?: string; message?: string } } | null;
    if (!response.ok) {
      throw new ApiError(response.status, body?.error?.code ?? "request_failed", body?.error?.message ?? "No se pudo consultar el borrador.");
    }
    if (!body?.submission) throw new ApiError(500, "invalid_response", "Respuesta no válida.");
    return body.submission;
  });
}

export function submitOfferedBook(input: {
  submissionId: string;
  accessToken: string;
  idempotencyKey: string;
  participantName?: string;
  participantEmail?: string;
  participantDocument?: string;
  consent?: boolean;
}): Promise<CreateRequestResponse> {
  return request<CreateRequestResponse>("/api/offered-books/submit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function uploadOfferedBookEvidence(input: {
  submissionId: string;
  accessToken: string;
  slot: "cover" | "back_cover" | "spine" | "interior" | "damage";
  idempotencyKey: string;
  file: File;
}): Promise<{ evidenceId: string; slot: string; mime: string; bytes: number; width: number; height: number }> {
  const form = new FormData();
  form.set("submissionId", input.submissionId);
  form.set("slot", input.slot);
  form.set("idempotencyKey", input.idempotencyKey);
  form.set("file", input.file);
  const response = await fetch("/api/offered-books/evidence", {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-Submission-Token": input.accessToken, Accept: "application/json" },
    body: form,
  });
  const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.code ?? "upload_failed", body?.error?.message ?? "No se pudo subir la imagen.");
  }
  return body as { evidenceId: string; slot: string; mime: string; bytes: number; width: number; height: number };
}

export async function deleteOfferedBookEvidence(input: {
  evidenceId: string;
  accessToken: string;
}): Promise<void> {
  const response = await fetch(`/api/offered-books/evidence?id=${encodeURIComponent(input.evidenceId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "X-Submission-Token": input.accessToken },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status, body?.error?.code ?? "delete_failed", body?.error?.message ?? "No se pudo eliminar la imagen.");
  }
}

export async function fetchEvidenceBlob(evidenceId: string, accessToken?: string): Promise<Blob> {
  const endpoint = accessToken ? "/api/evidence" : "/api/admin/evidence";
  const response = await fetch(`${endpoint}?id=${encodeURIComponent(evidenceId)}`, {
    credentials: "same-origin",
    headers: accessToken ? { "X-Submission-Token": accessToken } : undefined,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status, body?.error?.code ?? "evidence_failed", body?.error?.message ?? "No se pudo cargar la imagen.");
  }
  return response.blob();
}


async function adminForm<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-IUB-Admin": "1" },
    body: form,
  });
  const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.code ?? "request_failed", body?.error?.message ?? "No se pudo completar la operación.");
  }
  return body as T;
}

export function inspectInventoryBatch(input: {
  file: File;
  sheetName?: string;
  headerRow?: number;
}): Promise<BatchInspection> {
  const form = new FormData();
  form.set("action", "inspect");
  form.set("file", input.file);
  if (input.sheetName) form.set("sheetName", input.sheetName);
  if (input.headerRow) form.set("headerRow", String(input.headerRow));
  return adminForm<BatchInspection>("/api/admin/batches", form);
}

export function prevalidateInventoryBatch(input: {
  file: File;
  sheetName: string;
  headerRow: number;
  mapping: Record<string, string>;
  observations?: string;
  idempotencyKey: string;
}): Promise<{
  batchId: string;
  status: string;
  totalRows: number;
  validRows: number;
  warningRows: number;
  rejectedRows: number;
  duplicateRows: number;
}> {
  const form = new FormData();
  form.set("action", "prevalidate");
  form.set("file", input.file);
  form.set("sheetName", input.sheetName);
  form.set("headerRow", String(input.headerRow));
  form.set("mapping", JSON.stringify(input.mapping));
  form.set("observations", input.observations ?? "");
  form.set("idempotencyKey", input.idempotencyKey);
  return adminForm("/api/admin/batches", form);
}

export function fetchInventoryBatches(): Promise<BatchSummary[]> {
  return request<{ items: BatchSummary[] }>("/api/admin/batches/list").then((result) => result.items);
}

export function fetchInventoryBatch(batchId: string): Promise<BatchDetail> {
  return request<BatchDetail>(`/api/admin/batches/detail?id=${encodeURIComponent(batchId)}`);
}

export function confirmInventoryBatch(batchId: string, idempotencyKey: string): Promise<{
  batchId: string; status: string; insertedRows: number; reusedRows: number; skippedRows: number;
}> {
  return request("/api/admin/batches/confirm", {
    method: "POST",
    headers: { "X-IUB-Admin": "1" },
    body: JSON.stringify({ batchId, idempotencyKey }),
  });
}

export function cancelInventoryBatch(batchId: string, idempotencyKey: string): Promise<{ batchId: string; status: string }> {
  return request("/api/admin/batches/cancel", {
    method: "POST",
    headers: { "X-IUB-Admin": "1" },
    body: JSON.stringify({ batchId, idempotencyKey }),
  });
}

export async function downloadInventoryBatchReport(batchId: string): Promise<Blob> {
  const response = await fetch(`/api/admin/batches/report?id=${encodeURIComponent(batchId)}`, {
    credentials: "same-origin",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status, body?.error?.code ?? "report_failed", body?.error?.message ?? "No se pudo descargar el reporte.");
  }
  return response.blob();
}

export function fetchAdminStats(months = 6): Promise<AdminStats> {
  return request<AdminStats>(`/api/admin/stats?months=${encodeURIComponent(String(months))}`);
}

export function fetchAdminAccount(): Promise<AdminAccount> {
  return request<AdminAccount>("/api/admin/account");
}

export function fetchAdminAccounts(): Promise<AdminAccountsView> {
  return request<AdminAccountsView>("/api/admin/accounts");
}

export function createAdminAccount(input: {
  identityIssuer?: string;
  identitySubject: string;
  email?: string;
}): Promise<{ ok: true; loginNote: string }> {
  return request("/api/admin/accounts", {
    method: "POST",
    headers: { "X-IUB-Admin": "1" },
    body: JSON.stringify({ action: "create", ...input }),
  });
}

export function setAdminAccountActive(userId: string, active: boolean): Promise<{ ok: true }> {
  return request("/api/admin/accounts", {
    method: "POST",
    headers: { "X-IUB-Admin": "1" },
    body: JSON.stringify({ action: "set_active", userId, active }),
  });
}

export function assignAdminRole(userId: string, roleId: string): Promise<{ ok: true }> {
  return request("/api/admin/accounts", {
    method: "POST",
    headers: { "X-IUB-Admin": "1" },
    body: JSON.stringify({ action: "assign_role", userId, roleId }),
  });
}

export function removeAdminRole(userId: string, roleId: string): Promise<{ ok: true }> {
  return request("/api/admin/accounts", {
    method: "POST",
    headers: { "X-IUB-Admin": "1" },
    body: JSON.stringify({ action: "remove_role", userId, roleId }),
  });
}

export function requestPasswordChange(): Promise<never> {
  return request<never>("/api/admin/account", {
    method: "POST",
    headers: { "X-IUB-Admin": "1" },
    body: JSON.stringify({}),
  });
}

export function loginAdmin(input: { username: string; password: string }): Promise<{ username: string }> {
  return request<{ username: string }>("/api/admin/session", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getAdminSession(): Promise<{ username: string }> {
  return request<{ username: string }>("/api/admin/session");
}

export function logoutAdmin(): Promise<void> {
  return request<void>("/api/admin/session", {
    method: "DELETE",
    headers: { "X-IUB-Admin": "1" },
  });
}

export function fetchAdminWorkbench(): Promise<AdminWorkbenchItem[]> {
  return request<{ items: AdminWorkbenchItem[] }>("/api/admin/workbench").then((result) => result.items);
}

export function runAdminAction(input: AdminActionBody & { action: AdminActionBody["action"] }): Promise<unknown> {
  return request<{ result: unknown }>("/api/admin/action", {
    method: "POST",
    headers: { "X-IUB-Admin": "1" },
    body: JSON.stringify(input),
  });
}
