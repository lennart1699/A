# Physics Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Verlet solver per-particle mass, range constraints, and wall friction, fix five known bugs, then add six body types that depend on those capabilities.

**Architecture:** `Particle` gains inverse mass; immovability becomes `invMass === 0` rather than a parallel boolean. A rigid link becomes the degenerate case of a min/max range constraint, so one record and one solver pass serve both. Friction bleeds tangential velocity at wall contacts. Six new body classes then land on that core, each implementing only `satisfyConstraints()` and `draw()`.

**Tech Stack:** Vanilla ES2020 in a single HTML file, canvas 2d, no runtime dependencies. Dev-only test harness: Node 22, `playwright-core`, headless Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

**Spec:** `docs/superpowers/specs/2026-09-22-physics-engine-core-design.md`

## Global Constraints

- `index.html` stays a single file, double-clickable, zero runtime dependencies: no npm, no CDN, no build step.
- Dark background `#0e1013`, thin light strokes, no gradients or shadows. Reads as a diagram, not a game.
- Test tooling is development-only and never ships to the page.
- `node_modules/` must be git-ignored; the session stop hook commits everything otherwise.
- Bodies implement only `satisfyConstraints(world)` and `draw(ctx, world)`; `tear()` stays optional.
- Chromium binary is pre-installed; never run `playwright install`.

## Review Focus

Input classes the spec implies but no task's own tests exercise. Each has its test folded into the owning task.

1. **Zero-length link** — two particles at identical positions give `d === 0`; the correction divides by `d`. Expect no NaN. (Task 2)
2. **All-immovable link** — both ends `invMass === 0` gives `wSum === 0`; must skip, not divide by zero. (Task 2)
3. **Inverted range** — `makeRange` called with `min > max` must not oscillate forever. (Task 3)
4. **Friction at 1.0** — full tangential bleed must bring a sliding particle to rest, not reverse it. (Task 4)
5. **Degenerate blob** — a blob whose ring is fully torn has near-zero perimeter; the pressure divisor must not explode. (Task 5)

---

### Task 1: Test harness and golden fixture

**Files:**
- Create: `package.json`, `.gitignore`, `tests/harness.js`, `tests/run.js`, `tests/fixtures/cloth-golden.json`
- Test: `tests/engine.test.js`

**Interfaces:**
- Produces: `withPage(fn)` — boots headless Chromium on `index.html` at 1100x720, yields a Playwright page, closes after. `step(page, n)` — sets `__world.paused = true` and calls `__world.step()` n times. `positions(page)` — returns a flat array of every particle's x,y. `assert(cond, msg)`, `assertClose(a, b, tol, msg)`.

**CRITICAL ORDERING:** the golden fixture must be captured from the **current, pre-refactor** build. Capturing it after any solver change asserts new behaviour against itself and proves nothing.

- [ ] **Step 1: Add `.gitignore` and `package.json`**

```
node_modules/
```

- [ ] **Step 2: Install `playwright-core`, write `tests/harness.js`**

- [ ] **Step 3: Add `World.paused`, checked in `update()` only**

`step()` stays unconditional so tests can drive it directly.

```js
update(frameSeconds) {
  if (this.paused) return;
  ...
}
```

- [ ] **Step 4: Capture the golden fixture from the current build**

Cloth scene, 1100x720 viewport, `friction` not yet present, 600 manual steps. Write positions to `tests/fixtures/cloth-golden.json`.

- [ ] **Step 5: Write the golden test and watch it PASS against the unchanged build**

This is the one test that must pass before its implementation — it is a regression pin, not a feature. It must be green now so that a later red means the refactor broke something.

- [ ] **Step 6: Commit**

### Task 2: Inverse mass replaces the pinned boolean

**Files:**
- Modify: `index.html` — `Particle`, `World.integrate`, `solveLinks`, `Blob.satisfyConstraints`, `startDrag`, `endDrag`, `togglePin`, `drawPins`
- Test: `tests/engine.test.js`

**Interfaces:**
- Consumes: harness from Task 1.
- Produces: `Particle(x, y, pinned=false)` keeps its signature but sets `invMass = pinned ? 0 : 1` and `baseInvMass = 1`. Immovability is `p.invMass === 0` everywhere.

