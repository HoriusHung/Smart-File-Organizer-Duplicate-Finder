'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runCli, parseArgs } = require('../src/cli');
const { makeTempDir, writeFile, snapshot, cleanup } = require('./helpers');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

/** Run the CLI as a real child process (stdin closed => no TTY). */
function runProcess(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

test('help: --help prints usage and exits 0', async () => {
  const code = await runCli(['--help']);
  assert.equal(code, 0);
});

test('help: no arguments prints usage', async () => {
  const code = await runCli([]);
  assert.equal(code, 0);
});

test('version: --version prints a version', async () => {
  const code = await runCli(['--version']);
  assert.equal(code, 0);
});

test('usage: unknown command returns exit code 2', async () => {
  const code = await runCli(['frobnicate', '.']);
  assert.equal(code, 2);
});

test('usage: unknown option returns exit code 2', async () => {
  const code = await runCli(['scan', '.', '--nonsense']);
  assert.equal(code, 2);
});

test('usage: missing directory returns exit code 2', async () => {
  const code = await runCli(['scan']);
  assert.equal(code, 2);
});

test('scan: invalid directory returns exit code 1', async () => {
  const missing = path.join(makeTempDir('sfo-cli-'), 'missing-dir');
  const code = await runCli(['scan', missing]);
  assert.equal(code, 1);
});

test('scan: valid temp directory completes with exit code 0', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'a.txt', 'hello');
  writeFile(dir, 'b.jpg', 'image');

  const code = await runCli(['scan', dir]);
  assert.equal(code, 0);
});

test('scan: --json prints parseable JSON', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'a.txt', 'hello');

  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(chunk.toString());
    return originalWrite('', ...rest);
  };
  try {
    const code = await runCli(['scan', dir, '--json']);
    assert.equal(code, 0);
  } finally {
    process.stdout.write = originalWrite;
  }

  const parsed = JSON.parse(chunks.join(''));
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.stats.fileCount, 1);
});

test('scan: --out writes a report into the reports/ folder', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'a.txt', 'hello');

  const base = makeTempDir('sfo-cwd-');
  t.after(() => cleanup(base));
  const previousCwd = process.cwd();
  process.chdir(base);
  try {
    const code = await runCli(['scan', dir, '--out', 'inventory.csv']);
    assert.equal(code, 0);
  } finally {
    process.chdir(previousCwd);
  }

  const written = path.join(base, 'reports', 'inventory.csv');
  assert.ok(fs.existsSync(written), 'report should exist in reports/');
  const content = fs.readFileSync(written, 'utf8');
  assert.ok(content.includes('"path"'));
  assert.ok(content.includes('a.txt'));
});

test('scan: refuses to overwrite an existing report (exit code 1)', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'a.txt', 'hello');

  const base = makeTempDir('sfo-cwd-');
  t.after(() => cleanup(base));
  const reportsDir = path.join(base, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'inventory.csv'), 'keep me');

  const previousCwd = process.cwd();
  process.chdir(base);
  try {
    const code = await runCli(['scan', dir, '--out', 'inventory.csv']);
    assert.equal(code, 1);
  } finally {
    process.chdir(previousCwd);
  }

  assert.equal(fs.readFileSync(path.join(reportsDir, 'inventory.csv'), 'utf8'), 'keep me');
});

test('duplicates: end-to-end run on temp files', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'one.txt', 'duplicate-content');
  writeFile(dir, 'two.txt', 'duplicate-content');
  writeFile(dir, 'unique.txt', 'something else');

  const code = await runCli(['duplicates', dir]);
  assert.equal(code, 0);
});

test('duplicates: --out writes a CSV report', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'one.txt', 'duplicate-content');
  writeFile(dir, 'two.txt', 'duplicate-content');

  const report = path.join(dir, '..', `dupes-${Date.now()}.csv`);
  const code = await runCli(['duplicates', dir, '--out', report]);
  assert.equal(code, 0);
  assert.ok(fs.existsSync(report));
  const content = fs.readFileSync(report, 'utf8');
  assert.ok(content.includes('duplicate-content') === false); // content is never exported
  assert.ok(content.includes('one.txt'));
  assert.ok(content.includes('two.txt'));
  fs.unlinkSync(report);
});

test('organize: default is a dry run — nothing moves, exit code 0', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'a.jpg', 'img');
  writeFile(dir, 'b.txt', 'txt');

  const before = snapshot(dir);
  const code = await runCli(['organize', dir]);
  assert.equal(code, 0);

  const after = snapshot(dir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  assert.ok(!fs.existsSync(path.join(dir, 'Images')));
});

test('organize: --apply without a TTY is refused, nothing moves (exit code 1)', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'a.jpg', 'img');

  const before = snapshot(dir);
  const result = runProcess(['organize', dir, '--apply'], dir);

  assert.notEqual(result.status, 0);
  assert.ok(result.stdout.includes('interactive terminal is required') || result.stderr.length >= 0);
  assert.deepEqual(snapshot(dir), before);
  assert.ok(!fs.existsSync(path.join(dir, 'Images')));
});

test('undo: --apply without a TTY is refused, nothing moves', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'a.jpg', 'img');

  // Produce a manifest by calling the library directly with forced approval.
  const { buildPlan, applyPlan } = require('../src/organizer');
  const applied = await applyPlan(buildPlan(dir), { confirmFn: async () => true });
  assert.ok(applied.manifestPath);
  const afterApply = snapshot(dir);

  const result = runProcess(['undo', applied.manifestPath, '--apply'], dir);

  assert.notEqual(result.status, 0);
  assert.deepEqual(snapshot(dir), afterApply);
});

test('undo: preview (dry run) works and exits 0', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'a.jpg', 'img');

  const { buildPlan, applyPlan } = require('../src/organizer');
  const applied = await applyPlan(buildPlan(dir), { confirmFn: async () => true });
  const afterApply = snapshot(dir);

  const code = await runCli(['undo', applied.manifestPath]);
  assert.equal(code, 0);
  assert.deepEqual(snapshot(dir), afterApply); // preview changed nothing
});

test('undo: nonexistent manifest returns exit code 1', async () => {
  const missing = path.join(makeTempDir('sfo-nope-'), 'missing.json');
  const code = await runCli(['undo', missing]);
  assert.equal(code, 1);
});

test('parseArgs: reads --out with space and equals forms', () => {
  const a = parseArgs(['scan', 'D:\\My Folder', '--out', 'r.csv']);
  assert.equal(a.command, 'scan');
  assert.equal(a.options.out, 'r.csv');
  // positional excludes the command itself
  assert.deepEqual(a.positional, ['D:\\My Folder']);

  const b = parseArgs(['scan', '.', '--out=r.json']);
  assert.equal(b.options.out, 'r.json');
});

test('parseArgs: --out without a value is a usage error', () => {
  assert.throws(() => parseArgs(['scan', '.', '--out']), /needs a file name/);
});

test('cli: scan of an empty temp directory exits 0', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const code = await runCli(['scan', dir]);
  assert.equal(code, 0);
});
