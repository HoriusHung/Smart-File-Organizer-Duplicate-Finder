'use strict';

/**
 * Shared test helpers: every test gets its own throw-away folder inside the
 * OS temp directory. Nothing ever touches a real user folder.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Create a unique temporary directory. */
function makeTempDir(prefix = 'sfo-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a file (creating parent folders) and return its full path. */
function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

/** Recursively list every file path under a root (sorted, for comparison). */
function listFiles(root) {
  const results = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else results.push(fullPath);
    }
  };
  walk(root);
  return results.sort((a, b) => a.localeCompare(b));
}

/** Snapshot of a directory: every file path mapped to its content. */
function snapshot(root) {
  const map = new Map();
  for (const filePath of listFiles(root)) {
    map.set(filePath, fs.readFileSync(filePath, 'utf8'));
  }
  return map;
}

/** Remove a temp directory, restoring permissions so Windows can delete it. */
function cleanup(dir) {
  try {
    walkAndUnchmod(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Best effort: temp folders are cleaned by the OS eventually.
  }
}

function walkAndUnchmod(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) {
        fs.chmodSync(fullPath, 0o700);
        walkAndUnchmod(fullPath);
      } else {
        fs.chmodSync(fullPath, 0o600);
      }
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { makeTempDir, writeFile, listFiles, snapshot, cleanup };
