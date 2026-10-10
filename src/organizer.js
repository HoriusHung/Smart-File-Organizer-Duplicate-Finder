'use strict';

/**
 * organizer.js — safe file organization with dry-run, confirmation, manifest
 * and undo.
 *
 * Hard safety rules enforced here (and covered by tests):
 *   1. Building a plan only READS; nothing is moved.
 *   2. Files are only moved when applyPlan() runs, which the CLI reaches only
 *      after --apply AND an explicit "YES" confirmation.
 *   3. A USER FILE IS REMOVED ONLY AS THE LAST STEP OF A MOVE, and only after
 *      the destination already holds its bytes: on the same volume once
 *      fs.linkSync() has created the destination name (or a rename has
 *      succeeded), across volumes once the copy's SHA-256 has matched AND the
 *      source has been re-hashed to match. Every other removal targets a temp
 *      file or a destination this call created itself (rollback).
 *   4. Destinations are never overwritten: conflicts get "name (2).ext".
 *   5. Both the source and the destination must stay inside the chosen root.
 *   6. Symbolic links are never followed.
 *   7. Every successful move is recorded in a manifest that powers `undo`.
 */

const fs = require('node:fs');
const path = require('node:path');

const { scanDirectory, CATEGORY_NAMES } = require('./scanner');
const { isInsideRoot, describeError, sha256File, formatBytes, makeTempPath, placeFileNoOverwrite, removeOwnTempFile, sameVolume, claimDestinationExclusive, removeOwnPlaceholder, NO_LINK_CODES } = require('./utils');

const MANIFEST_DIR = '.organizer-manifests';
const MANIFEST_VERSION = 1;

/**
 * Find a free destination path. If "photo.jpg" is taken the result becomes
 * "photo (2).jpg", then "photo (3).jpg", ... Never overwrites anything.
 * Names already reserved by this same run are also avoided.
 */
function uniqueDestination(destinationDir, fileName, reserved) {
  const extension = path.extname(fileName);
  const base = path.basename(fileName, extension);
  let candidate = path.join(destinationDir, fileName);
  let counter = 1;
  while (reserved.has(candidate.toLowerCase()) || fs.existsSync(candidate)) {
    counter += 1;
    candidate = path.join(destinationDir, `${base} (${counter})${extension}`);
  }
  return candidate;
}

/**
 * Build the move plan for a directory. READ-ONLY.
 *
 * Returns:
 *   {
 *     root,
 *     moves:  [ { from, to, category, size, renamed } ],
 *     skipped: [ { path, reason } ],
 *     inventory
 *   }
 */
function buildPlan(root, options = {}) {
  const resolvedRoot = path.resolve(root);

  let stat;
  try {
    stat = fs.statSync(resolvedRoot);
  } catch (error) {
    const wrapped = new Error(`Cannot access directory: ${resolvedRoot} (${describeError(error)})`);
    wrapped.code = 'EINVALIDPATH';
    throw wrapped;
  }
  if (!stat.isDirectory()) {
    const wrapped = new Error(`Not a directory: ${resolvedRoot}`);
    wrapped.code = 'EINVALIDPATH';
    throw wrapped;
  }

  const inventory = options.inventory || scanDirectory(resolvedRoot, options);

  const moves = [];
  const skipped = [...inventory.skipped];
  const reserved = new Set();

  for (const file of inventory.files) {
    const relative = path.relative(resolvedRoot, file.path);
    const topSegment = relative.split(path.sep)[0];

    // Files already inside a category folder are left alone.
    if (CATEGORY_NAMES.includes(topSegment)) {
      skipped.push({ path: file.path, reason: `already inside category folder "${topSegment}"` });
      continue;
    }

    const destinationDir = path.join(resolvedRoot, file.category);
    const destination = uniqueDestination(destinationDir, file.name, reserved);
    reserved.add(destination.toLowerCase());

    // Containment check: never move outside the selected root.
    if (!isInsideRoot(resolvedRoot, file.path) || !isInsideRoot(resolvedRoot, destination)) {
      skipped.push({ path: file.path, reason: 'destination would leave the selected folder — refused' });
      continue;
    }

    moves.push({
      from: file.path,
      to: destination,
      category: file.category,
      size: file.size,
      renamed: destination.toLowerCase() !== path.join(destinationDir, file.name).toLowerCase(),
    });
  }

  moves.sort((a, b) => a.from.localeCompare(b.from));
  return { root: resolvedRoot, moves, skipped, inventory };
}

