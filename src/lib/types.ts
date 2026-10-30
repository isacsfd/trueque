export type RequestStatus =
  | "pending"
  | "under_review"
  | "approved"
  | "rejected"
  | "scheduled"
  | "in_process"
  | "cancellation_pending"
  | "completed"
  | "cancelled";

export type ExchangeStatus =
  | "planned"
  | "in_process"
  | "cancellation_pending"
  | "completed"
  | "cancelled";

export type ReceptionStatus =
  | "awaiting_delivery"
  | "received"
  | "in_custody"
  | "evaluated"
  | "accepted"
  | "rejected"
  | "return_pending"
  | "returned"
  | "cancelled";

export type AdmissionStatus = "pending" | "authorized" | "admitted" | "enabled" | "reversed" | "rejected";

export type DeliveryStatus = "scheduled" | "in_progress" | "completed" | "cancelled" | "missed";

export type SubmissionStatus =
  | "draft"
  | "pending_review"
  | "in_review"
  | "needs_information"
  | "preapproved"
  | "rejected";

export type SubmissionWorkflowStatus =
  | SubmissionStatus
  | "pending_physical_delivery"
  | "received"
  | "accepted"
  | "not_accepted"
  | "cataloged"
  | "enabled";

export interface EvidenceItem {
  id: string;
  slot: "cover" | "back_cover" | "spine" | "interior" | "damage";
  mime: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: string;
}

export interface SubmissionView {
  submissionId: string;
  status: SubmissionStatus;
  workflowStatus: SubmissionWorkflowStatus;
  requestedCopyId: string;
  requestId: string | null;
  requestCode: string | null;
  requestStatus: RequestStatus | null;
  title: string;
  author: string;
  publisher: string | null;
  genre: string | null;
  isbn: string | null;
  isbnNormalized: string | null;
  declaredCondition: "excellent" | "good" | "fair" | "poor";
  observations: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  decisionReason: string | null;
  reviewNotes: string | null;
  evidence: EvidenceItem[];
}

export type DeliveryType = "offered_book_dropoff" | "offered_book_return" | "institutional_copy_handover";

export interface CatalogItem {
  copyId: string;
  bibliographicRecordId: string;
  title: string;
  author: string;
  isbn: string | null;
  edition: string | null;
  publicationYear: number | null;
  publisher: string | null;
  genre: string | null;
  inventoryCode: string;
  physicalCondition: string;
  location: string;
}

export interface DeliveryView {
  id: string;
  type: DeliveryType;
  status: DeliveryStatus;
  scheduledAt: string | null;
  completedAt: string | null;
  receiptReference: string | null;
  idempotencyKey: string;
}

export interface RequestHistoryItem {
  previousStatus: RequestStatus | null;
  newStatus: RequestStatus;
  changedBy: string | null;
  changedAt: string;
  reason: string | null;
}

export interface AdminWorkbenchItem {
  requestId: string;
  requestCode: string;
  requestStatus: RequestStatus;
  createdAt: string;
  requestedTitle: string;
  requestedInventoryCode: string;
  offeredTitle: string;
  offeredAuthor: string;
  offeredCondition: string;
  exchangeId: string | null;
  exchangeStatus: ExchangeStatus | null;
  cancellationKey: string | null;
  receptionId: string | null;
  receptionStatus: ReceptionStatus | null;
  evaluationId: string | null;
  evaluationOutcome: "accepted" | "rejected" | null;
  catalogingId: string | null;
  catalogingStatus: "pending" | "validated" | "authorized" | null;
  admissionId: string | null;
  admissionStatus: AdmissionStatus | null;
  offeredCopyId: string | null;
  history: RequestHistoryItem[];
  submissionId: string | null;
  submissionStatus: SubmissionStatus | null;
  submissionWorkflowStatus: SubmissionWorkflowStatus | null;
  submissionTitle: string | null;
  submissionAuthor: string | null;
  submissionCondition: string | null;
  submissionObservations: string | null;
  evidence: EvidenceItem[];
  deliveries: DeliveryView[];
}

export interface RequestStatusView {
  requestCode: string;
  status: RequestStatus;
  createdAt: string;
  copyTitle: string;
  requestedTitle?: string;
  requestedAuthor?: string | null;
  requestedInventoryCode?: string | null;
  offeredTitle?: string | null;
  offeredAuthor?: string | null;
  reservationStatus?: string | null;
  reservationLabel?: string;
  reservationExpiresAt?: string | null;
  exchangeStatus: ExchangeStatus | null;
  exchangeCompletedAt?: string | null;
  receptionStatus: ReceptionStatus | null;
  returnRequired?: boolean;
  returnConfirmed?: boolean;
  nextStep?: string;
}

