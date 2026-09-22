"use strict";
// Minimal test runner. No framework: the repo ships no runtime dependencies
// and the harness should not drag in a heavy one either.

const { closeBrowser } = require("./harness");

const suite = [];
function test(name, fn) { suite.push({ name, fn }); }
global.test = test;

require("./engine.test.js");

(async () => {
  let passed = 0;
  const failures = [];

  for (const t of suite) {
    const started = Date.now();
    try {
      await t.fn();
      passed++;
      console.log(`  \x1b[32mPASS\x1b[0m ${t.name} (${Date.now() - started}ms)`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`  \x1b[31mFAIL\x1b[0m ${t.name}`);
      console.log(`       ${err.message.split("\n").join("\n       ")}`);
    }
  }

  await closeBrowser();

  console.log(`\n${passed}/${suite.length} passed`);
  if (failures.length) {
    console.log(`\x1b[31m${failures.length} failing:\x1b[0m`);
    for (const f of failures) console.log(`  - ${f.name}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(err => {
  console.error("runner crashed:", err);
  process.exit(1);
});
