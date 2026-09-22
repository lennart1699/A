"use strict";
const fs = require("fs");
const path = require("path");
const {
  withPage, freeze, step, positions,
  assert, assertClose, assertFinite,
} = require("./harness");

const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "cloth-golden.json"), "utf8")
);

/* ---------------------------------------------------------------- *
 * Task 1 -- determinism and the golden regression pin.
 * ---------------------------------------------------------------- */

test("solver is deterministic across runs", async () => {
  const run = () => withPage(async page => {
    await freeze(page);
    await page.evaluate(() => { setScene("cloth"); window.__world.windOn = false; });
    await step(page, 120);
    return positions(page);
  });
  const a = await run();
  const b = await run();
  assert(a.length === b.length, "particle counts differ between runs");
  for (let i = 0; i < a.length; i++) {
    assert(a[i] === b[i], `run-to-run drift at index ${i}: ${a[i]} vs ${b[i]}`);
  }
});

test("cloth matches golden positions (regression pin)", async () => {
  const actual = await withPage(async page => {
    await freeze(page);
    await page.evaluate(() => {
      setScene("cloth");
      window.__world.windOn = false;
      // Friction perturbs trajectories; the golden fixture predates it.
      if ("friction" in window.__world) window.__world.friction = 0;
    });
    await step(page, GOLDEN.steps);
    return positions(page);
  });
  assertFinite(actual, "golden run produced a non-finite value");
  assert(actual.length === GOLDEN.positions.length,
    `expected ${GOLDEN.positions.length / 2} particles, got ${actual.length / 2}`);
  let worst = 0, worstAt = -1;
  for (let i = 0; i < actual.length; i++) {
    const d = Math.abs(actual[i] - GOLDEN.positions[i]);
    if (d > worst) { worst = d; worstAt = i; }
  }
  assert(worst <= 1e-6,
    `max drift ${worst} at index ${worstAt} (particle ${Math.floor(worstAt / 2)}) exceeds 1e-6`);
});
