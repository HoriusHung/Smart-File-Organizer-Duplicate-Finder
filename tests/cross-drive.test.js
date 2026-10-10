'use strict';

/**
 * Cross-drive (EXDEV) move fallback.
 *
 * rename() only works within one drive. When the source and destination are on
 * different drives, moveFileSafely() hashes the source, copies into a private
 * temp file, hashes the copy AND re-hashes the source, and only removes the
 * source when both hashes match. These tests force that branch by making
 * rename() report EXDEV, and verify the safety rules around it. Everything
 * runs in temp folders.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { moveFileSafely } = require('../src/organizer');
const { sha256File } = require('../src/utils');
const { makeTempDir, writeFile, cleanup } = require('./helpers');

/**
 * Force the cross-drive (EXDEV) branch for the duration of one test.
 *
 * moveFileSafely() tries a hard link first and falls back to rename(); both
 * have to look like "different volumes" for these tests. Our OWN temp files —
 * the shape makeTempPath() produces, dot-prefixed and ending in ".tmp" — are
 * deliberately excluded: placing a verified copy at its destination is a
 * same-directory operation that these tests must still be able to perform.
 */
function forceCrossDrive(t) {
  const isOwnTemp = (source) => {
    const name = path.basename(source);
    return name.startsWith('.') && name.endsWith('.tmp');
  };
  const exdev = (action) => {
    const error = new Error(`EXDEV: cross-device link not permitted, ${action}`);
    error.code = 'EXDEV';
    return error;
  };

  const originalLink = fs.linkSync;
  const originalRename = fs.renameSync;
  fs.linkSync = (source, destination) => {
    if (isOwnTemp(source)) return originalLink(source, destination);
    throw exdev(`link '${source}' -> '${destination}'`);
  };
  fs.renameSync = (source, destination) => {
    if (isOwnTemp(source)) return originalRename(source, destination);
    throw exdev(`rename '${source}' -> '${destination}'`);
  };
  t.after(() => {
    fs.linkSync = originalLink;
    fs.renameSync = originalRename;
  });
}

/** Temp leftovers in a folder (our temp files are dot-files ending in .tmp). */
function tempLeftovers(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

test('cross-drive: successful copy is verified by SHA-256 before the source is removed', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  forceCrossDrive(t);

  const content = 'image-content-1234567890';
  const from = writeFile(dir, 'photo.jpg', content);
  const to = path.join(dir, 'moved.jpg');

  const result = await moveFileSafely(from, to);

  assert.equal(result.via, 'copy');
  assert.ok(!fs.existsSync(from), 'source must be removed after a verified copy');
  assert.equal(fs.readFileSync(to, 'utf8'), content);

  // The destination content really is byte-for-byte identical to the source:
  // its SHA-256 equals the hash of the content we started with.
  const copiedHash = await sha256File(to);
  const expectedHash = require('node:crypto').createHash('sha256').update(content).digest('hex');
  assert.equal(copiedHash, expectedHash);
});

test('cross-drive: unicode filename survives the fallback', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  forceCrossDrive(t);

  const from = writeFile(dir, 'bản báo cáo – 新版.txt', 'nội dung tiếng Việt');
  const to = path.join(dir, 'Documents', 'bản báo cáo – 新版.txt');
  fs.mkdirSync(path.dirname(to), { recursive: true });

  await moveFileSafely(from, to);

  assert.ok(!fs.existsSync(from));
  assert.equal(fs.readFileSync(to, 'utf8'), 'nội dung tiếng Việt');
});

test('cross-drive: a destination that already exists is never overwritten', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  forceCrossDrive(t);

  const from = writeFile(dir, 'source.txt', 'NEW CONTENT');
  const to = writeFile(dir, 'destination.txt', 'PRECIOUS EXISTING CONTENT');

  await assert.rejects(() => moveFileSafely(from, to), (error) => error.code === 'EEXIST');

  // The pre-existing file is untouched and the source is still there.
  assert.equal(fs.readFileSync(to, 'utf8'), 'PRECIOUS EXISTING CONTENT');
  assert.equal(fs.readFileSync(from, 'utf8'), 'NEW CONTENT');
  assert.deepEqual(tempLeftovers(dir), [], 'no temp file may be left behind');
});

test('cross-drive: same size but DIFFERENT content is caught by SHA-256', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  forceCrossDrive(t);

  // Same byte count, different bytes: a size-only check would pass this.
  const from = writeFile(dir, 'same-size.bin', 'AAAA');
  const to = path.join(dir, 'same-size-copy.bin');

  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = (src, dest) => {
    // Write a same-length but completely different string.
    fs.writeFileSync(dest, 'BBBB');
  };
  t.after(() => {
    fs.copyFileSync = originalCopy;
  });

  await assert.rejects(() => moveFileSafely(from, to), /SHA-256 mismatch/);

  // Source preserved; nothing left at the destination; no temp leftovers.
  assert.equal(fs.readFileSync(from, 'utf8'), 'AAAA');
  assert.ok(!fs.existsSync(to));
  assert.deepEqual(tempLeftovers(dir), []);
});

test('cross-drive: a verification failure preserves the source and cleans its own temp file', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  forceCrossDrive(t);

  const from = writeFile(dir, 'data.bin', 'this content must survive verification');
  const to = path.join(dir, 'data-copy.bin');

  // Corrupt the copy AFTER it is written, so only the hash can catch it.
  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = (src, dest, flags) => {
    originalCopy(src, dest, flags);
    fs.writeFileSync(dest, 'this content must survive verificatiON');
  };
  t.after(() => {
    fs.copyFileSync = originalCopy;
  });

  await assert.rejects(() => moveFileSafely(from, to), /SHA-256 mismatch/);

  assert.equal(fs.readFileSync(from, 'utf8'), 'this content must survive verification');
  assert.ok(!fs.existsSync(to), 'the failed copy must not be left at the destination');
  assert.deepEqual(tempLeftovers(dir), [], 'the temp file created by this operation must be removed');
});

