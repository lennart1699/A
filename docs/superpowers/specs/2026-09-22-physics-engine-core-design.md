# Physics Engine Core — Design

**Date:** 2026-09-22
**Status:** Awaiting review
**Scope:** Phase 1 of 2. Phase 2 (body catalogue) is a separate cycle.

## Intent

The playground's solver was built so that adding a body type means writing one
class with `satisfyConstraints()` and `draw()`. Six new body types are wanted
(Ragdoll, Wheel, Spring, Bridge, Jelly, Pendulum). Three of them need
capabilities the engine does not currently have:

- **Ragdoll** needs joint angle limits. Distance constraints alone let a limb
  fold back through itself.
- **Wheel** needs surface friction. The current bounds clamp preserves
  tangential velocity exactly, so a wheel would slide rather than roll.
- **Ragdoll and Bridge** need per-particle mass. `solveLinks()` splits every
  correction 50/50, so a heavy torso and a light forearm are indistinguishable.

Phase 1 adds those three capabilities to the core and fixes five known bugs.
No new body types ship in Phase 1. Success is that the engine can express what
Phase 2 needs, with existing behaviour preserved where it should be and
deliberately changed only where friction requires.

### Constraints carried from the original brief

- `index.html` remains a single file, opened by double-clicking, with no
  runtime dependencies: no npm, no CDN, no build step.
- Dark background, thin light strokes, no gradients or shadows. It should read
  as a diagram, not a game.
- Test tooling is development-only and never ships to the page.

## Section 1 — Particle and mass model

`Particle` gains two fields:

| Field | Meaning |
|-------|---------|
| `invMass` | Inverse mass. `0` means immovable. Default `1`. |
| `baseInvMass` | The value `invMass` returns to when unpinned. Captured at construction. |

`pinned` ceases to be stored state. Immovability is `invMass === 0`. Every
current read of `p.pinned` migrates:

- `World.integrate()` — skip and freeze history when `invMass === 0`
- `solveLinks()` — weight corrections by inverse mass (below)
- `Blob.satisfyConstraints()` — skip pressure displacement for immovable points
- `World.startDrag()` / `endDrag()` — store and restore the prior `invMass`
- `World.togglePin()` — flip between `0` and `baseInvMass`
- `drawPins()` — render points whose `invMass` is `0`

The weighted solve:

```js
const wSum = a.invMass + b.invMass;
if (wSum === 0) continue;
const scale = ((d - target) / d) * k / wSum;
a.x += dx * scale * a.invMass;
a.y += dy * scale * a.invMass;
b.x -= dx * scale * b.invMass;
b.y -= dy * scale * b.invMass;
```

**Behaviour-preservation property — CORRECTED 2026-09-22 after test.**

The original claim ("the mass refactor changes no existing trajectory") was
wrong, and the golden test caught it. The correction below is what actually
holds.

*For links with two free ends*, the claim is exact. With `invMass === 1` on
both, `wSum === 2` and `scale` reduces to `((d - target) / d) * k / 2`,
algebraically identical to the old `* 0.5`. These trajectories are unchanged.

*For links with one immovable end, behaviour deliberately changes.* The old
solver computed the half-correction and then skipped the pinned end, so a
pinned link only ever applied **half** its correction to the free end —
under-relaxing every constraint anchored to a pin. Under inverse mass,
`wSum === 0 + 1 === 1` and the free end absorbs the **whole** correction,
which is the standard position-based-dynamics behaviour.

Measured on the cloth after 600 steps, worst-case constraint residual
`|d - rest|` improves from **1.70973 to 0.83151** (mean 0.23144 to 0.21597),
and in both builds the worst link is a pinned one. The change is an
improvement, not a regression, so it is accepted and the golden fixture is
re-captured from the post-refactor solver.

**Consequence for verification:** the golden test can no longer prove "the
mass refactor changed nothing", because it did. It is retained as a pin
against *future* changes, and the fixture records which solver produced it.

## Section 2 — Constraint representation

A rigid distance constraint is the degenerate case of a range constraint where
the minimum and maximum coincide. One record serves both:

```js
{ a, b, min, max, dead }
```

- `makeLink(a, b, rest)` sets `min = max = rest` — a rigid link.
- `makeRange(a, b, min, max)` sets them apart — a joint limit.

`solveLinks()` clamps the measured distance into `[min, max]` and corrects
toward that target, skipping when the distance already lies inside the range:

```js
const target = d < L.min ? L.min : (d > L.max ? L.max : d);
if (target === d) continue;
```

`strokeLinks()` and `tearLinks()` are unchanged; neither reads `rest`.

Cost is one extra number per link and two comparisons per solve, against
~46k solves per step at 20 iterations — immaterial. Benefit is a single hot
loop and one constraint concept rather than two parallel lists.

## Section 3 — Friction and bounds

`World.friction`, default `0.2`, exposed as a panel slider beside stiffness.

Applied in `constrainToBounds()` when a particle contacts a wall, bleeding the
velocity component tangential to that wall. In Verlet, velocity is implicit in
`x - px`, so reducing it by factor `f` means moving the previous position
toward the current one:

```js
p.px += (p.x - p.px) * friction;   // on a floor or ceiling contact
p.py += (p.y - p.py) * friction;   // on a side-wall contact
```

