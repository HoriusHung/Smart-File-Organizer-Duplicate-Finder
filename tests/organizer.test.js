'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildPlan, applyPlan, uniqueDestination, MANIFEST_DIR } = require('../src/organizer');
const { makeTempDir, writeFile, listFiles, snapshot, cleanup } = require('./helpers');

const yes = async () => true;
const no = async () => false;

test('plan: files are grouped by category with destinations inside the root', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'a.jpg', 'img');
  writeFile(dir, 'report.pdf', 'pdf');
  writeFile(dir, 'song.mp3', 'mp3');
  writeFile(dir, 'mystery.xyz', '???');

  const plan = buildPlan(dir);

  assert.equal(plan.moves.length, 4);
  const destinations = plan.moves.map((m) => m.to);
  assert.ok(destinations.includes(path.join(dir, 'Images', 'a.jpg')));
  assert.ok(destinations.includes(path.join(dir, 'Documents', 'report.pdf')));
  assert.ok(destinations.includes(path.join(dir, 'Audio', 'song.mp3')));
  assert.ok(destinations.includes(path.join(dir, 'Other', 'mystery.xyz')));
});

test('plan: dry-run (buildPlan only) changes absolutely nothing', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'a.jpg', 'img');
  writeFile(dir, 'docs/b.txt', 'text');

  const before = snapshot(dir);
  buildPlan(dir);
  const after = snapshot(dir);

  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, content] of before) assert.equal(after.get(file), content);
});

test('plan: hidden files and category folders are excluded', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'visible.jpg', 'img');
  writeFile(dir, '.hidden.jpg', 'img');
  writeFile(dir, 'Images/already-there.jpg', 'img');

  const plan = buildPlan(dir);

  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].from, path.join(dir, 'visible.jpg'));
  assert.ok(plan.skipped.some((s) => s.reason.includes('hidden')));
  assert.ok(plan.skipped.some((s) => s.reason.includes('already inside category folder')));
});

test('plan: invalid path throws EINVALIDPATH', () => {
  const missing = path.join(makeTempDir('sfo-missing-'), 'nope');
  assert.throws(
    () => buildPlan(missing),
    (error) => error.code === 'EINVALIDPATH'
  );
});

test('conflicts: uniqueDestination never returns an existing path', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'photo.jpg', 'first');
  const reserved = new Set();

  const first = uniqueDestination(dir, 'photo.jpg', reserved);
  assert.equal(path.basename(first), 'photo (2).jpg');

  reserved.add(first.toLowerCase());
  const second = uniqueDestination(dir, 'photo.jpg', reserved);
  assert.equal(path.basename(second), 'photo (3).jpg');
});

test('conflicts: two sources with the same name both get unique destinations', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'one/clip.mp4', 'a');
  writeFile(dir, 'two/clip.mp4', 'b');

  const plan = buildPlan(dir);

  assert.equal(plan.moves.length, 2);
  const destinations = plan.moves.map((m) => m.to.toLowerCase());
  assert.equal(new Set(destinations).size, 2);
  const renamed = plan.moves.filter((m) => m.renamed);
  assert.equal(renamed.length, 1);
  assert.ok(path.basename(renamed[0].to).startsWith('clip (2)'));
});

test('conflicts: existing destination file is never overwritten during apply', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'src/clip.mp4', 'new-content');
  // A file already exists where the move would land.
  fs.mkdirSync(path.join(dir, 'Videos'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Videos', 'clip.mp4'), 'PRECIOUS-EXISTING-FILE');

  const plan = buildPlan(dir);
  const result = await applyPlan(plan, { confirmFn: yes });

  assert.equal(result.counts.moved, 1);
  const movedTo = result.moved[0].to;
  assert.notEqual(path.basename(movedTo), 'clip.mp4');
  // original file untouched
  assert.equal(fs.readFileSync(path.join(dir, 'Videos', 'clip.mp4'), 'utf8'), 'PRECIOUS-EXISTING-FILE');
  // new file landed under a numbered name
  assert.equal(fs.readFileSync(movedTo, 'utf8'), 'new-content');
});

test('apply: refuses to run without a confirmation function', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'a.jpg', 'img');

  const plan = buildPlan(dir);
  await assert.rejects(() => applyPlan(plan), /confirmation function/);
});

test('apply: confirmation returning false cancels and moves nothing', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFile(dir, 'a.jpg', 'img');

  const before = snapshot(dir);
  const plan = buildPlan(dir);
  const result = await applyPlan(plan, { confirmFn: no });

  assert.equal(result.cancelled, true);
  assert.equal(result.counts.moved, 0);
  assert.deepEqual(snapshot(dir), before);
});

test('apply: with YES it moves every file and writes a manifest', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'a.jpg', 'image-bytes');
  writeFile(dir, 'notes/todo.txt', 'todo');

  const plan = buildPlan(dir);
  const result = await applyPlan(plan, { confirmFn: yes });

  assert.equal(result.cancelled, false);
  assert.equal(result.counts.moved, 2);
  assert.equal(result.counts.skipped, 0);

  assert.ok(fs.existsSync(path.join(dir, 'Images', 'a.jpg')));
  assert.ok(fs.existsSync(path.join(dir, 'Documents', 'todo.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'a.jpg')));

  assert.ok(result.manifestPath);
  assert.ok(result.manifestPath.startsWith(path.join(dir, MANIFEST_DIR)));

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.moves.length, 2);
  assert.ok(manifest.moves[0].sha256); // hash recorded for undo verification
  assert.equal(manifest.root, path.resolve(dir));
});

test('apply: unicode filenames move correctly', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'bản báo cáo – 2026.docx', 'nội dung');
  const plan = buildPlan(dir);
  const result = await applyPlan(plan, { confirmFn: yes });

  assert.equal(result.counts.moved, 1);
  assert.ok(fs.existsSync(path.join(dir, 'Documents', 'bản báo cáo – 2026.docx')));
});

test('apply: source that vanished between plan and apply is skipped', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'stays.jpg', 'keep');
  const vanishing = writeFile(dir, 'vanishes.jpg', 'gone');

  const plan = buildPlan(dir);
  fs.unlinkSync(vanishing);

  const result = await applyPlan(plan, { confirmFn: yes });

  assert.equal(result.counts.moved, 1);
  assert.equal(result.counts.skipped, 1);
  assert.ok(result.skipped[0].reason.includes('source unavailable'));
  assert.ok(fs.existsSync(path.join(dir, 'Images', 'stays.jpg')));
});

test('apply: re-running organize skips files already organized', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'a.jpg', 'img');
  await applyPlan(buildPlan(dir), { confirmFn: yes });

  const secondPlan = buildPlan(dir);
  assert.equal(secondPlan.moves.length, 0);
  assert.ok(secondPlan.skipped.some((s) => s.reason.includes('already inside category folder')));
});

test('listFiles helper detects changes made by a move', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'x.txt', 'x');
  assert.equal(listFiles(dir).length, 1);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.renameSync(path.join(dir, 'x.txt'), path.join(dir, 'sub', 'x.txt'));
  assert.equal(listFiles(dir).length, 1);
  assert.ok(listFiles(dir)[0].includes('sub'));
});