test('cross-drive: a source that changes during the copy is never removed', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  forceCrossDrive(t);

  const from = writeFile(dir, 'changing.bin', 'ORIGINAL CONTENT');
  const to = path.join(dir, 'changing-copy.bin');

  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = (src, dest, flags) => {
    originalCopy(src, dest, flags);
    // Somebody edits the source while we are working on it.
    fs.writeFileSync(src, 'MODIFIED CONTENT!');
  };
  t.after(() => {
    fs.copyFileSync = originalCopy;
  });

  await assert.rejects(() => moveFileSafely(from, to), /changed while it was being copied/);

  assert.equal(fs.readFileSync(from, 'utf8'), 'MODIFIED CONTENT!', 'the changed source must be kept');
  assert.ok(!fs.existsSync(to));
  assert.deepEqual(tempLeftovers(dir), []);
});

test('cross-drive: a failed copy keeps the source and cleans up its own partial file', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  forceCrossDrive(t);

  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = (src, dest, flags) => {
    fs.writeFileSync(dest, 'PARTIAL'); // our own incomplete output
    const error = new Error('ENOSPC: no space left on device, copyfile');
    error.code = 'ENOSPC';
    throw error;
  };
  t.after(() => {
    fs.copyFileSync = originalCopy;
  });

  const from = writeFile(dir, 'big.bin', 'full-content-that-must-survive');
  const to = path.join(dir, 'big-copy.bin');

  await assert.rejects(() => moveFileSafely(from, to), /ENOSPC/);

  assert.equal(fs.readFileSync(from, 'utf8'), 'full-content-that-must-survive');
  assert.ok(!fs.existsSync(to), 'the partial copy created by the failed move must be removed');
  assert.deepEqual(tempLeftovers(dir), []);
});

test('cross-drive: a copy failure never deletes a file at the destination', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  forceCrossDrive(t);

  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = () => {
    const error = new Error('EIO: i/o error, copyfile');
    error.code = 'EIO';
    throw error;
  };
  t.after(() => {
    fs.copyFileSync = originalCopy;
  });

  const from = writeFile(dir, 'important.txt', 'do not lose this');
  const other = writeFile(dir, 'important-copy.txt', 'ANOTHER USERS FILE');
  const to = path.join(dir, 'somewhere-else.bin');

  await assert.rejects(() => moveFileSafely(from, to), /EIO/);

  assert.equal(fs.readFileSync(from, 'utf8'), 'do not lose this');
  assert.equal(fs.readFileSync(other, 'utf8'), 'ANOTHER USERS FILE', 'unrelated files untouched');
  assert.ok(!fs.existsSync(to));
  assert.deepEqual(tempLeftovers(dir), []);
});

test('cross-drive: temp cleanup refuses to remove anything that is not our temp file', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  const { removeOwnTempFile, makeTempPath } = require('../src/utils');

  const userFile = writeFile(dir, 'user-data.txt', 'KEEP ME');
  const nested = writeFile(dir, 'nested/keep.txt', 'KEEP ME TOO');

  // Names that do not match our own temp shape are ignored entirely.
  removeOwnTempFile(userFile);
  removeOwnTempFile(nested);
  removeOwnTempFile(path.join(dir, 'no-extension'));
  removeOwnTempFile(path.join(dir, 'missing.txt.tmp'));

  assert.equal(fs.readFileSync(userFile, 'utf8'), 'KEEP ME');
  assert.equal(fs.readFileSync(nested, 'utf8'), 'KEEP ME TOO');

  // But a file that really does match our own generated shape is removed.
  const ownTemp = makeTempPath(path.join(dir, 'report.csv'));
  assert.ok(path.basename(ownTemp).startsWith('.'));
  assert.ok(ownTemp.endsWith('.tmp'));
  fs.writeFileSync(ownTemp, 'scratch');
  removeOwnTempFile(ownTemp);
  assert.ok(!fs.existsSync(ownTemp));
});

test('cross-drive: apply/undo workflow still works with verification enabled', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  forceCrossDrive(t);

  const { buildPlan, applyPlan, undoManifest } = require('../src/organizer');

  writeFile(dir, 'a.jpg', 'img-bytes');
  writeFile(dir, 'docs/b.txt', 'text-bytes');

  // Compare FILE paths only: undo restores every file but never removes the
  // category folders it created (the tool has no folder-deletion feature), and
  // the manifest itself is a record of the run, not data being organized.
  const listFiles = (root) => {
    const found = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === '.organizer-manifests') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else found.push(path.relative(root, full));
      }
    };
    walk(root);
    return found.sort();
  };
  const originalFiles = listFiles(dir);

  const applied = await applyPlan(buildPlan(dir), { confirmFn: async () => true });
  assert.equal(applied.counts.moved, 2);
  assert.equal(applied.counts.skipped, 0);
  assert.ok(fs.existsSync(path.join(dir, 'Images', 'a.jpg')));
  assert.ok(fs.existsSync(path.join(dir, 'Documents', 'b.txt')));

  const undone = await undoManifest(applied.manifestPath, { confirmFn: async () => true });
  assert.equal(undone.counts.restored, 2);
  assert.equal(undone.counts.skipped, 0);

  assert.deepEqual(listFiles(dir), originalFiles);
  assert.equal(fs.readFileSync(path.join(dir, 'a.jpg'), 'utf8'), 'img-bytes');
  assert.equal(fs.readFileSync(path.join(dir, 'docs', 'b.txt'), 'utf8'), 'text-bytes');
  assert.deepEqual(tempLeftovers(dir), []);
});
