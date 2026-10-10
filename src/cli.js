'use strict';

/**
 * cli.js — command line interface.
 *
 * Commands:
 *   scan <directory>        list files, sizes, categories and totals
 *   duplicates <directory>  find identical files using SHA-256
 *   organize <directory>    preview (default) or --apply moves + manifest
 *   undo <manifest>         restore files recorded in a manifest
 *
 * Exit codes:
 *   0  success
 *   1  fatal error (invalid path, refused operation, report exists, ...)
 *   2  wrong usage (unknown command or flag)
 *   3  finished, but some items were skipped
 */

const fs = require('node:fs');
const path = require('node:path');

const { scanDirectory } = require('./scanner');
const { findDuplicates } = require('./duplicates');
const { buildPlan, applyPlan, undoManifest, readManifest, formatPlanLines, formatPlanSummary } = require('./organizer');
const reports = require('./reports');
const { formatBytes, confirm, isInsideRoot } = require('./utils');

const EXIT_OK = 0;
const EXIT_FATAL = 1;
const EXIT_USAGE = 2;
const EXIT_PARTIAL = 3;

const KNOWN_FLAGS = new Set([
  'help', 'h', 'version', 'v', 'dry-run', 'apply', 'json', 'csv',
  'out', 'no-recursive', 'include-hidden',
]);

const HELP = `
Smart File Organizer & Duplicate Finder

Usage:
  node src/cli.js <command> <directory> [options]

Commands:
  scan <directory>          List files, sizes, categories and totals
  duplicates <directory>    Find identical files (SHA-256 content check)
  organize <directory>      Preview moves (default) or apply them
  undo <manifest>           Restore files recorded in an organize manifest
  help                      Show this help

Options:
  --dry-run                 Preview only (this is the DEFAULT for organize/undo)
  --apply                   Actually perform changes (asks you to type YES)
  --out <file>              Write a report to a file (.csv or .json)
                            Bare file names are placed in the reports/ folder
  --json                    Print results as JSON on the screen
  --csv                     Print results as CSV on the screen
  --no-recursive            Do not enter subfolders
  --include-hidden          Also scan files/folders starting with a dot
  --version                 Print the version

Examples:
  node src/cli.js scan "D:\\Photos"
  node src/cli.js duplicates "D:\\Downloads" --out dupes.csv
  node src/cli.js organize "D:\\Photos"
  node src/cli.js organize "D:\\Photos" --apply
  node src/cli.js undo "D:\\Photos\\.organizer-manifests\\organize-....json" --apply

Safety:
  This tool NEVER deletes files.
  Organizing is preview-only unless you pass --apply AND type YES.
  Every apply run writes a manifest that the undo command can restore.
`.trim();

/** Parse argv into { command, positional[], flags:Set, options{} }. */
function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw usageError('Option --out needs a file name, for example: --out report.csv');
      }
      options.out = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--out=')) {
      const value = argument.slice('--out='.length);
      if (!value) throw usageError('Option --out needs a file name, for example: --out report.csv');
      options.out = value;
      continue;
    }
    if (argument.startsWith('--')) {
      const name = argument.slice(2);
      if (!KNOWN_FLAGS.has(name)) {
        throw usageError(`Unknown option: ${argument}\nRun "node src/cli.js help" to see the available options.`);
      }
      flags.add(name);
      continue;
    }
    if (argument.startsWith('-') && argument !== '-') {
      const name = argument.slice(1);
      if (!KNOWN_FLAGS.has(name)) {
        throw usageError(`Unknown option: ${argument}\nRun "node src/cli.js help" to see the available options.`);
      }
      flags.add(name);
      continue;
    }
    positional.push(argument);
  }

  return { command: positional[0], positional: positional.slice(1), flags, options };
}

function usageError(message) {
  const error = new Error(message);
  error.code = 'EUSAGE';
  return error;
}

function printError(message) {
  process.stderr.write(`\x1b[31mError:\x1b[0m ${message}\n`);
}

function printInfo(message) {
  process.stdout.write(`${message}\n`);
}