**This deliberately changes two existing scenes.** The circle box will settle
into a stable pile instead of skating along the floor, and cloth corners will
stop sliding. Verification must therefore separate two claims: the mass
refactor preserves all existing trajectories exactly, and friction changes them
in a specific, intended direction. Those are different tests.

## Section 4 — Bug fixes

Found during review of the current build; all five land in Phase 1.

1. **Orphaned particles are invisible but interactive.** `Cloth.draw()` strokes
   live links and fills only immovable points, so a particle torn free of all
   neighbours still falls and is still returned by `World.pick()` while
   rendering nothing. Fix: draw a particle with no live links as a 2px dot in
   the link stroke colour, so a grabbable point is always visible.
2. **`P` mid-drag is silently reverted.** `startDrag()` captures the pin state
   and `endDrag()` restores it unconditionally, discarding a toggle made during
   the drag. Fix: `togglePin` updates the captured value when the target is the
   grabbed particle.
3. **Right-click ends a left-drag.** `endPointer` calls `endDrag()` on any
   pointerup. Fix: track the two buttons independently.
4. **Stale cursor for `P`.** `world.mouse` updates only from canvas
   `pointermove`, so it is stale while the cursor is over the panel. Fix:
   listen at window level and convert coordinates.
5. **Accumulator discards up to one frame.** `if (steps === MAX_STEPS)
   this.accumulator = 0` fires even when the loop exited normally having
   banked legitimate time. Fix: zero it only when the loop actually overran.

## Section 5 — Testing

Development-only harness: `package.json`, `tests/`, `playwright-core` driving
`index.html` in headless Chromium. `index.html` gains no dependencies and
remains double-clickable. Work proceeds test-first per the
`test-driven-development` skill: each test is written and watched failing
before the code that satisfies it.

### Determinism requirement

The render loop advances the simulation from real frame timing, which is not
reproducible. Tests must drive the solver directly:

- `World.paused` (default `false`) is added; `update()` returns early when set.
  This exists to make the solver drivable from a test, and is checked in
  `update()` only — `step()` stays unconditional so tests can call it.
- A test sets `__world.paused = true`, builds a scene, calls `__world.step()`
  a fixed number of times, and reads positions. Given a fixed viewport and a
  scene without randomness, this is exactly reproducible.
- The cloth scene is the deterministic fixture: a fixed grid, no `Math.random()`,
  and a wind gust driven by `sin(world.time)` which advances only inside
  `step()`. The circles scene uses `Math.random()` at construction and is not
  a valid golden fixture.

### Tests

| Test | Asserts |
|------|---------|
| Golden positions | Cloth at fixed viewport, `friction = 0`, 600 manual steps, every particle within `1e-6` of the fixture. Pins the solver against unintended change. The fixture records which solver captured it; see the corrected note in Section 1. |
| Weighted correction | A two-particle link with `invMass` 1 and 3 moves the lighter end three times as far; an `invMass` 0 end does not move at all. |
| Range constraint | A joint under load stays within `[min, max]`; a rigid link (`min === max`) still converges to `rest`. |
| Friction | Tangential velocity of a particle resting on the floor decreases step over step with `friction > 0`, and is preserved exactly with `friction === 0`. |
| Bug 1 | A particle with every link dead is still rendered (non-background pixel at its position). |
| Bug 2 | `P` during a drag survives release. |
| Bug 3 | A right-button press and release during a left-drag leaves the left-drag active. |
| Bug 4 | `world.mouse` tracks a pointer moved over the panel region. |
| Bug 5 | A frame needing exactly `MAX_STEPS` steps retains its sub-`DT` remainder; a longer stall still drops the backlog. |
| Performance | Cloth at 20 iterations holds a median frame under 20ms. |

**The golden test must set `world.friction = 0` explicitly.** Friction defaults
to `0.2` and perturbs trajectories, so leaving it at its default would make the
golden comparison fail for a reason unrelated to what it is testing. Friction is
covered by its own test instead.

### Sequencing constraint

The golden fixture must be captured before the refactor it is meant to police,
and committed as test data. Capturing it afterwards asserts new behaviour
against itself and proves nothing.

This was done, and it worked: the pre-refactor fixture detected a real
behavioural change at pinned links that had been reasoned about incorrectly in
this spec. Having established that the change is an improvement, the fixture is
re-captured from the post-refactor solver and carries a `capturedFrom` field
recording that.

## Success criteria

- Golden position test passes against a fixture captured from the post-refactor
  solver, pinning all later work.
- Free-free links are bit-identical to the pre-refactor solver; pinned-link
  behaviour changes as documented in Section 1 and lowers constraint residual.
- Friction changes the circle and cloth scenes in the intended direction, under
  its own test rather than the golden one.
- Range constraints hold a joint within limits.
- All five bugs have a test that failed before the fix.
- Cloth holds 60fps at 20 iterations.
- `index.html` opens by double-click with no network access and no build step.

## Out of scope

- **Inter-body collision** (cloth vs. circles). Bodies never see each other
  today; this needs a world-level broadphase or bodies reaching into
  `world.bodies`, which alters the interface every body implements. It is
  architectural in its own right and needs its own cycle.
- **Phase 2 body types.** Ragdoll, Wheel, Spring, Bridge, Jelly, Pendulum are
  designed and built after this core lands.
- **Space-to-pause as a user feature.** `World.paused` is added for
  testability only. Binding it to a key is a Phase 2 candidate.
