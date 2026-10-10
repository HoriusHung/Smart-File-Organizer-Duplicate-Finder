'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildPlan, applyPlan, undoManifest, readManifest, MANIFEST_DIR } = require('../src/organizer');
const { makeTempDir, writeFile, snapshot, cleanup } = require('./helpers');

const yes = async () => true;

/** Snapshot ignoring the manifest folder (manifests are records, not data). */
function dataSnapshot(dir) {
  const map = snapshot(dir);
  for (const key of [...map.keys()]) {
    if (key.includes(`${MANIFEST_DIR}${path.sep}`)) map.delete(key);
  }
  return map;
}

/** Organize a folder and return { dir, manifestPath, original } in one step. */
async function organizeFixture(t, files) {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  for (const [name, content] of Object.entries(files)) writeFile(dir, name, content);
  const original = snapshot(dir);
  const result = await applyPlan(buildPlan(dir), { confirmFn: yes });
  assert.ok(result.manifestPath, 'fixture should have produced a manifest');
  return { dir, manifestPath: result.manifestPath, original, applyResult: result };
}

test('undo: restores the original layout exactly', async (t) => {
  const { dir, manifestPath, original } = await organizeFixture(t, {
    'photo.jpg': 'img-bytes',
    'docs/readme.txt': 'readme',
    'clip.mp4': 'video',
  });

  // sanity: files were moved
  assert.ok(fs.existsSync(path.join(dir, 'Images', 'photo.jpg')));

  const result = await undoManifest(manifestPath, { confirmFn: yes });

  assert.equal(result.cancelled, false);
  assert.equal(result.counts.restored, 3);
  assert.equal(result.counts.skipped, 0);

  const after = dataSnapshot(dir);
  assert.deepEqual([...after.keys()].sort(), [...original.keys()].sort());
  for (const [file, content] of original) assert.equal(after.get(file), content);
});

test('undo: refuses without a confirmation function', async (t) => {
  const { manifestPath } = await organizeFixture(t, { 'a.jpg': 'img' });
  await assert.rejects(() => undoManifest(manifestPath), /confirmation function/);
});

test('undo: confirmation returning false restores nothing', async (t) => {
  const { dir, manifestPath } = await organizeFixture(t, { 'a.jpg': 'img' });
  const before = snapshot(dir);

  const result = await undoManifest(manifestPath, { confirmFn: async () => false });

  assert.equal(result.cancelled, true);
  assert.equal(result.counts.restored, 0);
  assert.deepEqual(snapshot(dir), before);
});

test('undo: missing destination file is skipped with a reason', async (t) => {
  const { dir, manifestPath } = await organizeFixture(t, { 'a.jpg': 'img', 'b.txt': 'txt' });

  fs.unlinkSync(path.join(dir, 'Images', 'a.jpg'));

  const result = await undoManifest(manifestPath, { confirmFn: yes });

  assert.equal(result.counts.restored, 1);
  assert.equal(result.counts.skipped, 1);
  assert.ok(result.skipped[0].reason.includes('missing'));
  // the other file still came back
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
});

test('undo: occupied original location is skipped, existing file untouched', async (t) => {
  const { dir, manifestPath } = await organizeFixture(t, { 'a.jpg': 'img-bytes' });

  // Someone recreated a file at the original path.
  writeFile(dir, 'a.jpg', 'PRECIOUS');

  const result = await undoManifest(manifestPath, { confirmFn: yes });

  assert.equal(result.counts.restored, 0);
  assert.equal(result.counts.skipped, 1);
  assert.ok(result.skipped[0].reason.includes('occupied'));
  assert.equal(fs.readFileSync(path.join(dir, 'a.jpg'), 'utf8'), 'PRECIOUS');
});

test('undo: file modified after the move is not restored', async (t) => {
  const { dir, manifestPath } = await organizeFixture(t, { 'a.jpg': 'original-bytes' });

  // Tamper with the moved file.
  fs.writeFileSync(path.join(dir, 'Images', 'a.jpg'), 'TAMPERED');

  const result = await undoManifest(manifestPath, { confirmFn: yes });

  assert.equal(result.counts.restored, 0);
  assert.equal(result.counts.skipped, 1);
  assert.ok(result.skipped[0].reason.includes('content changed'));
  assert.equal(fs.readFileSync(path.join(dir, 'Images', 'a.jpg'), 'utf8'), 'TAMPERED');
});

test('undo: dry-run style (cancelled) after partial restore behaves safely on re-run', async (t) => {
  const { dir, manifestPath } = await organizeFixture(t, { 'a.jpg': 'img', 'b.txt': 'txt' });

  const first = await undoManifest(manifestPath, { confirmFn: yes });
  assert.equal(first.counts.restored, 2);

  // Running undo again: nothing to restore, everything skipped safely.
  const second = await undoManifest(manifestPath, { confirmFn: yes });
  assert.equal(second.counts.restored, 0);
  assert.equal(second.counts.skipped, 2);
  assert.ok(fs.existsSync(path.join(dir, 'a.jpg')));
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
});

test('undo: tampered manifest (bad version) is rejected', async (t) => {
  const { manifestPath } = await organizeFixture(t, { 'a.jpg': 'img' });

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = 999;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  assert.throws(
    () => readManifest(manifestPath),
    (error) => error.code === 'EBADMANIFEST'
  );
});

test('undo: manifest with missing fields is rejected', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, JSON.stringify({ version: 1 }));

  assert.throws(
    () => readManifest(broken),
    (error) => error.code === 'EBADMANIFEST'
  );
});

test('undo: invalid JSON manifest is rejected', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, 'not json at all {');

  assert.throws(
    () => readManifest(broken),
    (error) => error.code === 'EBADMANIFEST'
  );
});

test('undo: missing manifest file is rejected', () => {
  const missing = path.join(makeTempDir('sfo-no-manifest-'), 'nope.json');
  assert.throws(
    () => readManifest(missing),
    (error) => error.code === 'EBADMANIFEST'
  );
});

test('undo: partial restore continues after a failure', async (t) => {
  const { dir, manifestPath } = await organizeFixture(t, {
    'a.jpg': 'img',
    'b.txt': 'txt',
    'c.mp3': 'audio',
  });

  // Block one of the three restorations.
  fs.unlinkSync(path.join(dir, 'Documents', 'b.txt'));

  const result = await undoManifest(manifestPath, { confirmFn: yes });

  assert.equal(result.counts.restored, 2);
  assert.equal(result.counts.skipped, 1);
  assert.ok(fs.existsSync(path.join(dir, 'a.jpg')));
  assert.ok(fs.existsSync(path.join(dir, 'c.mp3')));
});