/** Shared helper: build + write the report requested with --out. */
function exportReport(options, kind, root, data, columns, note) {
  if (!options.out) return null;
  const target = reports.resolveReportPath(options.out);
  const format = reports.detectFormat(target, options.csv ? 'csv' : options.json ? 'json' : null);
  const written = reports.writeReport({ outPath: target, format, kind, root, data, note, columns });
  printInfo(`Report written: ${written}`);
  return written;
}

/* ------------------------------------------------------------------ scan */

async function commandScan(parsed) {
  const directory = requireDirectory(parsed);
  const inventory = scanDirectory(directory, {
    recursive: !parsed.flags.has('no-recursive'),
    includeHidden: parsed.flags.has('include-hidden'),
  });

  if (parsed.flags.has('json') && !parsed.options.out) {
    printInfo(JSON.stringify(inventory, null, 2));
    return printSkipped(inventory.skipped) ? EXIT_PARTIAL : EXIT_OK;
  }
  if (parsed.flags.has('csv') && !parsed.options.out) {
    process.stdout.write(reports.toCsv(reports.inventoryRows(inventory, formatBytes), reports.defaultColumns('inventory')));
    return printSkipped(inventory.skipped) ? EXIT_PARTIAL : EXIT_OK;
  }

  printInfo('');
  printInfo(`Scan of: ${inventory.root}`);
  printInfo(`  Files:       ${inventory.stats.fileCount}`);
  printInfo(`  Directories: ${inventory.stats.dirCount}`);
  printInfo(`  Total size:  ${formatBytes(inventory.stats.totalSize)}`);

  printInfo('');
  printInfo('By category:');
  for (const [category, info] of Object.entries(inventory.stats.byCategory)) {
    if (info.count === 0) continue;
    printInfo(`  ${category.padEnd(10)} ${String(info.count).padStart(6)} file(s)  ${formatBytes(info.size).padStart(10)}`);
  }

  const extensions = Object.entries(inventory.stats.byExtension).sort((a, b) => b[1].size - a[1].size);
  if (extensions.length > 0) {
    printInfo('');
    printInfo('By extension:');
    for (const [extension, info] of extensions.slice(0, 15)) {
      printInfo(`  ${extension.padEnd(10)} ${String(info.count).padStart(6)} file(s)  ${formatBytes(info.size).padStart(10)}`);
    }
    if (extensions.length > 15) printInfo(`  ... and ${extensions.length - 15} more extensions`);
  }

  exportReport(parsed.options, 'inventory', inventory.root, reports.inventoryRows(inventory, formatBytes), reports.defaultColumns('inventory'));

  const hasSkipped = printSkipped(inventory.skipped);
  printInfo('Nothing was changed. This command only reads files.');
  return hasSkipped ? EXIT_PARTIAL : EXIT_OK;
}

/* ------------------------------------------------------------ duplicates */

async function commandDuplicates(parsed) {
  const directory = requireDirectory(parsed);
  const result = await findDuplicates(directory, {
    recursive: !parsed.flags.has('no-recursive'),
    includeHidden: parsed.flags.has('include-hidden'),
  });

  if (parsed.flags.has('json') && !parsed.options.out) {
    printInfo(JSON.stringify(result, null, 2));
    return EXIT_OK;
  }
  if (parsed.flags.has('csv') && !parsed.options.out) {
    process.stdout.write(reports.toCsv(reports.duplicateRows(result), reports.defaultColumns('duplicates')));
    return EXIT_OK;
  }

  printInfo('');
  printInfo(`Duplicate search in: ${result.root}`);
  printInfo('Duplicates are identified by matching SHA-256 hashes, which confirm');
  printInfo('identical file content. File size is only a first-pass pre-filter.');

  if (result.groups.length === 0) {
    printInfo('');
    printInfo('No duplicate files found.');
  } else {
    result.groups.forEach((group, index) => {
      printInfo('');
      printInfo(`Group ${index + 1} — ${group.paths.length} identical file(s), ${formatBytes(group.size)} each`);
      printInfo(`  SHA-256: ${group.hash}`);
      for (const filePath of group.paths) printInfo(`  - ${filePath}`);
    });
    printInfo('');
    printInfo(
      `Potential space reclaimable: ${formatBytes(result.stats.reclaimableBytes)} ` +
        `across ${result.stats.groupCount} group(s), ${result.stats.duplicateFileCount} file(s) total.`
    );
    printInfo('This tool never deletes duplicates — review the list and decide yourself.');
  }

  exportReport(parsed.options, 'duplicates', result.root, reports.duplicateRows(result), reports.defaultColumns('duplicates'));

  if (result.unhashed.length > 0) {
    printInfo('');
    printInfo(`Could not hash ${result.unhashed.length} file(s); those files are excluded from the totals:`);
    for (const entry of result.unhashed.slice(0, 10)) printInfo(`  ${entry.path} — ${entry.reason}`);
  }

  return EXIT_OK;
}

