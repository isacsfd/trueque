export const INSTITUTIONAL_TIME_ZONE = "America/Bogota";
export const INSTITUTIONAL_UTC_OFFSET = "-05:00";

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const datePartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: INSTITUTIONAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateLabelFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: INSTITUTIONAL_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const dateTimeLabelFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: INSTITUTIONAL_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

function parseInstant(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Fecha no válida.");
  }
  return date;
}

function anchorDateOnly(date: string): Date {
  if (!DATE_ONLY_PATTERN.test(date)) {
    throw new Error("La fecha debe tener el formato AAAA-MM-DD.");
  }
  return parseInstant(`${date}T12:00:00${INSTITUTIONAL_UTC_OFFSET}`);
}

/** Calendar date in the institutional timezone, as YYYY-MM-DD. */
export function institutionalDate(value: Date | string = new Date()): string {
  const parts = datePartsFormatter.formatToParts(parseInstant(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("No se pudo interpretar la fecha institucional.");
  }
  return `${year}-${month}-${day}`;
}

export function todayInInstitutionalTimeZone(now: Date = new Date()): string {
  return institutionalDate(now);
}

/**
 * The proposed date is stored as noon in Colombia. This avoids the UTC
 * boundary changing the calendar day shown to the institution.
 */
export function proposedDeliveryInstant(date: string): string {
  const anchored = anchorDateOnly(date);
  if (institutionalDate(anchored) !== date) {
    throw new Error("La fecha propuesta no es válida.");
  }
  return `${date}T12:00:00${INSTITUTIONAL_UTC_OFFSET}`;
}

export function formatInstitutionalDate(value: string | Date): string {
  return dateLabelFormatter.format(parseInstant(value));
}

export function formatInstitutionalDateTime(value: string | Date): string {
  return dateTimeLabelFormatter.format(parseInstant(value));
}

export function formatInstitutionalDateOnly(date: string): string {
  return dateLabelFormatter.format(anchorDateOnly(date));
}

export type DeliveryTiming = "unscheduled" | "today" | "future" | "overdue";

export function deliveryTiming(
  scheduledAt: string | null | undefined,
  now: Date = new Date(),
): DeliveryTiming {
  if (!scheduledAt) return "unscheduled";
  const scheduledDate = institutionalDate(scheduledAt);
  const today = institutionalDate(now);
  if (scheduledDate === today) return "today";
  return scheduledDate > today ? "future" : "overdue";
}
