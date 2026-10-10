'use strict';

/**
 * scanner.js — read-only folder walking.
 *
 * This module NEVER modifies anything. It only lists files, sizes and
 * categories, and collects problems (permissions, missing files, ...) into a
 * "skipped" list instead of crashing.
 */

const fs = require('node:fs');
const path = require('node:path');

const { describeError } = require('./utils');

/** Category -> file extensions (lower case, with leading dot). */
const CATEGORY_EXTENSIONS = {
  Images: [
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico',
    '.tiff', '.tif', '.heic', '.raw', '.cr2', '.nef',
  ],
  Documents: [
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt',
    '.rtf', '.odt', '.ods', '.odp', '.csv', '.md', '.json', '.xml',
    '.pages', '.numbers', '.key',
  ],
  Videos: [
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
    '.mpg', '.mpeg',
  ],
  Audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.aiff'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.cab'],
  Other: [],
};

/** Ordered list of every category name, "Other" last. */
const CATEGORY_NAMES = Object.keys(CATEGORY_EXTENSIONS);

/** Quick lookup: extension -> category. */
const EXTENSION_CATEGORY = new Map();
for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
  for (const extension of extensions) {
    EXTENSION_CATEGORY.set(extension, category);
  }
}

/** Return the category for an extension (".jpg" -> "Images"). Unknown -> "Other". */
function categorize(extension) {
  return EXTENSION_CATEGORY.get(String(extension || '').toLowerCase()) || 'Other';
}

/** Files and folders starting with "." are treated as hidden (Unix style). */
function isHiddenName(name) {
  return name.startsWith('.');
}

/**
 * Recursively scan a directory.
 *
 * Returns:
 *   {
 *     root,                       absolute path that was scanned
 *     files: [ { path, name, ext, size, category, modified } ],
 *     skipped: [ { path, reason } ],
 *     stats: { fileCount, totalSize, dirCount, byCategory, byExtension }
 *   }
 *
 * Throws an Error with code "EINVALIDPATH" when the directory does not exist
 * or is not a directory. Symbolic links are reported and never followed.
 */
function scanDirectory(root, options = {}) {
  const recursive = options.recursive !== false;
  const includeHidden = options.includeHidden === true;

  const resolvedRoot = path.resolve(root);

  let rootStat;
  try {
    rootStat = fs.statSync(resolvedRoot);
  } catch (error) {
    const wrapped = new Error(`Cannot access directory: ${resolvedRoot} (${describeError(error)})`);
    wrapped.code = 'EINVALIDPATH';
    throw wrapped;
  }
  if (!rootStat.isDirectory()) {
    const wrapped = new Error(`Not a directory: ${resolvedRoot}`);
    wrapped.code = 'EINVALIDPATH';
    throw wrapped;
  }

  const files = [];
  const skipped = [];
  const seenFiles = new Set(); // guards against the same physical file appearing twice
  let dirCount = 1; // the root directory itself counts as one

  const pending = [resolvedRoot];
  while (pending.length > 0) {
    const currentDir = pending.pop();

    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: currentDir, reason: describeError(error) });
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (!includeHidden && isHiddenName(entry.name)) {
        skipped.push({ path: fullPath, reason: 'hidden file (use --include-hidden to include)' });
        continue;
      }

      // lstat-style information comes from the Dirent itself: symlinks are
      // detected here and never followed.
      if (entry.isSymbolicLink()) {
        skipped.push({ path: fullPath, reason: 'symbolic link (never followed)' });
        continue;
      }

      if (entry.isDirectory()) {
        dirCount += 1;
        if (recursive) pending.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        skipped.push({ path: fullPath, reason: 'not a regular file (shortcut, device, ...)' });
        continue;
      }

      try {
        const stat = fs.statSync(fullPath);

        // Hard-link / duplicate-entry guard: same device + inode = same file.
        const fileId = stat.ino ? `${stat.dev}:${stat.ino}` : null;
        if (fileId) {
          if (seenFiles.has(fileId)) {
            skipped.push({ path: fullPath, reason: 'same physical file seen earlier (hard link)' });
            continue;
          }
          seenFiles.add(fileId);
        }

        const extension = path.extname(entry.name).toLowerCase();
        files.push({
          path: fullPath,
          name: entry.name,
          ext: extension,
          size: stat.size,
          category: categorize(extension),
          modified: stat.mtime.toISOString(),
        });
      } catch (error) {
        skipped.push({ path: fullPath, reason: describeError(error) });
      }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));

  return {
    root: resolvedRoot,
    files,
    skipped,
    stats: summarize(files, dirCount),
  };
}

/** Build count/size statistics from an inventory. */
function summarize(files, dirCount = 0) {
  const byCategory = {};
  for (const name of CATEGORY_NAMES) byCategory[name] = { count: 0, size: 0 };

  const byExtension = {};
  let totalSize = 0;

  for (const file of files) {
    totalSize += file.size;

    const category = byCategory[file.category] || (byCategory[file.category] = { count: 0, size: 0 });
    category.count += 1;
    category.size += file.size;

    const key = file.ext || '(no extension)';
    const bucket = byExtension[key] || (byExtension[key] = { count: 0, size: 0 });
    bucket.count += 1;
    bucket.size += file.size;
  }

  return {
    fileCount: files.length,
    totalSize,
    dirCount,
    byCategory,
    byExtension,
  };
}

module.exports = {
  scanDirectory,
  summarize,
  categorize,
  CATEGORY_NAMES,
  CATEGORY_EXTENSIONS,
};
