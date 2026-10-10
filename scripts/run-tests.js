'use strict';

/**
 * Test launcher.
 *
 * Why this file exists:
 *   - `node --test tests` (a directory) fails on checkout paths that contain
 *     spaces or non-ASCII characters (for example "Gia Hưng").
 *   - Passing an explicit glob such as `node --test "tests/*.test.js"` works,
 *     but relies on shell/glob handling that varies between platforms and
 *     shells.
 *
 * Passing EXPLICIT file paths to `node --test` avoids both problems, so we
 * list the test files ourselves and hand them over one by one. The project
 * requires Node.js >= 22 (see package.json "engines").
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testsDir = path.join(__dirname, '..', 'tests');

let entries;
try {
  entries = fs.readdirSync(testsDir, { withFileTypes: true });
} catch (error) {
  process.stderr.write(`Cannot read the tests folder: ${testsDir}\n${error.message}\n`);
  process.exit(1);
}

// Sorted for a stable, reproducible test order.
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => path.join(testsDir, entry.name))
  .sort();

if (testFiles.length === 0) {
  process.stderr.write(`No test files (*.test.js) found in ${testsDir}\n`);
  process.exit(1);
}

// Each path is passed as its own argument: no shell, no globbing, so paths with
// spaces or non-ASCII characters are handled correctly.
const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });

if (result.error) {
  process.stderr.write(`Failed to start the test runner: ${result.error.message}\n`);
  process.exit(1);
}

// status is null when the child was terminated by a signal.
process.exit(result.status === null ? 1 : result.status);