- [ ] **Step 1: Write the failing tests**

Weighted split: a link between `invMass` 1 and `invMass` 3 moves the light end 3x as far. An `invMass` 0 end does not move. Zero-length link produces no NaN (Review Focus 1). Both-immovable link is skipped (Review Focus 2).

- [ ] **Step 2: Run, verify they fail** — `invMass` is undefined, so weighting is NaN.

- [ ] **Step 3: Implement**

```js
const wSum = a.invMass + b.invMass;
if (wSum === 0) continue;
const scale = ((d - target) / d) * k / wSum;
a.x += dx * scale * a.invMass;  a.y += dy * scale * a.invMass;
b.x -= dx * scale * b.invMass;  b.y -= dy * scale * b.invMass;
```

- [ ] **Step 4: Run the full suite** — new tests pass AND the Task 1 golden test still passes. The golden test is the proof that this refactor changed nothing.

- [ ] **Step 5: Commit**

### Task 3: Unified min/max constraints

**Files:**
- Modify: `index.html` — `makeLink`, `solveLinks`; add `makeRange`
- Test: `tests/engine.test.js`

**Interfaces:**
- Produces: `makeLink(a, b, rest)` sets `min = max = rest`. `makeRange(a, b, min, max)` sets them apart. Link record is `{ a, b, min, max, dead }`; `rest` no longer exists.

- [ ] **Step 1: Write the failing tests** — a range link holds a joint inside `[min, max]` under load; a rigid link still converges to its rest length; `min > max` settles rather than oscillating (Review Focus 3).

- [ ] **Step 2: Run, verify they fail** — `makeRange` is not defined.

- [ ] **Step 3: Implement**

```js
const target = d < L.min ? L.min : (d > L.max ? L.max : d);
if (target === d) continue;
```

- [ ] **Step 4: Run the full suite** — golden test still green.
- [ ] **Step 5: Commit**

### Task 4: Wall friction

**Files:**
- Modify: `index.html` — `World.constrainToBounds`, panel markup, `bindRange` wiring
- Test: `tests/engine.test.js`

**Interfaces:**
- Produces: `world.friction`, default `0.2`, slider id `i-friction`, readout id `v-friction`.

- [ ] **Step 1: Write the failing tests** — tangential velocity on floor contact decreases with `friction > 0`; is preserved exactly at `friction === 0`; at `friction === 1` the particle stops without reversing (Review Focus 4).

- [ ] **Step 2: Run, verify they fail** — `world.friction` undefined.

- [ ] **Step 3: Implement**

```js
if (p.y > h - m) { p.y = h - m; p.px += (p.x - p.px) * f; }
```

- [ ] **Step 4: Run the full suite.** The golden test must set `friction = 0` explicitly, since the default perturbs trajectories.
- [ ] **Step 5: Commit**

### Task 5: The five bug fixes

**Files:**
- Modify: `index.html` — `Cloth.draw`, `togglePin`, pointer handlers, `World.update`, `Blob.satisfyConstraints`
- Test: `tests/engine.test.js`

- [ ] **Step 1: Write five failing tests**, one per bug, plus the degenerate-blob guard (Review Focus 5).
- [ ] **Step 2: Run, verify each fails for the right reason.**
- [ ] **Step 3: Implement all five** per spec Section 4.
- [ ] **Step 4: Run the full suite.**
- [ ] **Step 5: Commit**

### Task 6: Phase 2 body types

**Files:**
- Modify: `index.html` — six new classes, `SCENES` entries, scene `<option>`s
- Test: `tests/engine.test.js`

Each body is one class implementing `satisfyConstraints()` and `draw()` only.

- [ ] **Step 1: Write one failing structural test per body** — particle and link counts, and the invariant that makes each body that body: Ragdoll joints stay within range, Wheel hub stays near its rim centroid, Spring extends further than a rigid rope under equal load, Bridge deck sags and recovers, Jelly holds area, Pendulum conserves height within damping tolerance.
- [ ] **Step 2: Run, verify they fail** — classes undefined.
- [ ] **Step 3: Implement the six classes.**
- [ ] **Step 4: Run the full suite, verify 60fps holds.**
- [ ] **Step 5: Commit**
