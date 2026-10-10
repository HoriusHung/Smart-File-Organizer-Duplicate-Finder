'use strict';

/**
 * No-clobber guarantees.
 *
 * Two atomic primitives are supposed to make "destination is taken" a refusal
 * instead of a destruction:
 *
 *   1. fs.linkSync()       — atomic, fails EEXIST when the target is taken.
 *   2. an O_EXCL "wx" claim — atomic, for filesystems without hard links.
 *
 * rename() is neither: it replaces an existing destination on every platform
 * (Node passes MOVEFILE_REPLACE_EXISTING even on Windows), so an existsSync()
 * check in front of it can always be beaten by another process. That is the
 * race every test below recreates: a competing file is dropped into the
 * destination INSIDE the window an existsSync()+rename() implementation would
 * leave open, and the test asserts that the competing file, the source, and
 * their contents all survive.
 *
 * Everything runs in throw-away temp folders; no test touches a real user
 * folder or the repository itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { moveFileSafely } = require('../src/organizer');
const { writeReport } = require('../src/reports');
const { removeOwnPlaceholder, sameVolume } = require('../src/utils');
const { makeTempDir, writeFile, cleanup } = require('./helpers');

/**
 * Install patches that last exactly as long as the test.
 * The temp folder is cleaned up only AFTER every patch has been removed, so
 * no test can leak a monkey-patch into the next one.
 */
function patched(t, dir, install) {
  const restore = install();
  t.after(() => {
    restore();
    cleanup(dir);
  });
}

/** Shape produced by makeTempPath(): dot-prefixed, ending in ".tmp". */
function isOwnTemp(name) {
  const base = path.basename(name);
  return base.startsWith('.') && base.endsWith('.tmp');
}

/** A hard link failing the way FAT/exFAT/some network shares answer. */
function noHardLinks(source, destination) {
  const error = new Error(`EPERM: operation not permitted, link '${source}' -> '${destination}'`);
  error.code = 'EPERM';
  return error;
}

/** The temp leftovers of a folder (our temp files end in ".tmp"). */
function tempLeftovers(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

test('same-drive: a normal move uses the atomic link path', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  const from = writeFile(dir, 'photo.jpg', 'image-bytes');
  const to = path.join(dir, 'Images', 'photo.jpg');
  fs.mkdirSync(path.dirname(to), { recursive: true });

  const result = await moveFileSafely(from, to);

  assert.equal(result.via, 'link');
  assert.ok(!fs.existsSync(from), 'the source is removed only after the destination exists');
  assert.equal(fs.readFileSync(to, 'utf8'), 'image-bytes');
  assert.deepEqual(tempLeftovers(dir), []);
});

test('same-drive: an existing destination is refused, both files untouched', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  const from = writeFile(dir, 'a.txt', 'THE NEW FILE');
  const to = writeFile(dir, 'b.txt', 'PRECIOUS EXISTING CONTENT');

  await assert.rejects(() => moveFileSafely(from, to), (error) => error.code === 'EEXIST');

  assert.equal(fs.readFileSync(from, 'utf8'), 'THE NEW FILE');
  assert.equal(fs.readFileSync(to, 'utf8'), 'PRECIOUS EXISTING CONTENT');
});

test('same-drive: a destination created inside the race window is never replaced', async (t) => {
  const dir = makeTempDir();
  const from = writeFile(dir, 'source.txt', 'THE ORIGINAL FILE');
  const to = path.join(dir, 'destination.txt');

  let raced = false;
  patched(t, dir, () => {
    const originalLink = fs.linkSync;
    fs.linkSync = (source, destination) => {
      if (!raced) {
        raced = true;
        // Another process wins the race between our existence check and our
        // own link attempt — exactly the window rename() would have clobbered.
        fs.writeFileSync(destination, 'CREATED BY ANOTHER PROCESS');
      }
      return originalLink(source, destination);
    };
    return () => {
      fs.linkSync = originalLink;
    };
  });

  await assert.rejects(() => moveFileSafely(from, to), (error) => error.code === 'EEXIST');

  // Nothing was destroyed.
  assert.equal(fs.readFileSync(to, 'utf8'), 'CREATED BY ANOTHER PROCESS');
  assert.equal(fs.readFileSync(from, 'utf8'), 'THE ORIGINAL FILE');
  // And no temp file was left behind.
  assert.deepEqual(tempLeftovers(dir), []);
});

