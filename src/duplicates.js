'use strict';

/**
 * duplicates.js — find files with identical content.
 *
 * Two-stage filter keeps hashing cheap:
 *   1. Group files by exact byte size. Sizes with only one file are dropped.
 *   2. Only for the remaining candidates, compute a SHA-256 hash of the
 *      content and group by hash. A group is only reported when at least two
 *      files share the SAME HASH — that is the proof of identical content.
 *
 * This module NEVER deletes or changes anything.
 */

const { scanDirectory } = require('./scanner');
const { describeError, sha256File } = require('./utils');

/**
 * Find duplicate groups inside a directory.
 *
 * Returns:
 *   {
 *     root,
 *     groups: [ { hash, hashShort, size, paths: [...] } ],
 *     unhashed: [ { path, reason } ],
 *     stats: { candidateFiles, groupCount, duplicateFileCount, reclaimableBytes }
 *   }
 */
async function findDuplicates(root, options = {}) {
  const inventory = options.inventory || scanDirectory(root, options);

  // Stage 1: bucket by exact file size.
  const bySize = new Map();
  for (const file of inventory.files) {
    if (file.size <= 0) continue; // empty files are never reported as duplicates
    const bucket = bySize.get(file.size) || [];
    bucket.push(file);
    bySize.set(file.size, bucket);
  }

  const groups = [];
  const unhashed = [];
  let candidateFiles = 0;

  // Stage 2: hash only the buckets that have more than one file.
  for (const [size, bucket] of bySize) {
    if (bucket.length < 2) continue;
    candidateFiles += bucket.length;

    const byHash = new Map();
    for (const file of bucket) {
      try {
        const hash = await sha256File(file.path);
        const list = byHash.get(hash) || [];
        list.push(file.path);
        byHash.set(hash, list);
      } catch (error) {
        unhashed.push({ path: file.path, reason: describeError(error) });
      }
    }

    for (const [hash, paths] of byHash) {
      if (paths.length < 2) continue;
      paths.sort((a, b) => a.localeCompare(b));
      groups.push({
        hash,
        hashShort: hash.slice(0, 12),
        size,
        paths,
      });
    }
  }

  groups.sort((a, b) => b.size - a.size || a.paths[0].localeCompare(b.paths[0]));

  let duplicateFileCount = 0;
  let reclaimableBytes = 0;
  for (const group of groups) {
    duplicateFileCount += group.paths.length;
    // Keeping one copy of each group, every extra copy is reclaimable space.
    reclaimableBytes += group.size * (group.paths.length - 1);
  }

  return {
    root: inventory.root,
    groups,
    unhashed,
    stats: {
      candidateFiles,
      groupCount: groups.length,
      duplicateFileCount,
      reclaimableBytes,
    },
  };
}

module.exports = { findDuplicates };
