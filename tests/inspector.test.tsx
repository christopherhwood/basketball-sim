// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PlayerInspector } from "../src/ui/PlayerInspector.js";
import { seedRng } from "../src/core/rng.js";
import { newGame, G } from "../src/core/state.js";

afterEach(cleanup);

describe("PlayerInspector", () => {
  it("renders a player's identity, attribute labels, and tendency labels", () => {
    seedRng(1);
    newGame(1);
    const p = G.home[0];

    render(<PlayerInspector player={p} onClose={() => {}} />);

    // identity
    expect(screen.getByText(new RegExp(p.name))).toBeTruthy();
    // section headers + a sampling of labels from each group
    expect(screen.getByText("Attributes")).toBeTruthy();
    expect(screen.getByText("Tendencies")).toBeTruthy();
    expect(screen.getByText("Speed")).toBeTruthy();
    expect(screen.getByText("Shoot 3")).toBeTruthy();
    // the player's actual speed value is shown
    expect(screen.getAllByText(String(p.attr.speed)).length).toBeGreaterThan(0);
  });
});
