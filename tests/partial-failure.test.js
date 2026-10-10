'use strict';

/**
 * Partial-failure behaviour: when some moves succeed and others fail, the tool
 * must report exactly what happened and never claim full success.
 * Everything below runs inside throw-away temp folders.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildPlan, applyPlan } = require('../src/organizer');
const { makeTempDir, writeFile, cleanup } = require('./helpers');

const yes = async () => true;

test('partial failure: category folder blocked by a file of the same name', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'a.jpg', 'img');
  writeFile(dir, 'b.txt', 'txt');
  // A plain FILE named "Images" prevents creating the Images folder.
  fs.writeFileSync(path.join(dir, 'Images'), 'i am a file, not a folder');

  const plan = buildPlan(dir);
  const result = await applyPlan(plan, { confirmFn: yes });

  assert.equal(result.counts.planned, 2);
  assert.equal(result.counts.moved, 1); // Documents succeeded
  assert.equal(result.counts.skipped, 1); // Images was blocked
  assert.ok(fs.existsSync(path.join(dir, 'Documents', 'b.txt')));
  assert.ok(result.skipped[0].reason.includes('cannot create folder'));
  // The blocking file is untouched
  assert.equal(fs.readFileSync(path.join(dir, 'Images'), 'utf8'), 'i am a file, not a folder');
});

test('partial failure: one vanished source does not stop the others', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'one.jpg', '1');
  writeFile(dir, 'two.jpg', '2');
  writeFile(dir, 'three.jpg', '3');

  const plan = buildPlan(dir);
  fs.unlinkSync(path.join(dir, 'two.jpg'));

  const result = await applyPlan(plan, { confirmFn: yes });

  assert.equal(result.counts.planned, 3);
  assert.equal(result.counts.moved, 2);
  assert.equal(result.counts.skipped, 1);
  assert.ok(fs.existsSync(path.join(dir, 'Images', 'one.jpg')));
  assert.ok(fs.existsSync(path.join(dir, 'Images', 'three.jpg')));

  // Manifest only records what really moved.
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.moves.length, 2);
  assert.equal(manifest.skipped.length, 1);
});

test('partial failure: result never claims success when something was skipped', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'one.jpg', '1');
  writeFile(dir, 'vanish.jpg', '2');

  const plan = buildPlan(dir);
  fs.unlinkSync(path.join(dir, 'vanish.jpg'));

  const result = await applyPlan(plan, { confirmFn: yes });

  assert.ok(result.counts.skipped > 0);
  assert.notEqual(result.counts.moved, result.counts.planned);
  assert.ok(result.skipped.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0));
});

test('partial failure: manifest written even when some moves failed', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'one.jpg', '1');
  writeFile(dir, 'vanish.jpg', '2');

  const plan = buildPlan(dir);
  fs.unlinkSync(path.join(dir, 'vanish.jpg'));

  const result = await applyPlan(plan, { confirmFn: yes });

  assert.ok(result.manifestPath, 'a manifest should still be written');
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.moves.length, 1);
  assert.ok(manifest.skipped[0].reason.length > 0);
});

test('safety: the whole src/ tree contains no delete/unlink call on user files except the verified copy fallback', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const files = fs.readdirSync(srcDir).filter((name) => name.endsWith('.js'));
  const offenders = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(srcDir, name), 'utf8');
    // rmSync / unlinkSync are only allowed in organizer.js (verified copy
    // fallback + temp-file cleanup), reports.js (temp cleanup) and utils.js
    // (the shared removeOwnTempFile helper those two call).
    if (/\b(rmSync|unlinkSync)\b/.test(text) && !['organizer.js', 'reports.js', 'utils.js'].includes(name)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], 'no module outside the approved ones may delete files');
});

/** The body of one named top-level function in a source file. */
function functionBody(text, name) {
  const start = text.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `expected to find "function ${name}"`);
  const next = text.indexOf('\nfunction ', start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

const countMatches = (text, pattern) => (text.match(pattern) || []).length;

test('safety: utils.js only deletes a file it positively identified as its own', () => {
  const utilsPath = path.join(__dirname, '..', 'src', 'utils.js');
  const text = fs.readFileSync(utilsPath, 'utf8');

  const tempBody = functionBody(text, 'removeOwnTempFile');
  const placeholderBody = functionBody(text, 'removeOwnPlaceholder');
  const placeBody = functionBody(text, 'placeFileNoOverwrite');

  // Exactly two deletions exist in the whole file, one per guarded helper.
  const unlinkPattern = /\bunlinkSync\b/g;
  assert.equal(countMatches(text, unlinkPattern), 2, 'utils.js must contain exactly two deletions');
  assert.equal(countMatches(tempBody, unlinkPattern), 1, 'removeOwnTempFile owns one');
  assert.equal(countMatches(placeholderBody, unlinkPattern), 1, 'removeOwnPlaceholder owns one');
  assert.equal(
    countMatches(placeBody, unlinkPattern),
    0,
    'placement must clean up only through the guarded helpers, never directly'
  );

  // ... and each helper must prove ownership before it removes anything.
  assert.ok(tempBody.includes("name.startsWith('.')"), 'temp file name shape must be checked');
  assert.ok(tempBody.includes("name.endsWith('.tmp')"), 'temp file name shape must be checked');
  assert.ok(tempBody.includes('isFile() && !stat.isSymbolicLink()'), 'links and directories must never be removed');
  assert.ok(placeholderBody.includes('isFile() && !stat.isSymbolicLink()'), 'links and directories must never be removed');
  assert.ok(placeholderBody.includes('stat.size === 0'), 'only an untouched reservation may be removed');
});

test('safety: organizer.js only unlinks the source being moved or a destination it created', () => {
  const organizerPath = path.join(__dirname, '..', 'src', 'organizer.js');
  const text = fs.readFileSync(organizerPath, 'utf8');

  // Two source removals (the link path and the verified copy path) plus one
  // rollback of a destination this call just created. Nothing else in the
  // project may name a file to be deleted.
  const targets = [...text.matchAll(/\bfs\.unlinkSync\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    targets,
    ['destination', 'from', 'from'],
    'organizer.js may only unlink the moved source or its own rollback destination'
  );

  // The rollback helper must prove the destination is a plain file first.
  const rollbackBody = functionBody(text, 'removeOwnDestination');
  assert.ok(
    rollbackBody.includes('stat.isFile() && !stat.isSymbolicLink()'),
    'a rollback must never remove a directory or a link'
  );
});