/* ------------------------------------------------------------ organize */

async function commandOrganize(parsed) {
  const directory = requireDirectory(parsed);
  const apply = parsed.flags.has('apply');

  const plan = buildPlan(directory, {
    recursive: !parsed.flags.has('no-recursive'),
    includeHidden: parsed.flags.has('include-hidden'),
  });

  printInfo('');
  printInfo(`Organize plan for: ${plan.root}`);
  printInfo(`Summary: ${formatPlanSummary(plan)}`);
  printInfo('');
  if (plan.moves.length === 0) {
    printInfo('Nothing to organize.');
  } else {
    printInfo(apply ? 'Files that WILL be moved:' : 'Files that WOULD be moved:');
    for (const line of formatPlanLines(plan)) printInfo(line);
  }

  exportReport(
    parsed.options,
    'organize-plan',
    plan.root,
    plan.moves.map((move) => ({ ...move, status: apply ? 'planned' : 'preview', reason: '' })),
    reports.defaultColumns('organize-plan')
  );

  if (!apply) {
    printInfo('');
    printInfo('DRY RUN — nothing was changed.');
    if (plan.moves.length > 0) {
      printInfo('To perform these moves, run:');
      printInfo(`  node src/cli.js organize "${plan.root}" --apply`);
    }
    const hasSkipped = printSkipped(plan.skipped);
    return hasSkipped ? EXIT_PARTIAL : EXIT_OK;
  }

  if (plan.moves.length === 0) {
    return EXIT_OK;
  }

  printInfo('');
  printInfo(`About to move ${plan.moves.length} file(s) into "${plan.root}".`);
  const approved = await confirm('Type YES to continue, anything else cancels:');
  if (!approved) {
    printInfo(process.stdin.isTTY ? 'Cancelled — nothing was changed.' : 'Cancelled — an interactive terminal is required for --apply.');
    return process.stdin.isTTY ? EXIT_OK : EXIT_FATAL;
  }

  const result = await applyPlan(plan, { confirmFn: async () => true });

  printInfo('');
  printInfo(`Moved ${result.counts.moved} of ${result.counts.planned} planned file(s).`);
  if (result.manifestPath) printInfo(`Manifest written: ${result.manifestPath}`);
  if (result.counts.skipped > 0) {
    printInfo('');
    printInfo(`WARNING: ${result.counts.skipped} file(s) were NOT moved:`);
    for (const entry of result.skipped) printInfo(`  ${entry.path} — ${entry.reason}`);
  } else {
    printInfo('All planned moves completed successfully.');
  }
  return result.counts.skipped > 0 ? EXIT_PARTIAL : EXIT_OK;
}

/* ----------------------------------------------------------------- undo */

