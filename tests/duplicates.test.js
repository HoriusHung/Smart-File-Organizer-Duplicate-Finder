'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { findDuplicates } = require('../src/duplicates');
const { sha256File } = require('../src/utils');
const { makeTempDir, writeFile, cleanup } = require('./helpers');

test('duplicates: identical content with different names is one group', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'photo.jpg', 'same-image-bytes');
  writeFile(dir, 'copy of photo.jpg', 'same-image-bytes');
  writeFile(dir, 'other.png', 'different');

  const result = await findDuplicates(dir);

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].paths.length, 2);
  assert.equal(result.groups[0].size, 16);
  assert.equal(result.stats.groupCount, 1);
  assert.equal(result.stats.reclaimableBytes, 16);
});

test('duplicates: same size but different content is NOT grouped', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'a.bin', 'AAAA');
  writeFile(dir, 'b.bin', 'BBBB');
  writeFile(dir, 'c.bin', 'CCCC');

  const result = await findDuplicates(dir);

  assert.equal(result.groups.length, 0);
  assert.equal(result.stats.reclaimableBytes, 0);
});

test('duplicates: three files, two identical -> group of two, correct reclaimable space', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'one.dat', 'payload');
  writeFile(dir, 'two.dat', 'payload');
  writeFile(dir, 'three.dat', 'payload-other');

  const result = await findDuplicates(dir);

  assert.equal(result.groups.length, 1);
  assert.equal(result.stats.duplicateFileCount, 2);
  assert.equal(result.stats.reclaimableBytes, 7); // keep one, reclaim one
});

test('duplicates: three identical files -> reclaimable is size x 2', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'x1.txt', 'triple');
  writeFile(dir, 'x2.txt', 'triple');
  writeFile(dir, 'x3.txt', 'triple');

  const result = await findDuplicates(dir);

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].paths.length, 3);
  assert.equal(result.stats.reclaimableBytes, 12); // 6 bytes x 2 extra copies
});

test('duplicates: unicode filenames in groups', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'bản ghi – original.mp3', 'audio-bytes');
  writeFile(dir, 'bản ghi – copy.mp3', 'audio-bytes');

  const result = await findDuplicates(dir);

  assert.equal(result.groups.length, 1);
  assert.ok(result.groups[0].paths.some((p) => p.includes('original')));
  assert.ok(result.groups[0].paths.some((p) => p.includes('copy')));
});

test('duplicates: no duplicates -> empty result, not an error', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'only.txt', 'unique-content');

  const result = await findDuplicates(dir);
  assert.deepEqual(result.groups, []);
  assert.equal(result.stats.candidateFiles, 0);
});

test('duplicates: empty files are never reported as duplicates', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'e1.txt', '');
  writeFile(dir, 'e2.txt', '');

  const result = await findDuplicates(dir);
  assert.equal(result.groups.length, 0);
});

test('duplicates: hash values really are SHA-256 of the content', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'h1.txt', 'hash me');
  writeFile(dir, 'h2.txt', 'hash me');

  const result = await findDuplicates(dir);
  const expected = await sha256File(path.join(dir, 'h1.txt'));
  assert.equal(result.groups[0].hash, expected);
  assert.equal(result.groups[0].hashShort, expected.slice(0, 12));
});

test('duplicates: nested folders are included', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'a/same.dat', 'nested-duplicate');
  writeFile(dir, 'b/deep/same.dat', 'nested-duplicate');

  const result = await findDuplicates(dir);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].paths.length, 2);
});
