import { describe, expect, it } from "vitest";
import {
  deliveryTiming,
  formatInstitutionalDateOnly,
  institutionalDate,
  proposedDeliveryInstant,
  todayInInstitutionalTimeZone,
} from "./institutional-time";

describe("institutional time", () => {
  it("uses the Colombia calendar day even when UTC is already on the next day", () => {
    expect(institutionalDate("2026-10-30T02:00:00.000Z")).toBe("2026-10-29");
    expect(institutionalDate("2026-10-30T05:00:00.000Z")).toBe("2026-10-30");
    expect(institutionalDate("2026-10-31T04:59:59.000Z")).toBe("2026-10-30");
    expect(todayInInstitutionalTimeZone(new Date("2026-10-30T02:00:00.000Z"))).toBe("2026-10-29");
  });

  it("stores a proposed calendar date at noon in Colombia", () => {
    expect(proposedDeliveryInstant("2026-10-30")).toBe("2026-10-30T12:00:00-05:00");
    expect(() => proposedDeliveryInstant("2026-02-31")).toThrow();
    expect(() => proposedDeliveryInstant("30/10/2026")).toThrow();
  });

  it("classifies today, future and overdue by the institutional calendar date", () => {
    const now = new Date("2026-10-30T02:00:00.000Z"); // 2026-10-29 21:00 in Bogota
    expect(deliveryTiming("2026-10-29T17:00:00.000Z", now)).toBe("today");
    expect(deliveryTiming("2026-10-30T17:00:00.000Z", now)).toBe("future");
    expect(deliveryTiming("2026-10-28T17:00:00.000Z", now)).toBe("overdue");
    expect(deliveryTiming(null, now)).toBe("unscheduled");
  });

  it("formats date-only values without shifting the day through UTC", () => {
    expect(formatInstitutionalDateOnly("2026-10-30")).toContain("30");
    expect(formatInstitutionalDateOnly("2026-11-01")).toContain("1");
  });
});
