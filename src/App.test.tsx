import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("inicio del sistema de intercambio", () => {
  it("presenta el servicio como preparación y no inventa libros disponibles", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Intercambio de libros" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Aún no hay libros publicados",
    );
    expect(screen.getByText("Plataforma en preparación")).toBeInTheDocument();
  });
});