/** "The destination is already taken" — refused, never overwritten. */
function destinationExists(destination) {
  const error = new Error(`destination already exists: ${destination}`);
  error.code = 'EEXIST';
  return error;
}

/**
 * Best-effort removal of a destination THIS call created moments earlier —
 * either a successful fs.linkSync() or a reservation made with
 * claimDestinationExclusive() — used to roll a failed move back so the folder
 * is left exactly as the error message describes.
 *
 * It only ever removes a plain file (never a directory, never a symlink), and
 * it is only ever called for a path this call provably created: both of those
 * primitives fail with EEXIST when something is already there, so reaching
 * this function means the path was empty when we claimed it.
 * Returns true when the path really is gone.
 */
function removeOwnDestination(destination) {
  try {
    const stat = fs.lstatSync(destination);
    if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(destination);
  } catch (_) {
    /* fall through to the existence check below */
  }
  return !fs.existsSync(destination);
}

/**
 * Roll back our own destination and return the error the caller should throw.
 * When the rollback itself fails the message says so, because reporting plain
 * "failed" while an unreported copy is sitting in the folder would be a lie.
 *
 * The returned error deliberately has no `code`, so describeError() surfaces
 * this whole explanation instead of a bare system string.
 */
function rollbackMove(cause, destination) {
  if (removeOwnDestination(destination)) return cause;
  return new Error(`${cause.message} — a copy also remains at ${destination}`);
}

/**
 * Give up on a copy and clean up the temp file this call created.
 *
 * The source is always kept, and the destination is never touched. The one
 * exception: if the source has already disappeared, those bytes are the last
 * copy we know of, so the temp file is left on disk and its path is spelled
 * out in the message rather than being deleted.
 */
function giveUpOnCopy(tempPath, from, reason) {
  if (fs.existsSync(from)) {
    removeOwnTempFile(tempPath);
    return new Error(`${reason} The source was kept.`);
  }
  return new Error(
    `${reason} The source no longer exists, so nothing was deleted — the copy was left at ${tempPath}.`
  );
}

/**
 * Move one file WITHOUT ever replacing an existing destination.
 *
 * Same volume — two atomic primitives are tried, in order:
 *   1. fs.linkSync(). It is atomic and fails with EEXIST when something is
 *      already at `to`, so a file another process creates at that exact moment
 *      is refused rather than silently replaced. rename() would replace it on
 *      every platform (Node passes MOVEFILE_REPLACE_EXISTING even on Windows),
 *      which is why rename() is no longer the first choice here. The source
 *      name is removed only after `to` exists.
 *   2. On filesystems without hard links (FAT, exFAT, some network shares),
 *      the destination is reserved atomically with an O_EXCL claim and then
 *      renamed into, so a concurrently created destination is refused there
 *      too. The reservation is only ever attempted once source and destination
 *      are proven to share a volume — reserving across a device boundary
 *      would strand an empty file on the other side if the rename failed.
 *
 * Different volume (EXDEV): hash the source, copy into a private temp file,
 * hash the copy, place it without overwriting, hash the source AGAIN, and only
 * then remove the source.
 *
 * Every removal of a user file in this project happens inside moveFileSafely()
 * — on either of the same-volume paths above, or on the copy path below — and
 * it can only be reached through applyPlan() / undoManifest(), both of which
 * require --apply plus an explicit "YES" confirmation.
 *
 * Returns { via: 'link' | 'rename' | 'copy' } so callers/tests can see which
 * path ran.
 */
