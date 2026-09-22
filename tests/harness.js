"use strict";
// Development-only test harness. Drives index.html in headless Chromium.
// index.html itself has no dependencies; nothing here ships to the page.

const path = require("path");
const { chromium } = require("playwright-core");

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PAGE_URL = "file://" + path.resolve(__dirname, "..", "index.html");
const VIEWPORT = { width: 1100, height: 720 };

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  }
  return browser;
}

async function closeBrowser() {
  if (browser) { await browser.close(); browser = null; }
}

// Boot a page, hand it to fn, always tear down. Page errors become failures:
// a test that passes while the console is red is not a passing test.
async function withPage(fn, opts = {}) {
  const b = await getBrowser();
  const page = await b.newPage({ viewport: opts.viewport || VIEWPORT });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  try {
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => window.__world !== undefined);
    const result = await fn(page);
    if (errors.length) throw new Error("page reported errors:\n  " + errors.join("\n  "));
    return result;
  } finally {
    await page.close();
  }
}

// Freeze the render loop so the solver advances only when we say so.
// update() honours paused; step() does not, which is what makes this
// deterministic — real frame timing never enters the simulation.
async function freeze(page) {
  await page.evaluate(() => { window.__world.paused = true; });
}

async function step(page, n) {
  await page.evaluate(count => {
    for (let i = 0; i < count; i++) window.__world.step();
  }, n);
}

async function positions(page) {
  return page.evaluate(() => {
    const out = [];
    window.__world.eachParticle(p => { out.push(p.x, p.y); });
    return out;
  });
}

// Build a bare world holding exactly the particles and links a unit test
// needs, bypassing the scenes entirely.
async function scratchWorld(page, setup) {
  return page.evaluate(src => {
    const w = window.__world;
    w.paused = true;
    w.clear();
    // eslint-disable-next-line no-new-func
    const build = new Function("world", "ctx", src);
    return build(w, window.__ctx);
  }, setup);
}

class AssertionError extends Error {}

function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}

function assertClose(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new AssertionError(`${msg}: expected ${expected} ± ${tol}, got ${actual}`);
  }
}

function assertFinite(values, msg) {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new AssertionError(`${msg}: index ${i} is ${values[i]}`);
    }
  }
}

module.exports = {
  withPage, freeze, step, positions, scratchWorld,
  assert, assertClose, assertFinite, AssertionError,
  closeBrowser, VIEWPORT, PAGE_URL,
};
