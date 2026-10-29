import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOfferedBookStatus } from "../lib/api";
import { PhotoFollowUp } from "./PhotoFollowUp";

vi.mock("../lib/api", () => ({
  fetchOfferedBookStatus: vi.fn(),
  uploadOfferedBookEvidence: vi.fn(),
  deleteOfferedBookEvidence: vi.fn(),
  updateOfferedBookDraft: vi.fn(),
  submitOfferedBook: vi.fn(),
}));

describe("seguimiento de revisión fotográfica", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("permite completar información cuando el revisor la solicita", async () => {
    sessionStorage.setItem("iub:offered-book-draft", JSON.stringify({
      submissionId: "4",
      accessToken: "draft-token-with-more-than-thirty-two-characters",
    }));
    vi.mocked(fetchOfferedBookStatus).mockResolvedValue({
      submissionId: "4",
      status: "needs_information",
      workflowStatus: "needs_information",
      requestedCopyId: "10",
      requestId: "55",
      requestCode: "IUB-2026-ABCD1234",
      requestStatus: "under_review",
      title: "Libro ofrecido",
      author: "Autora",
      publisher: null,
      genre: null,
      isbn: null,
      isbnNormalized: null,
      declaredCondition: "good",
      observations: null,
      submittedAt: "2026-10-29T00:00:00Z",
      reviewedAt: "2026-10-29T01:00:00Z",
      decisionReason: "Falta el lomo",
      reviewNotes: null,
      evidence: [],
    });

    render(<PhotoFollowUp />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Completar información" })).toBeInTheDocument();
    });
    expect(screen.getByText(/Falta el lomo/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reenviar fotografías" })).toBeInTheDocument();
  });
});