async function moveFileSafely(from, to) {
  // Fast, friendly refusal. The authoritative check is atomic and lives inside
  // the primitives below; this only saves pointless work.
  if (fs.existsSync(to)) throw destinationExists(to);

  try {
    return { via: moveSameVolume(from, to) };
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
  }
  return copyAndVerify(from, to);
}

/**
 * Same-volume half of moveFileSafely(). Returns 'link' or 'rename', or throws
 * an error tagged EXDEV so the caller falls back to a verified copy.
 */
function moveSameVolume(from, to) {
  try {
    fs.linkSync(from, to);
  } catch (linkError) {
    // Somebody else owns the destination: refuse and change nothing.
    if (linkError.code === 'EEXIST') throw linkError;
    // Anything that is not "hard links are unavailable here" is a real failure
    // and must not be papered over with a fallback.
    if (!NO_LINK_CODES.has(linkError.code)) throw linkError;

    // A different volume goes straight to the copy path. Proving the volume
    // first is what makes the reservation below safe: without that proof a
    // failed rename could leave an empty file stranded on the other device.
    if (linkError.code === 'EXDEV' || !sameVolume(from, path.dirname(to))) {
      const error = new Error(`EXDEV: cross-device link not permitted, move '${from}' -> '${to}'`);
      error.code = 'EXDEV';
      throw error;
    }

    claimDestinationExclusive(to);
    try {
      fs.renameSync(from, to);
    } catch (renameError) {
      // The reservation is ours and still untouched — put the folder back the
      // way we found it before reporting the failure.
      removeOwnPlaceholder(to);
      throw renameError;
    }
    return 'rename';
  }

  // `to` is now a second name for the same data, so the source may be removed.
  // If that removal fails the destination we created is rolled back, which
  // keeps a failed move from leaving an unreported copy behind.
  try {
    fs.unlinkSync(from);
  } catch (unlinkError) {
    // The source vanished underneath us: the data is already at `to` and the
    // path is free, so the move is complete. Rolling back here would destroy
    // the only remaining copy.
    if (unlinkError.code === 'ENOENT' && !fs.existsSync(from)) return 'link';
    throw rollbackMove(
      new Error(`the file reached the destination but the source could not be removed (${describeError(unlinkError)})`),
      to
    );
  }
  return 'link';
}

/**
 * Cross-drive fallback: copy the bytes, then prove they are the right bytes.
 *
 * The source is removed only after three SHA-256 readings agree: the source
 * before the copy, the copy itself, and the source once more at step 5. That
 * last reading is taken immediately before the removal at step 6, so a source
 * that changes is seen and the destination this call just installed is rolled
 * back rather than left unreported.
 */