export interface CreateRequestResponse {
  requestId: string;
  requestCode: string;
  accessToken: string;
  resubmitted?: boolean;
}

export interface ReservationResponse {
  reservationId: string;
  expiresAt: string;
}

export type AdminActionName =
  | "request.review"
  | "request.approve"
  | "request.reject"
  | "submission.review"
  | "exchange.plan"
  | "delivery.schedule"
  | "delivery.confirm"
  | "reception.custody"
  | "reception.evaluate"
  | "reception.return"
  | "cataloging.prepare"
  | "cataloging.authorize"
  | "admission.authorize"
  | "admission.admit"
  | "admission.enable"
  | "exchange.start"
  | "exchange.complete"
  | "exchange.cancel";

export interface AdminActionBody {
  action: AdminActionName;
  requestId?: string;
  newStatus?: "under_review" | "approved" | "rejected";
  reason?: string;
  submissionId?: string;
  reviewAction?: "start_review" | "request_information" | "preapprove" | "reject";
  notes?: string;
  planningKey?: string;
  exchangeId?: string;
  deliveryType?: DeliveryType;
  scheduledAt?: string;
  deliveryId?: string;
  receiptReference?: string;
  receptionId?: string;
  location?: string;
  custodian?: string;
  evidenceReference?: string;
  outcome?: "accepted" | "rejected";
  assessedCondition?: "excellent" | "good" | "fair" | "poor";
  rationale?: string;
  title?: string;
  author?: string;
  isbn?: string;
  isbnNormalized?: string;
  validationKey?: string;
  catalogingId?: string;
  authorizationKey?: string;
  admissionId?: string;
  inventoryCode?: string;
  completionKey?: string;
  cancellationKey?: string;
  idempotencyKey: string;
}

export interface BatchSheetInspection {
  name: string;
  headerRow: number;
  headers: string[];
  sampleRows: Array<{ rowNumber: number; values: string[] }>;
}

export interface BatchInspection {
  mode: "inspect";
  file: { name: string; size: number; sha256: string };
  sheets: string[];
  selected: BatchSheetInspection;
}

export interface BatchSummary {
  batchId: string;
  fileName: string;
  sha256: string;
  fileSize: number;
  sheetName: string;
  status: "prevalidated" | "confirmed" | "cancelled" | "failed";
  totalRows: number;
  validRows: number;
  warningRows: number;
  rejectedRows: number;
  duplicateRows: number;
  insertedRows: number;
  reusedRows: number;
  observations: string | null;
  createdBy: string;
  createdAt: string;
  confirmedAt: string | null;
}

export interface BatchRowDetail {
  sourceRow: number;
  status: string;
  errors: string[];
  warnings: string[];
  mapped: Record<string, string | null>;
  inventoryCode: string | null;
  bibliographicRecordId: string | null;
  copyId: string | null;
}

export interface BatchDetail {
  batch: BatchSummary & { headerRow: number; mapping: Record<string, string>; confirmedBy: string | null };
  rows: BatchRowDetail[];
}

export interface AdminStats {
  range: { months: number };
  inventory: {
    totalCopies: number;
    institutionalTotal: number;
    available: number;
    unavailable: number;
    reserved: number;
    maintenance: number;
    retired: number;
    verified: number;
    unverified: number;
    unassessed: number;
    publicCatalog: number;
  };
  requests: Record<string, number>;
  submissions: Record<string, number>;
  offersInReview: number;
  receptions: Record<string, number>;
  evaluations: Record<string, number>;
  admissions: Record<string, number>;
  exchanges: Record<string, number>;
  batches: Record<string, number>;
  legacyImport: Record<string, number>;
  trends: {
    months: number;
    requests: Array<{ period: string; count: number }>;
    batches: Array<{ period: string; count: number }>;
    completedExchanges: Array<{ period: string; count: number }>;
  };
}

export interface AdminAccount {
  username: string;
  actorUserId: number;
  expiresAt: string;
  canChangePassword: boolean;
  passwordManagedBy: string;
  management: string;
}

export interface AdminAccountRole {
  roleId: string;
  roleKey: string;
  displayName: string;
  description: string | null;
}

export interface AdminAccountListItem {
  userId: string;
  identityIssuer: string | null;
  identitySubject: string;
  email: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  roles: AdminAccountRole[];
  permissions: string[];
}

export interface AdminRole {
  roleId: string;
  roleKey: string;
  displayName: string;
  description: string | null;
  permissions: string[];
}

export interface AdminPermission {
  key: string;
  description: string;
}

export interface AdminAccountsView {
  currentActorUserId: string;
  accounts: AdminAccountListItem[];
  roles: AdminRole[];
  permissions: AdminPermission[];
}
