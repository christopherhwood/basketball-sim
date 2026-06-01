import { G, offTeam, defTeam, hoop } from "../core/state.js";
import { dist, clamp, chance } from "../core/math.js";
import { effectiveTendencies } from "./tendency.js";
import { maxSpeed } from "./movement.js";
import { offBallDefensiveTarget, decideScreenCoverage, HELP_RECOGNITION_BASE } from "./defense.js";
import type { Snapshot } from "./snapshot.js";
import type { DecidedIntent } from "./intent.js";
import type { Player } from "../types.js";

/* ---------- RESOLVE (defense) ----------
   Applies the defensive intents from decideDefense() and performs the side-effects
   and rng draws that DECIDE deferred. This is the only place defensive rng is
   consumed; it is consumed in defender index order so the seeded stream stays a
   port spec. See docs/decide-pipeline-design.md.

   Fidelity note: this mirrors defenseMove()'s mutation half. Two deliberate micro
   differences (both inside the help branch, both re-baselined): the late-rotation
   catchShoot timing uses the clamped wall-up y, and a helper who DECLINES the
   rotation ("out") falls back to his straight man-coverage target rather than a
   prior closeout/lane-clear target. Neither changes the rng stream. */

export function resolveDefense(intents: DecidedIntent[], s: Snapshot): void {
  const def = defTeam();
  const off = offTeam();
  const h = hoop();
  const tac = s.tacDef;

  // ----- apply per-defender targets (help handled below, switch in the PnR step) -----
  for (const { who, intent } of intents) {
    switch (intent.kind) {
      case "contest":
      case "closeout":
      case "spaceTo":
        who.target = intent.to;
        break;
      // help, switchOnto, hold: handled out-of-loop / no target write
    }
  }

  // zone23 emits only spaceTo; no help/PnR bookkeeping (defenseMove returns early).
  if (tac.defScheme === "zone23") return;

  // ----- HELP recognition + clearing (the only defensive rng) -----
  if (!G.driving) {
    // drive over: clear per-drive help memo + catch-and-shoot priming
    for (const d of def) d.helpCommit = null;
    for (const o of off) o.catchShoot = false;
  } else {
    const helpDI = intents.find((di) => di.intent.kind === "help");
    if (helpDI && helpDI.intent.kind === "help") {
      const helper = helpDI.who;
      const to = helpDI.intent.to;
      // GATE 2 (recognition): decide ONCE per drive whether this helper rotates.
      if (helper.helpCommit == null) {
        const eff = effectiveTendencies(helper);
        const rec = clamp(
          HELP_RECOGNITION_BASE +
            (helper.attr.iq - 60) / 110 +
            (helper.attr.interiorD - 60) / 170 +
            (eff.helpDefense - 50) / 130,
          0.04,
          0.95,
        );
        helper.helpCommit = chance(rec) ? "in" : "out";
      }
      if (helper.helpCommit === "in") {
        helper.target = to; // wall up
        // GATE 3 (latency): rotating late primes the helper's man as a kick-out shooter.
        const driver = G.ball.holder;
        if (driver) {
          const bspeed = Math.hypot(driver.vx, driver.vy);
          const distToHoop = dist(driver, h) || 1;
          const tHelp = dist(helper, to) / (maxSpeed(helper) || 1);
          const driveSpeed = Math.max(bspeed, maxSpeed(driver) * 0.6);
          const tRim = Math.max(0, distToHoop - 4) / (driveSpeed || 1);
          const late = tHelp > tRim + 0.15;
          if (helper.assign && (late || dist(helper, helper.assign) > 4)) {
            helper.assign.catchShoot = true;
          }
        }
      } else if (helper.assign) {
        // declined: hold straight man coverage rather than rotating
        helper.target = offBallDefensiveTarget(helper, helper.assign, h);
      }
    }
  }

  // ----- PICK & ROLL coverage effects (deterministic) -----
  let scr: Player | null = null;
  if (G.ball.holder) {
    for (const o of off) {
      if (o !== G.ball.holder && dist(o, G.ball.holder) < 5.5) {
        scr = o;
        break;
      }
    }
  }
  if (scr) {
    const ball = G.ball.holder!;
    const ballD = def.find((d) => d.assign === ball);
    const scrD = def.find((d) => d.assign === scr);
    if (ballD && scrD && ballD !== scrD) {
      const cover = decideScreenCoverage(ballD, scrD, ball, scr, tac);
      if (cover === "switch") {
        // both defenders chose the switch (same decision decideDefense made) — swap.
        if (!G.pnrSwitched) {
          ballD.assign = scr;
          scrD.assign = ball;
          G.pnrSwitched = true;
        }
      } else if (cover === "hedge") {
        // hedge slows the handler (drop/hedge target points came through as intents)
        ball.vx *= 0.85;
        ball.vy *= 0.85;
      }
    }
  } else {
    G.pnrSwitched = false; // screen dispersed; a future screen may switch again
  }
}