async function copyAndVerify(from, to) {
  // 1. Hash the source BEFORE copying: this is our consistency reference.
  const sourceHashBefore = await sha256File(from);

  // 2. Copy into a temp file WE create exclusively. COPYFILE_EXCL means we can
  //    never overwrite anything, and the unique name means we can only ever be
  //    cleaning up a file this call made.
  const tempPath = makeTempPath(to);
  try {
    fs.copyFileSync(from, tempPath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    // EEXIST => the unique name somehow collided; we wrote nothing, so we must
    // not delete it. Anything else may have left OUR partial file behind.
    if (error.code === 'EEXIST') throw destinationExists(tempPath);
    throw giveUpOnCopy(tempPath, from, `the copy failed (${describeError(error)}).`);
  }

  // 3. Verify the copy against the reference. An unreadable hash counts as
  //    "inconclusive": nothing is trusted, nothing at the destination is
  //    created, and the reason is reported instead of a raw system error.
  let copiedHash;
  try {
    copiedHash = await sha256File(tempPath);
  } catch (error) {
    throw giveUpOnCopy(tempPath, from, `copy verification is inconclusive (${describeError(error)}).`);
  }

  if (copiedHash !== sourceHashBefore) {
    throw giveUpOnCopy(
      tempPath,
      from,
      `copy verification failed: SHA-256 mismatch (expected ${sourceHashBefore.slice(0, 16)}…, ` +
        `got ${copiedHash.slice(0, 16)}…).`
    );
  }

  // 4. Content verified. Place it at the destination without ever replacing an
  //    existing file (see placeFileNoOverwrite).
  try {
    placeFileNoOverwrite(tempPath, to);
  } catch (error) {
    removeOwnTempFile(tempPath);
    throw error;
  }

  // 5. Re-check the source one final time, immediately before removing it.
  let sourceHashNow;
  try {
    sourceHashNow = await sha256File(from);
  } catch (error) {
    // Absent source means the verified data at `to` is all that is left: the
    // move is complete and must not be rolled back.
    if (error.code === 'ENOENT' && !fs.existsSync(from)) return { via: 'copy' };
    throw rollbackMove(
      new Error(
        `the copy was verified but the source cannot be re-checked (${describeError(error)}) — it was kept.`
      ),
      to
    );
  }

  if (sourceHashNow !== sourceHashBefore) {
    throw rollbackMove(
      new Error(
        'source file changed while it was being copied — consistency cannot be established, so the source was kept.'
      ),
      to
    );
  }

  // 6. Every reading agrees: only now is the source removed.
  try {
    fs.unlinkSync(from);
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(from)) return { via: 'copy' };
    throw rollbackMove(
      new Error(`the copy was verified but the source could not be removed (${describeError(error)})`),
      to
    );
  }

  return { via: 'copy' };
}

/**
 * Execute a plan. Requires an explicit confirmation callback that must
 * return true; without it (or when it returns false) nothing happens.
 *
 * Returns:
 *   {
 *     root, manifestPath,
 *     moved: [ { from, to, size, sha256 } ],
 *     skipped: [ { path, to, reason } ],
 *     counts: { planned, moved, skipped }
 *   }
 */
async function applyPlan(plan, options = {}) {
  const confirmFn = options.confirmFn;
  if (typeof confirmFn !== 'function') {
    throw new Error('applyPlan requires a confirmation function — refusing to move files without one.');
  }
  const approved = await confirmFn();
  if (!approved) {
    return { cancelled: true, root: plan.root, manifestPath: null, moved: [], skipped: [], counts: { planned: plan.moves.length, moved: 0, skipped: 0 } };
  }

  const root = plan.root;
  const moved = [];
  const skipped = [];

  // Create the category folders up-front so a failure affects one category
  // instead of aborting the whole run.
  const failedCategories = new Map();
  for (const category of new Set(plan.moves.map((move) => move.category))) {
    const directory = path.join(root, category);
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
      failedCategories.set(category, describeError(error));
    }
  }

  for (const move of plan.moves) {
    const categoryFailure = failedCategories.get(move.category);
    if (categoryFailure) {
      skipped.push({ path: move.from, to: move.to, reason: `cannot create folder "${move.category}" (${categoryFailure})` });
      continue;
    }

    // Re-verify safety at the moment of the move (the world may have changed
    // since the plan was built).
    try {
      const sourceStat = fs.lstatSync(move.from);
      if (sourceStat.isSymbolicLink()) {
        skipped.push({ path: move.from, to: move.to, reason: 'source became a symbolic link — refused' });
        continue;
      }
      if (!sourceStat.isFile()) {
        skipped.push({ path: move.from, to: move.to, reason: 'source is no longer a regular file — refused' });
        continue;
      }
    } catch (error) {
      skipped.push({ path: move.from, to: move.to, reason: `source unavailable (${describeError(error)})` });
      continue;
    }

    if (!isInsideRoot(root, move.to)) {
      skipped.push({ path: move.from, to: move.to, reason: 'destination is outside the selected folder — refused' });
      continue;
    }

    let destination = move.to;
    if (fs.existsSync(destination)) {
      // Never overwrite: fall back to a free numbered name.
      destination = uniqueDestination(path.dirname(move.to), path.basename(move.to), new Set());
      if (destination.toLowerCase() === move.to.toLowerCase()) {
        skipped.push({ path: move.from, to: move.to, reason: 'destination already exists — refused to overwrite' });
        continue;
      }
    }

    let hash = null;
    try {
      hash = await sha256File(move.from);
    } catch (error) {
      skipped.push({ path: move.from, to: move.to, reason: `cannot hash source (${describeError(error)}) — refused` });
      continue;
    }

    try {
      await moveFileSafely(move.from, destination);
      moved.push({ from: move.from, to: destination, size: move.size, sha256: hash });
    } catch (error) {
      skipped.push({ path: move.from, to: destination, reason: describeError(error) });
    }
  }

  let manifestPath = null;
  if (moved.length > 0) {
    manifestPath = writeManifest(root, moved, skipped);
  }

  return {
    cancelled: false,
    root,
    manifestPath,
    moved,
    skipped,
    counts: { planned: plan.moves.length, moved: moved.length, skipped: skipped.length },
  };
}

