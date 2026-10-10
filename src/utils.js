'use strict';

/**
 * Small shared helpers used by every module.
 * Nothing here changes the user's files, except sha256File() which only reads.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

/** Human readable file size: 1536 -> "1.5 KB". */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 'B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/**
 * True when `candidate` is strictly inside `root` (both resolved to absolute
 * paths). Used to guarantee we never touch anything outside the folder the
 * user selected. Works with Windows drive letters and mixed casing because
 * path.relative() is case-insensitive on Windows.
 */
function isInsideRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Turn a Node.js fs error into a short message a beginner can understand. */
function describeError(error) {
  switch (error && error.code) {
    case 'EPERM':
    case 'EACCES':
      return 'permission denied';
    case 'ENOENT':
      return 'file or folder not found (moved or deleted?)';
    case 'EMFILE':
    case 'ENFILE':
      return 'too many open files';
    case 'ENAMETOOLONG':
      return 'path is too long for this system';
    case 'EBUSY':
    case 'UNKNOWN':
      return 'file is in use or unreadable';
    default:
      return error && error.message ? error.message : String(error);
  }
}

/**
 * SHA-256 of a file, computed with a read stream so memory usage stays tiny
 * even for multi-gigabyte files.
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Ask a question on the terminal and wait for an answer.
 * Returns true ONLY when the user types exactly "YES".
 * If there is no interactive terminal (piped/automated input) it returns
 * false, so dangerous operations can never run unattended.
 */
function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.resolve(false);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim() === 'YES');
    });
  });
}

/**
 * A collision-resistant temporary path sitting in the SAME directory (and so
 * the same volume) as `finalPath`, which keeps the final placement a
 * same-volume operation instead of a cross-device one.
 *
 * The name mixes the pid, a timestamp and 6 random bytes, so it is effectively
 * unique; it starts with a dot, so this tool's own scanner treats the leftover
 * as hidden and skips it; and it ends in ".tmp" so it is easy to recognise.
 */
function makeTempPath(finalPath) {
  const unique = `${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  return path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${unique}.tmp`);
}

/** Error codes that mean "this filesystem does not support hard links". */
const NO_LINK_CODES = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK', 'EXDEV']);

/**
 * Best-effort removal of a temporary file this tool created.
 *
 * It refuses to touch anything it cannot positively identify as its own: the
 * name must match the shape produced by makeTempPath() (leading dot, ".tmp"
 * suffix), and it must be a plain file — never a directory and never a link.
 * A failure to remove the temp file is never fatal: the real error is always
 * the one the caller reports.
 */
function removeOwnTempFile(tempPath) {
  const name = path.basename(tempPath);
  if (!name.startsWith('.') || !name.endsWith('.tmp')) return;
  try {
    const stat = fs.lstatSync(tempPath);
    if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(tempPath);
  } catch (_) {
    /* already gone, or not removable — never fatal */
  }
}

/**
 * Do `left` and `right` live on the same filesystem volume?
 *
 * Used to decide whether it is safe to reserve a destination before renaming
 * into it: a reservation made on the wrong side of a device boundary would
 * strand an empty file there if the rename then failed with EXDEV. Anything
 * that cannot be stat'ed answers `false`, which is the conservative answer
 * (we then take the verified cross-drive copy path instead).
 */
function sameVolume(left, right) {
  try {
    return fs.statSync(left).dev === fs.statSync(right).dev;
  } catch (_) {
    return false;
  }
}

/**
 * Reserve a brand-new path by creating it empty with the O_EXCL ("wx") flag.
 *
 * This is the portable no-clobber primitive: openSync(..., 'wx') is atomic, so
 * it fails with EEXIST if ANYTHING already exists at `destination`. Two racing
 * writers can therefore never both win — whichever claims second is refused —
 * which an existsSync() check followed by a rename() can never guarantee,
 * because rename() silently overwrites on every platform.
 *
 * Returns once the path is reserved and the descriptor is closed.
 */
function claimDestinationExclusive(destination) {
  let descriptor;
  try {
    descriptor = fs.openSync(destination, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      const existsError = new Error(`destination already exists: ${destination}`);
      existsError.code = 'EEXIST';
      throw existsError;
    }
    throw error;
  }
  fs.closeSync(descriptor);
  return destination;
}

/**
 * Best-effort removal of a reservation made by claimDestinationExclusive()
 * that could not be filled.
 *
 * It only ever removes a plain, empty, non-symlink file: an untouched
 * reservation is exactly that, and a non-empty file means somebody else wrote
 * through it in the meantime, so it is left alone rather than destroyed. A
 * failure is never fatal — the caller's original error is what gets reported.
 */
function removeOwnPlaceholder(placeholderPath) {
  try {
    const stat = fs.lstatSync(placeholderPath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size === 0) {
      fs.unlinkSync(placeholderPath);
    }
  } catch (_) {
    /* already gone, or not removable — never fatal */
  }
}

/**
 * Move a temporary file to its final path WITHOUT ever replacing an existing
 * file.
 *
 * fs.renameSync() is not safe for this: Node passes MOVEFILE_REPLACE_EXISTING
 * on Windows too, so rename() silently overwrites an existing destination on
 * every platform. Two atomic primitives are used instead:
 *
 *   1. fs.linkSync() — fails with EEXIST when the target is taken.
 *   2. On filesystems without hard links (FAT, exFAT, some network shares) an
 *      exclusive claim via claimDestinationExclusive(), then rename() into the
 *      name we own. The claim is atomic, so a destination somebody else
 *      creates first is refused rather than replaced.
 *
 * Residual limitation: neither primitive can defend against a third party that
 * writes to a path with non-exclusive calls (plain open('w'), or rename()).
 * No filesystem API can. Documented in README.md.
 */
function placeFileNoOverwrite(tempPath, finalPath) {
  try {
    fs.linkSync(tempPath, finalPath);
  } catch (error) {
    if (error.code === 'EEXIST') throw error;
    if (!NO_LINK_CODES.has(error.code)) throw error;

    // Hard links are unavailable here. Reserve the destination first — but
    // only once we know a rename into it cannot fail with EXDEV, because a
    // failed reservation would otherwise strand an empty file on the other
    // volume. tempPath lives in the same directory as finalPath by
    // construction (see makeTempPath), so this normally passes without cost.
    if (error.code !== 'EXDEV' && !sameVolume(tempPath, path.dirname(finalPath))) {
      const devError = new Error(`EXDEV: cross-device link not permitted, place '${tempPath}' -> '${finalPath}'`);
      devError.code = 'EXDEV';
      throw devError;
    }

    claimDestinationExclusive(finalPath);
    try {
      fs.renameSync(tempPath, finalPath);
    } catch (renameError) {
      removeOwnPlaceholder(finalPath);
      throw renameError;
    }
    return;
  }
  // The content is now at finalPath; drop our temporary name (best effort).
  removeOwnTempFile(tempPath);
}

module.exports = {
  formatBytes,
  isInsideRoot,
  describeError,
  sha256File,
  confirm,
  makeTempPath,
  sameVolume,
  claimDestinationExclusive,
  removeOwnPlaceholder,
  placeFileNoOverwrite,
  removeOwnTempFile,
  NO_LINK_CODES,
};
