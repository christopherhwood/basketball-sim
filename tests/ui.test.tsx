// @vitest-environment jsdom
/*
 * tests/ui.test.tsx
 *
 * Smoke test: render <App/> and assert the scoreboard shows up.
 * jsdom has no canvas 2D context, so we stub getContext to return null;
 * createRenderer (src/render/render.ts) already no-ops on a null context.
 * We seed core game state before rendering (the Scoreboard reads G on its
 * very first paint, before App's effect runs) and unmount at the end to tear
 * down the requestAnimationFrame loop.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { App } from "../src/ui/App.js";
import { newGame } from "../src/core/state.js";

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  newGame(1);
});

afterEach(() => {
  cleanup();
});

describe("App smoke", () => {
  it("renders the scoreboard without throwing and tears down cleanly", () => {
    const { unmount } = render(<App />);

    expect(screen.getByText("YOU")).toBeTruthy();
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("12:00")).toBeTruthy();

    expect(() => unmount()).not.toThrow();
  });
});