/** Write a manifest file for this run (one manifest per run, never reused). */
function writeManifest(root, moved, skipped) {
  const directory = path.join(root, MANIFEST_DIR);
  fs.mkdirSync(directory, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = path.join(directory, `organize-${stamp}.json`);

  const manifest = {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    root,
    moves: moved.map((entry) => ({
      from: entry.from,
      to: entry.to,
      size: entry.size,
      sha256: entry.sha256,
      status: 'moved',
    })),
    skipped: skipped.map((entry) => ({ from: entry.path, reason: entry.reason })),
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

/** Read and validate a manifest. Throws with code EBADMANIFEST when invalid. */
function readManifest(manifestPath) {
  const absolute = path.resolve(manifestPath);

  let raw;
  try {
    raw = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    const wrapped = new Error(`Cannot read manifest: ${absolute} (${describeError(error)})`);
    wrapped.code = 'EBADMANIFEST';
    throw wrapped;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    const wrapped = new Error(`Manifest is not valid JSON: ${absolute}`);
    wrapped.code = 'EBADMANIFEST';
    throw wrapped;
  }

  if (!manifest || typeof manifest !== 'object') {
    const wrapped = new Error(`Manifest is not valid: ${absolute}`);
    wrapped.code = 'EBADMANIFEST';
    throw wrapped;
  }
  if (manifest.version !== MANIFEST_VERSION) {
    const wrapped = new Error(`Unsupported manifest version: ${manifest.version} (expected ${MANIFEST_VERSION})`);
    wrapped.code = 'EBADMANIFEST';
    throw wrapped;
  }
  if (!manifest.root || typeof manifest.root !== 'string' || !Array.isArray(manifest.moves)) {
    const wrapped = new Error(`Manifest is missing required fields (root, moves): ${absolute}`);
    wrapped.code = 'EBADMANIFEST';
    throw wrapped;
  }

  for (const entry of manifest.moves) {
    if (!entry || typeof entry.from !== 'string' || typeof entry.to !== 'string') {
      const wrapped = new Error(`Manifest contains an invalid move entry: ${absolute}`);
      wrapped.code = 'EBADMANIFEST';
      throw wrapped;
    }
  }

  manifest.manifestPath = absolute;
  return manifest;
}

/**
 * Undo a manifest: move every file back to its original location.
 * Every entry is re-validated first; anything unsafe is SKIPPED with a
 * reason instead of forced. Requires confirmation, like applyPlan().
 *
 * Returns { cancelled, root, restored: [...], skipped: [...], counts }.
 */
async function undoManifest(manifestOrPath, options = {}) {
  const manifest = typeof manifestOrPath === 'string' ? readManifest(manifestOrPath) : manifestOrPath;
  const root = path.resolve(manifest.root);

  const confirmFn = options.confirmFn;
  if (typeof confirmFn !== 'function') {
    throw new Error('undoManifest requires a confirmation function — refusing to move files without one.');
  }
  const approved = await confirmFn();
  if (!approved) {
    return { cancelled: true, root, restored: [], skipped: [], counts: { planned: manifest.moves.length, restored: 0, skipped: 0 } };
  }

  const restored = [];
  const skipped = [];

  // Undo newest-first so partial re-runs behave sensibly.
  const entries = [...manifest.moves].reverse();

  for (const entry of entries) {
    const { from, to, sha256 } = entry;

    if (!isInsideRoot(root, from) || !isInsideRoot(root, to)) {
      skipped.push({ path: to, to: from, reason: 'path is outside the organized folder — refused' });
      continue;
    }

    let movedStat;
    try {
      movedStat = fs.lstatSync(to);
    } catch (error) {
      skipped.push({ path: to, to: from, reason: `moved file is missing (${describeError(error)})` });
      continue;
    }
    if (movedStat.isSymbolicLink() || !movedStat.isFile()) {
      skipped.push({ path: to, to: from, reason: 'moved path is not a regular file — refused' });
      continue;
    }

    if (fs.existsSync(from)) {
      skipped.push({ path: to, to: from, reason: 'original location is now occupied — refusing to overwrite' });
      continue;
    }

    if (sha256) {
      let currentHash = null;
      try {
        currentHash = await sha256File(to);
      } catch (error) {
        skipped.push({ path: to, to: from, reason: `cannot verify file (${describeError(error)})` });
        continue;
      }
      if (currentHash !== sha256) {
        skipped.push({ path: to, to: from, reason: 'file content changed since it was moved — refusing to restore it' });
        continue;
      }
    }

    try {
      fs.mkdirSync(path.dirname(from), { recursive: true });
      await moveFileSafely(to, from);
      restored.push({ from: to, to: from, size: entry.size || 0 });
    } catch (error) {
      skipped.push({ path: to, to: from, reason: describeError(error) });
    }
  }

  return {
    cancelled: false,
    root,
    restored,
    skipped,
    counts: { planned: manifest.moves.length, restored: restored.length, skipped: skipped.length },
  };
}

/** Human-readable preview of a plan: "source -> destination" per line. */
function formatPlanLines(plan, limit = 50) {
  const lines = [];
  const shown = plan.moves.slice(0, limit);
  for (const move of shown) {
    const note = move.renamed ? '  (renamed to avoid a conflict)' : '';
    lines.push(`  ${move.from}  ->  ${move.to}${note}`);
  }
  if (plan.moves.length > shown.length) {
    lines.push(`  ... and ${plan.moves.length - shown.length} more`);
  }
  return lines;
}

/** Short "Images: 12 files, 45.3 MB" style summary of a plan. */
function formatPlanSummary(plan) {
  const byCategory = {};
  for (const move of plan.moves) {
    const bucket = byCategory[move.category] || (byCategory[move.category] = { count: 0, size: 0 });
    bucket.count += 1;
    bucket.size += move.size;
  }
  const parts = Object.entries(byCategory).map(
    ([category, info]) => `${category}: ${info.count} file(s), ${formatBytes(info.size)}`
  );
  return parts.length > 0 ? parts.join(' | ') : 'no files to organize';
}

module.exports = {
  buildPlan,
  applyPlan,
  undoManifest,
  readManifest,
  writeManifest,
  uniqueDestination,
  moveFileSafely,
  formatPlanLines,
  formatPlanSummary,
  MANIFEST_DIR,
  MANIFEST_VERSION,
};