test('same-drive: without hard links the move still works through an exclusive claim', async (t) => {
  const dir = makeTempDir();
  const from = writeFile(dir, 'a.txt', 'PAYLOAD');
  const to = path.join(dir, 'b.txt');

  patched(t, dir, () => {
    const originalLink = fs.linkSync;
    fs.linkSync = (source, destination) => {
      throw noHardLinks(source, destination);
    };
    return () => {
      fs.linkSync = originalLink;
    };
  });

  const result = await moveFileSafely(from, to);

  assert.equal(result.via, 'rename');
  assert.equal(fs.readFileSync(to, 'utf8'), 'PAYLOAD');
  assert.ok(!fs.existsSync(from));
  assert.deepEqual(tempLeftovers(dir), []);
});

test('same-drive: the exclusive claim refuses a destination created in the race window', async (t) => {
  const dir = makeTempDir();
  const from = writeFile(dir, 'a.txt', 'THE ORIGINAL FILE');
  const to = path.join(dir, 'b.txt');

  let raced = false;
  patched(t, dir, () => {
    const originalLink = fs.linkSync;
    const originalOpen = fs.openSync;
    fs.linkSync = (source, destination) => {
      throw noHardLinks(source, destination);
    };
    fs.openSync = (name, flags, ...rest) => {
      // Race only the destination claim, never our own temp file.
      if (flags === 'wx' && !isOwnTemp(name) && !raced) {
        raced = true;
        fs.writeFileSync(name, 'CREATED BY ANOTHER PROCESS');
      }
      return originalOpen(name, flags, ...rest);
    };
    return () => {
      fs.linkSync = originalLink;
      fs.openSync = originalOpen;
    };
  });

  await assert.rejects(() => moveFileSafely(from, to), /destination already exists/);

  assert.equal(fs.readFileSync(to, 'utf8'), 'CREATED BY ANOTHER PROCESS');
  assert.equal(fs.readFileSync(from, 'utf8'), 'THE ORIGINAL FILE');
  assert.deepEqual(tempLeftovers(dir), []);
});

test('same-drive: a failed rename after the claim removes our own reservation', async (t) => {
  const dir = makeTempDir();
  const from = writeFile(dir, 'a.txt', 'SOURCE');
  const to = path.join(dir, 'b.txt');

  patched(t, dir, () => {
    const originalLink = fs.linkSync;
    const originalRename = fs.renameSync;
    fs.linkSync = (source, destination) => {
      throw noHardLinks(source, destination);
    };
    fs.renameSync = () => {
      const error = new Error('EIO: i/o error, rename');
      error.code = 'EIO';
      throw error;
    };
    return () => {
      fs.linkSync = originalLink;
      fs.renameSync = originalRename;
    };
  });

  await assert.rejects(() => moveFileSafely(from, to), /EIO/);

  assert.equal(fs.readFileSync(from, 'utf8'), 'SOURCE', 'the source must be kept');
  assert.ok(!fs.existsSync(to), 'the empty reservation must not be stranded in the folder');
  assert.deepEqual(tempLeftovers(dir), []);
});

test('same-drive: a source that cannot be removed rolls the destination back', async (t) => {
  const dir = makeTempDir();
  const from = writeFile(dir, 'locked.txt', 'STILL HERE');
  const to = path.join(dir, 'moved.txt');

  patched(t, dir, () => {
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = (target) => {
      if (path.resolve(target) === path.resolve(from)) {
        const error = new Error('EBUSY: resource busy or locked, unlink');
        error.code = 'EBUSY';
        throw error;
      }
      return originalUnlink(target);
    };
    return () => {
      fs.unlinkSync = originalUnlink;
    };
  });

  await assert.rejects(() => moveFileSafely(from, to), /source could not be removed/);

  assert.equal(fs.readFileSync(from, 'utf8'), 'STILL HERE', 'the source must be kept');
  assert.ok(!fs.existsSync(to), 'an unreported destination copy must be rolled back');
  assert.deepEqual(tempLeftovers(dir), []);
});

