import type {
  AdmissionStatus,
  DeliveryStatus,
  DeliveryType,
  ExchangeStatus,
  ReceptionStatus,
  RequestStatus,
  SubmissionStatus,
  SubmissionWorkflowStatus,
} from "./types";

const requestLabels: Record<RequestStatus, string> = {
  pending: "Pendiente de revisión",
  under_review: "En revisión",
  approved: "Aprobada",
  rejected: "Denegada",
  scheduled: "Intercambio programado",
  in_process: "Intercambio en curso",
  cancellation_pending: "Cancelación pendiente de devolución",
  completed: "Completada",
  cancelled: "Cancelada",
};

const exchangeLabels: Record<ExchangeStatus, string> = {
  planned: "Planificado",
  in_process: "En curso",
  cancellation_pending: "Cancelación pendiente",
  completed: "Completado",
  cancelled: "Cancelado",
};

const receptionLabels: Record<ReceptionStatus, string> = {
  awaiting_delivery: "Esperando entrega del libro",
  received: "Libro recibido",
  in_custody: "En custodia",
  evaluated: "Evaluado",
  accepted: "Aceptado",
  rejected: "Rechazado",
  return_pending: "Devolución pendiente",
  returned: "Devuelto",
  cancelled: "Cancelado",
};

const admissionLabels: Record<AdmissionStatus, string> = {
  pending: "Pendiente",
  authorized: "Autorizada",
  admitted: "Admitida",
  enabled: "Habilitada",
  reversed: "Revertida",
  rejected: "Rechazada",
};

const deliveryLabels: Record<DeliveryStatus, string> = {
  scheduled: "Programada",
  in_progress: "En curso",
  completed: "Confirmada",
  cancelled: "Cancelada",
  missed: "No realizada",
};

const deliveryTypeLabels: Record<DeliveryType, string> = {
  offered_book_dropoff: "Entrega del libro ofrecido",
  offered_book_return: "Devolución del libro",
  institutional_copy_handover: "Entrega del ejemplar institucional",
};

export function requestStatusLabel(status: RequestStatus): string {
  return requestLabels[status] ?? status;
}

export function exchangeStatusLabel(status: ExchangeStatus | null): string {
  return status ? exchangeLabels[status] ?? status : "Sin intercambio";
}

export function receptionStatusLabel(status: ReceptionStatus | null): string {
  return status ? receptionLabels[status] ?? status : "Sin recepción";
}

export function admissionStatusLabel(status: AdmissionStatus | null): string {
  return status ? admissionLabels[status] ?? status : "Sin admisión";
}

export function deliveryStatusLabel(status: DeliveryStatus): string {
  return deliveryLabels[status] ?? status;
}

export function deliveryTypeLabel(type: DeliveryType): string {
  return deliveryTypeLabels[type] ?? type;
}

export function cancellationExplanation(status: RequestStatus, returnRequired: boolean, returnConfirmed: boolean): string | null {
  if (status !== "cancellation_pending") return null;
  if (returnConfirmed) {
    return "La devolución física está confirmada. El equipo administrativo debe cerrar la cancelación.";
  }
  if (returnRequired) {
    return "La cancelación queda pendiente: primero debe confirmarse la devolución física del libro.";
  }
  return "La cancelación está pendiente de cierre administrativo.";
}

const submissionLabels: Record<SubmissionStatus, string> = {
  draft: "Borrador",
  pending_review: "Pendiente de revisión",
  in_review: "En revisión",
  needs_information: "Requiere información adicional",
  preapproved: "Preaprobado (no aceptado)",
  rejected: "Rechazado",
};

const workflowLabels: Record<SubmissionWorkflowStatus, string> = {
  ...submissionLabels,
  pending_physical_delivery: "Pendiente de entrega física",
  received: "Recibido",
  accepted: "Aceptado",
  not_accepted: "No aceptado",
  cataloged: "Catalogado",
  enabled: "Habilitado",
};

export function submissionStatusLabel(status: SubmissionStatus | null): string {
  return status ? submissionLabels[status] ?? status : "Sin revisión fotográfica";
}

export function submissionWorkflowStatusLabel(status: SubmissionWorkflowStatus | null): string {
  return status ? workflowLabels[status] ?? status : "Sin revisión fotográfica";
}
