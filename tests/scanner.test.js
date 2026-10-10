'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scanDirectory, categorize } = require('../src/scanner');
const { makeTempDir, writeFile, cleanup } = require('./helpers');

test('scan: normal nested files with correct sizes and totals', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'a.txt', 'hello');
  writeFile(dir, 'nested/b.jpg', '0123456789');
  writeFile(dir, 'nested/deep/c.mp3', 'music-bytes');

  const result = scanDirectory(dir);

  assert.equal(result.files.length, 3);
  assert.equal(result.stats.fileCount, 3);
  assert.equal(result.stats.totalSize, 5 + 10 + 11);
  assert.equal(result.stats.dirCount, 3); // root + nested + deep

  const a = result.files.find((f) => f.name === 'a.txt');
  assert.equal(a.size, 5);
  assert.equal(a.category, 'Documents');

  const b = result.files.find((f) => f.name === 'b.jpg');
  assert.equal(b.category, 'Images');

  const c = result.files.find((f) => f.name === 'c.mp3');
  assert.equal(c.category, 'Audio');

  assert.equal(result.stats.byCategory.Images.count, 1);
  assert.equal(result.stats.byCategory.Documents.size, 5);
  assert.equal(result.stats.byExtension['.txt'].count, 1);
});

test('scan: empty directory reports zero counts without throwing', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  const result = scanDirectory(dir);
  assert.equal(result.files.length, 0);
  assert.equal(result.stats.fileCount, 0);
  assert.equal(result.stats.totalSize, 0);
  assert.deepEqual(result.skipped, []);
});

test('scan: nonexistent path throws EINVALIDPATH, does not crash', () => {
  const missing = path.join(makeTempDir('sfo-missing-'), 'does-not-exist');
  assert.throws(
    () => scanDirectory(missing),
    (error) => error.code === 'EINVALIDPATH'
  );
});

test('scan: a file passed instead of a directory throws EINVALIDPATH', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = writeFile(dir, 'plain.txt', 'x');

  assert.throws(
    () => scanDirectory(file),
    (error) => error.code === 'EINVALIDPATH'
  );
});

test('scan: unicode filenames are counted and categorised', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'héllo – ảnh 新版.txt', 'niềm vui');
  writeFile(dir, 'emoji-😀.png', 'png');

  const result = scanDirectory(dir);
  assert.equal(result.files.length, 2);
  const names = result.files.map((f) => f.name);
  assert.ok(names.includes('héllo – ảnh 新版.txt'));
  assert.ok(names.includes('emoji-😀.png'));
});

test('scan: path with spaces works', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'my folder name/file with spaces.txt', 'data');
  const result = scanDirectory(dir);
  assert.equal(result.files.length, 1);
  assert.ok(result.files[0].path.includes('my folder name'));
});

test('scan: --no-recursive stops at the top level', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'top.txt', 'top');
  writeFile(dir, 'inner/deep.txt', 'deep');

  const result = scanDirectory(dir, { recursive: false });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'top.txt');
});

test('scan: hidden files are skipped by default, included with the flag', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'visible.txt', 'v');
  writeFile(dir, '.secret.txt', 's');

  const withoutHidden = scanDirectory(dir);
  assert.equal(withoutHidden.files.length, 1);
  assert.ok(withoutHidden.skipped.some((entry) => entry.reason.includes('hidden')));

  const withHidden = scanDirectory(dir, { includeHidden: true });
  assert.equal(withHidden.files.length, 2);
});

test('scan: symlink is reported and never followed', { skip: process.platform === 'win32' && 'symlink creation needs privileges on Windows' }, (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  writeFile(dir, 'real/inside.txt', 'inside');
  try {
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'dir');
  } catch (_) {
    return; // privileges unavailable — test safely skips
  }

  const result = scanDirectory(dir);
  assert.equal(result.files.length, 1); // only the real file
  assert.ok(result.skipped.some((entry) => entry.reason.includes('symbolic link')));
});

test('scan: unreadable file is reported, not a crash', { skip: process.platform === 'win32' && 'chmod cannot block reads on Windows' }, (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  const locked = writeFile(dir, 'locked.txt', 'secret');
  const readable = writeFile(dir, 'ok.txt', 'fine');
  fs.chmodSync(locked, 0o000);

  const result = scanDirectory(dir);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, readable);
  assert.ok(result.skipped.some((entry) => entry.path === locked));
});

test('categorize: mapping rules including case-insensitive and fallback', () => {
  assert.equal(categorize('.JPG'), 'Images');
  assert.equal(categorize('.PnG'), 'Images');
  assert.equal(categorize('.pdf'), 'Documents');
  assert.equal(categorize('.mkv'), 'Videos');
  assert.equal(categorize('.flac'), 'Audio');
  assert.equal(categorize('.7z'), 'Archives');
  assert.equal(categorize('.exe'), 'Other');
  assert.equal(categorize(''), 'Other');
  assert.equal(categorize(null), 'Other');
});