test('cross-drive: a hash that cannot be read is inconclusive and keeps the source', async (t) => {
  const dir = makeTempDir();
  const from = writeFile(dir, 'data.bin', 'CONTENT THAT MUST SURVIVE');
  const to = path.join(dir, 'data-copy.bin');

  patched(t, dir, () => {
    const originalLink = fs.linkSync;
    const originalRead = fs.createReadStream;
    fs.linkSync = (source, destination) => {
      // Force the verified-copy path, but let our own temp file be placed.
      if (isOwnTemp(source)) return originalLink(source, destination);
      const error = new Error(`EXDEV: cross-device link not permitted, link '${source}' -> '${destination}'`);
      error.code = 'EXDEV';
      throw error;
    };
    fs.createReadStream = (target, ...rest) => {
      if (isOwnTemp(target)) {
        const error = new Error('EACCES: permission denied, open');
        error.code = 'EACCES';
        throw error;
      }
      return originalRead(target, ...rest);
    };
    return () => {
      fs.linkSync = originalLink;
      fs.createReadStream = originalRead;
    };
  });

  await assert.rejects(() => moveFileSafely(from, to), /copy verification is inconclusive/);

  assert.equal(fs.readFileSync(from, 'utf8'), 'CONTENT THAT MUST SURVIVE');
  assert.ok(!fs.existsSync(to), 'an inconclusive copy must never be installed');
  assert.deepEqual(tempLeftovers(dir), [], 'the temp file created for the copy must be cleaned up');
});

test('cleanup: removeOwnPlaceholder only removes its own untouched reservation', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  // Our own reservation: a plain, empty file. It goes.
  const reservation = path.join(dir, 'report.csv');
  fs.writeFileSync(reservation, '');
  removeOwnPlaceholder(reservation);
  assert.ok(!fs.existsSync(reservation));

  // Not empty any more: somebody wrote through it, so it is theirs now.
  const occupied = path.join(dir, 'occupied.csv');
  fs.writeFileSync(occupied, 'SOMEBODY WROTE HERE');
  removeOwnPlaceholder(occupied);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'SOMEBODY WROTE HERE');

  // Directories are never touched.
  const folder = path.join(dir, 'folder.csv');
  fs.mkdirSync(folder);
  removeOwnPlaceholder(folder);
  assert.ok(fs.existsSync(folder));

  // A path that does not exist is not an error.
  assert.doesNotThrow(() => removeOwnPlaceholder(path.join(dir, 'absent.csv')));
});

test('same-volume: only a proven shared volume allows a reservation', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  assert.ok(sameVolume(dir, dir));
  assert.ok(sameVolume(writeFile(dir, 'a.txt', 'x'), dir));

  // A path that cannot be stat'ed answers false — the conservative answer,
  // which sends the move down the verified copy path instead of letting it
  // reserve a destination it might not be able to rename into.
  assert.equal(sameVolume(path.join(dir, 'absent.txt'), dir), false);

  // Different drives must never claim the same volume: that is exactly what
  // would strand an empty file on the other side of a device boundary.
  assert.equal(sameVolume('C:\\', 'D:\\'), false);
});

test('reports: a report still installs when hard links are unavailable', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const target = path.join(dir, 'out.csv');

  const originalLink = fs.linkSync;
  fs.linkSync = (source, destination) => {
    throw noHardLinks(source, destination);
  };
  t.after(() => {
    fs.linkSync = originalLink;
  });

  writeReport({
    outPath: target,
    format: 'csv',
    kind: 'summary',
    root: dir,
    data: [{ metric: 'files', value: 1 }],
  });

  const raw = fs.readFileSync(target);
  assert.equal(raw[0], 0xef, 'the UTF-8 BOM is still written');
  assert.equal(raw[1], 0xbb);
  assert.equal(raw[2], 0xbf);
  assert.ok(raw.toString('utf8').includes('files'));
  assert.deepEqual(tempLeftovers(dir), [], 'the temp file must be renamed away, not left behind');
});

test('reports: the exclusive claim refuses a destination that appears mid-install', (t) => {
  const dir = makeTempDir();
  const target = path.join(dir, 'out.csv');

  let raced = false;
  patched(t, dir, () => {
    const originalLink = fs.linkSync;
    const originalOpen = fs.openSync;
    fs.linkSync = (source, destination) => {
      throw noHardLinks(source, destination);
    };
    fs.openSync = (name, flags, ...rest) => {
      // Race the destination claim only; the report's own temp file must be
      // left alone so the write itself still succeeds.
      if (flags === 'wx' && !isOwnTemp(name) && !raced) {
        raced = true;
        fs.writeFileSync(name, 'RACED IN BY SOMEONE ELSE');
      }
      return originalOpen(name, flags, ...rest);
    };
    return () => {
      fs.linkSync = originalLink;
      fs.openSync = originalOpen;
    };
  });

  assert.throws(
    () =>
      writeReport({
        outPath: target,
        format: 'csv',
        kind: 'summary',
        root: dir,
        data: [{ metric: 'x', value: 1 }],
      }),
    /destination already exists/
  );

  assert.equal(fs.readFileSync(target, 'utf8'), 'RACED IN BY SOMEONE ELSE');
  assert.deepEqual(tempLeftovers(dir), [], 'the temp file created by this call must be cleaned up');
});