async function commandUndo(parsed) {
  const manifestPath = parsed.positional[0];
  if (!manifestPath) throw usageError('Usage: undo <manifest> [--apply]\nExample: undo ".organizer-manifests/organize-2026-01-01T00-00-00-000Z.json"');
  if (!fs.existsSync(path.resolve(manifestPath))) {
    throw fatalError(`Manifest not found: ${path.resolve(manifestPath)}`);
  }

  const apply = parsed.flags.has('apply');

  // Validate BEFORE showing anything or asking anything.
  const manifest = readManifest(manifestPath);

  if (!apply) {
    const checks = manifest.moves.map((entry) => ({ entry, status: describeUndoCheck(manifest.root, entry) }));
    printInfo('');
    printInfo(`Undo preview for: ${manifest.manifestPath}`);
    printInfo(`  Created at:  ${manifest.createdAt}`);
    printInfo(`  Organized:   ${manifest.root}`);
    printInfo(`  Moves:       ${manifest.moves.length}`);
    printInfo('');
    const restorable = checks.filter((check) => check.status === null);
    const blocked = checks.filter((check) => check.status !== null);
    printInfo(`Could restore ${restorable.length} file(s):`);
    for (const check of restorable.slice(0, 50)) printInfo(`  ${check.entry.to}  ->  ${check.entry.from}`);
    if (blocked.length > 0) {
      printInfo('');
      printInfo(`Would skip ${blocked.length} file(s):`);
      for (const check of blocked.slice(0, 50)) printInfo(`  ${check.entry.to} — ${check.status}`);
    }
    printInfo('');
    printInfo('DRY RUN — nothing was changed.');
    printInfo(`To restore, run: node src/cli.js undo "${manifest.manifestPath}" --apply`);
    return EXIT_OK;
  }

  printInfo('');
  printInfo(`About to restore ${manifest.moves.length} file(s) in "${manifest.root}".`);
  const approved = await confirm('Type YES to continue, anything else cancels:');
  if (!approved) {
    printInfo(process.stdin.isTTY ? 'Cancelled — nothing was changed.' : 'Cancelled — an interactive terminal is required for --apply.');
    return process.stdin.isTTY ? EXIT_OK : EXIT_FATAL;
  }

  const result = await undoManifest(manifest, { confirmFn: async () => true });

  printInfo('');
  printInfo(`Restored ${result.counts.restored} of ${result.counts.planned} file(s).`);
  if (result.counts.skipped > 0) {
    printInfo('');
    printInfo(`WARNING: ${result.counts.skipped} file(s) were NOT restored:`);
    for (const entry of result.skipped) printInfo(`  ${entry.path} — ${entry.reason}`);
  }
  return result.counts.skipped > 0 ? EXIT_PARTIAL : EXIT_OK;
}

/** Return null when an entry can be restored, or the reason it cannot. */
function describeUndoCheck(root, entry) {
  const from = path.resolve(entry.from);
  const to = path.resolve(entry.to);
  if (!isInsideRoot(root, from) || !isInsideRoot(root, to)) {
    return 'path is outside the organized folder — refused';
  }
  if (!fs.existsSync(to)) return 'moved file no longer exists at its destination';
  if (fs.existsSync(from)) return 'original location is now occupied — refusing to overwrite';
  return null;
}

/* --------------------------------------------------------------- helpers */

function requireDirectory(parsed) {
  const directory = parsed.positional[0];
  if (!directory) {
    throw usageError('Missing directory.\nUsage: node src/cli.js <command> <directory>\nExample: node src/cli.js scan "D:\\Photos"');
  }
  return directory;
}

function fatalError(message) {
  const error = new Error(message);
  error.code = 'EFATAL';
  return error;
}

/** Print skipped entries (max 20). Returns true when there were any. */
function printSkipped(skipped) {
  if (!skipped || skipped.length === 0) return false;
  printInfo('');
  printInfo(`Skipped ${skipped.length} entr(y/ies) that could not be processed:`);
  for (const entry of skipped.slice(0, 20)) printInfo(`  ${entry.path} — ${entry.reason}`);
  if (skipped.length > 20) printInfo(`  ... and ${skipped.length - 20} more`);
  return true;
}

/** Parse + dispatch. Returns the exit code. */
async function runCli(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    printError(error.message);
    return EXIT_USAGE;
  }

  if (parsed.flags.has('version')) {
    printInfo(require('../package.json').version);
    return EXIT_OK;
  }
  if (!parsed.command || parsed.flags.has('help') || parsed.flags.has('h') || parsed.command === 'help') {
    printInfo(HELP);
    return EXIT_OK;
  }

  try {
    switch (parsed.command) {
      case 'scan':
        return await commandScan(parsed);
      case 'duplicates':
        return await commandDuplicates(parsed);
      case 'organize':
        return await commandOrganize(parsed);
      case 'undo':
        return await commandUndo(parsed);
      default:
        printError(`Unknown command: ${parsed.command}\nRun "node src/cli.js help" to see the available commands.`);
        return EXIT_USAGE;
    }
  } catch (error) {
    printError(error.message);
    return error.code === 'EUSAGE' ? EXIT_USAGE : EXIT_FATAL;
  }
}

module.exports = { runCli, parseArgs, HELP };

/* istanbul ignore next */
if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
