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

/* ---------------------------------------------------------------- *
 * Task 3 -- a rigid link is a range whose ends coincide.
 * ---------------------------------------------------------------- */

// Two particles pulled apart by gravity, joined by one constraint.
// Returns the separation once the solver has settled.
async function settleJoint(page, make, steps = 400) {
  return page.evaluate(({ make, steps }) => {
    const w = window.__world;
    w.paused = true; w.clear();
    w.gravityOn = true; w.windOn = false;
    const a = new Particle(500, 200, true);       // anchor
    const b = new Particle(500, 260);             // hangs below
    const body = new Body();
    body.particles.push(a, b);
    // eslint-disable-next-line no-new-func
    body.links = [new Function("a", "b", "return " + make)(a, b)];
    body.satisfyConstraints = wd => solveLinks(body.links, wd.stiffness);
    w.add(body);
    for (let i = 0; i < steps; i++) w.step();
    return { sep: Math.hypot(b.x - a.x, b.y - a.y), bx: b.x, by: b.y };
  }, { make, steps });
}

test("a rigid link still converges to its rest length", async () => {
  await withPage(async page => {
    const r = await settleJoint(page, "makeLink(a, b, 60)");
    assertFinite([r.bx, r.by], "rigid link produced a non-finite position");
    assertClose(r.sep, 60, 1.0, "rigid link separation under gravity");
  });
});

test("a range link lets the joint travel between min and max", async () => {
  await withPage(async page => {
    // Gravity pulls the free end down; the range should stop it at max.
    const r = await settleJoint(page, "makeRange(a, b, 40, 90)");
    assert(r.sep <= 90 + 1.0, `separation ${r.sep} exceeded max 90`);
    assert(r.sep >= 40 - 1.0, `separation ${r.sep} fell below min 40`);
    assertClose(r.sep, 90, 1.0, "gravity should drive the joint to its max");
  });
});

test("a range link does not correct while inside its range", async () => {
  await withPage(async page => {
    const moved = await page.evaluate(() => {
      const w = window.__world;
      w.paused = true; w.clear(); w.gravityOn = false;
      const a = new Particle(400, 300), b = new Particle(460, 300);  // 60 apart
      const links = [makeRange(a, b, 40, 90)];                       // inside
      const ax = a.x, bx = b.x;
      solveLinks(links, 1);
      return { a: a.x - ax, b: b.x - bx };
    });
    assertClose(moved.a, 0, 0, "left end moved while inside the range");
    assertClose(moved.b, 0, 0, "right end moved while inside the range");
  });
});

test("an inverted range settles instead of oscillating", async () => {
  await withPage(async page => {
    // min > max is a caller error; it must not diverge or produce NaN.
    const r = await page.evaluate(() => {
      const w = window.__world;
      w.paused = true; w.clear(); w.gravityOn = false;
      const a = new Particle(400, 300), b = new Particle(470, 300);
      const links = [makeRange(a, b, 90, 40)];   // inverted on purpose
      for (let i = 0; i < 200; i++) solveLinks(links, 1);
      const settled = Math.hypot(b.x - a.x, b.y - a.y);
      solveLinks(links, 1);
      const after = Math.hypot(b.x - a.x, b.y - a.y);
      return { ax: a.x, ay: a.y, bx: b.x, by: b.y,
               sep: settled, drift: Math.abs(after - settled) };
    });
    assertFinite([r.ax, r.ay, r.bx, r.by], "inverted range produced a non-finite position");
    assert(r.sep < 1e4, `inverted range diverged to separation ${r.sep}`);
    assert(r.drift < 1e-9,
      `inverted range is still oscillating: separation moved ${r.drift} in one more pass`);
  });
});

/* ---------------------------------------------------------------- *
 * Task 4 -- wall friction.
 * ---------------------------------------------------------------- */

// A single particle sliding along the floor. Returns its horizontal speed
// (which in Verlet is just x - px) after n steps.
async function slideOnFloor(page, friction, steps) {
  return page.evaluate(({ friction, steps }) => {
    const w = window.__world;
    w.paused = true; w.clear();
    w.gravityOn = true; w.windOn = false;
    w.friction = friction;
    const p = new Particle(300, w.height - w.margin);
    p.px = p.x - 8;                      // moving right at 8px/step
    const body = new Body();
    body.particles.push(p);
    w.add(body);
    for (let i = 0; i < steps; i++) w.step();
    return { vx: p.x - p.px, x: p.x, y: p.y };
  }, { friction, steps });
}

test("friction bleeds tangential speed on floor contact", async () => {
  await withPage(async page => {
    // Measured against a frictionless slide, not against the initial speed:
    // global damping alone drops 8 to ~7.24 over 20 steps, so comparing with
    // the starting value would pass even with no friction implemented.
    const free = await slideOnFloor(page, 0, 20);
    const held = await slideOnFloor(page, 0.2, 20);
    assertFinite([held.vx, held.x, held.y], "friction produced a non-finite value");
    assert(held.vx > 0, `particle should still be moving right, got vx ${held.vx}`);
    assert(held.vx < free.vx * 0.5,
      `friction should cost far more than damping: ${held.vx} vs frictionless ${free.vx}`);
  });
});

test("friction 0 preserves tangential speed", async () => {
  await withPage(async page => {
    const r = await slideOnFloor(page, 0, 20);
    // Only the global damping applies: 8 * 0.995^20 with no friction loss.
    assertClose(r.vx, 8 * Math.pow(0.995, 20), 1e-6,
      "frictionless slide should lose only the global damping");
  });
});

test("friction 1 stops a slide without reversing it", async () => {
  await withPage(async page => {
    const r = await slideOnFloor(page, 1, 20);
    assertFinite([r.vx], "full friction produced a non-finite velocity");
    assert(r.vx >= 0, `full friction reversed the particle: vx ${r.vx}`);
    assertClose(r.vx, 0, 1e-9, "full friction should bring the slide to rest");
  });
});

test("friction is exposed on the panel and drives the world", async () => {
  await withPage(async page => {
    await page.locator("#i-friction").fill("0.65");
    const v = await page.evaluate(() => ({
      world: window.__world.friction,
      label: document.getElementById("v-friction").textContent,
    }));
    assertClose(v.world, 0.65, 1e-9, "slider should drive world.friction");
    assert(v.label.indexOf("0.6") === 0, `readout should show the value, got "${v.label}"`);
  });
});
