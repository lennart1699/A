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

/* ---------------------------------------------------------------- *
 * Task 2 -- inverse mass replaces the pinned boolean.
 * ---------------------------------------------------------------- */

// Build a bare two-particle world: no gravity, no bounds interference,
// one over-stretched link. The solver's only job is to pull them together.
async function twoParticleLink(page, aInv, bInv, sep, rest) {
  return page.evaluate(({ aInv, bInv, sep, rest }) => {
    const w = window.__world;
    w.paused = true;
    w.clear();
    w.gravityOn = false;
    w.windOn = false;
    const body = new Body();
    const a = new Particle(400, 300);
    const b = new Particle(400 + sep, 300);
    a.invMass = aInv; a.baseInvMass = aInv;
    b.invMass = bInv; b.baseInvMass = bInv;
    body.particles.push(a, b);
    body.links = [makeLink(a, b, rest)];
    body.satisfyConstraints = wd => solveLinks(body.links, wd.stiffness);
    w.add(body);
    const ax0 = a.x, bx0 = b.x;
    solveLinks(body.links, 1);
    return { aMoved: a.x - ax0, bMoved: b.x - bx0, ax: a.x, bx: b.x };
  }, { aInv, bInv, sep, rest });
}

test("correction splits by inverse mass", async () => {
  await withPage(async page => {
    // Light end (invMass 3) must travel 3x as far as the heavy end (invMass 1).
    const r = await twoParticleLink(page, 1, 3, 120, 100);
    assert(r.aMoved > 0, `heavy end should move toward light end, moved ${r.aMoved}`);
    assert(r.bMoved < 0, `light end should move toward heavy end, moved ${r.bMoved}`);
    assertClose(Math.abs(r.bMoved) / Math.abs(r.aMoved), 3, 1e-9,
      "light:heavy displacement ratio");
  });
});

test("an invMass 0 end does not move", async () => {
  await withPage(async page => {
    const r = await twoParticleLink(page, 0, 1, 120, 100);
    assertClose(r.aMoved, 0, 0, "immovable end displacement");
    assertClose(r.bMoved, -20, 1e-9, "free end absorbs the whole correction");
  });
});

test("a link between two immovable ends is skipped, not divided by zero", async () => {
  await withPage(async page => {
    const r = await twoParticleLink(page, 0, 0, 120, 100);
    assertFinite([r.ax, r.bx], "both-immovable link produced a non-finite position");
    assertClose(r.aMoved, 0, 0, "first immovable end");
    assertClose(r.bMoved, 0, 0, "second immovable end");
  });
});

test("a zero-length link does not produce NaN", async () => {
  await withPage(async page => {
    const r = await twoParticleLink(page, 1, 1, 0, 50);
    assertFinite([r.ax, r.bx], "coincident particles produced a non-finite position");
  });
});

test("pin toggling restores the particle's own mass, not a default", async () => {
  await withPage(async page => {
    const r = await page.evaluate(() => {
      const p = new Particle(10, 10);
      p.invMass = 0.25; p.baseInvMass = 0.25;   // a heavy particle
      const w = window.__world;
      w.paused = true; w.clear();
      const body = new Body();
      body.particles.push(p);
      w.add(body);
      w.mouse = { x: 10, y: 10 };
      w.togglePin(10, 10);
      const pinned = p.invMass;
      w.togglePin(10, 10);
      return { pinned, restored: p.invMass };
    });
    assertClose(r.pinned, 0, 0, "pinning should set invMass to 0");
    assertClose(r.restored, 0.25, 1e-12, "unpinning should restore the original mass");
  });
});
