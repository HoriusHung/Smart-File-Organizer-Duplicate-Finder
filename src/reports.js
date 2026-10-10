'use strict';

/**
 * reports.js — export scan / duplicate / plan results to CSV or JSON.
 *
 * Safety rules:
 *   - An existing report file is never overwritten (no silent overwrite).
 *   - Reports are written to a uniquely-named temporary file that is created
 *     exclusively ("wx" flag) and then installed atomically without replacing
 *     anything, so a crash can never leave a half-written report behind, and
 *     the clean-up can only ever remove a file this call created — never a
 *     real user file.
 *   - CSV uses UTF-8 with a BOM so Excel on Windows shows Unicode names
 *     (Vietnamese, emoji, ...) correctly.
 */

const fs = require('node:fs');
const path = require('node:path');

const { makeTempPath, placeFileNoOverwrite, removeOwnTempFile } = require('./utils');

/** Characters that make Excel/Sheets treat a cell as a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@'];

/**
 * Escape one CSV value following RFC 4180.
 * Every value is quoted to keep Windows paths (D:\a, b\c.txt) safe.
 * A leading formula character is neutralised with an apostrophe.
 */
function escapeCsvValue(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_PREFIXES.includes(text[0])) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Build a complete CSV document (with CRLF line endings) from rows. */
function toCsv(rows, columns) {
  const header = columns.map((column) => escapeCsvValue(column.header)).join(',');
  const lines = rows.map((row) =>
    columns.map((column) => escapeCsvValue(column.value(row))).join(',')
  );
  return [header, ...lines].join('\r\n') + '\r\n';
}

/**
 * Where should a report be written?
 * A bare file name ("report.csv") lands inside ./reports/ so generated files
 * stay together and out of Git.
 */
function resolveReportPath(out, baseDir = process.cwd()) {
  const explicit = path.resolve(baseDir, out);
  const hasDirectory = path.dirname(explicit) !== path.resolve(baseDir);
  if (hasDirectory) return explicit;
  return path.join(path.resolve(baseDir, 'reports'), path.basename(out));
}

/** Infer the report format from a file extension. */
function detectFormat(outPath, forcedFormat) {
  if (forcedFormat === 'csv' || forcedFormat === 'json') return forcedFormat;
  return path.extname(outPath).toLowerCase() === '.json' ? 'json' : 'csv';
}

/**
 * Write a report. Refuses to overwrite an existing file.
 *
 * kind:  "inventory" | "duplicates" | "summary" | "organize-plan"
 * data:  array of plain objects
 * columns: for CSV, [ { header, value(row) } ]
 *
 * Returns the absolute path that was written.
 */
function writeReport({ outPath, format, kind, root, data, note, columns }) {
  const absolute = path.resolve(outPath);

  if (fs.existsSync(absolute)) {
    const error = new Error(
      `Refusing to overwrite existing report: ${absolute}\n` +
        `Choose another file name with --out, or delete the old report first.`
    );
    error.code = 'EREPORTEXISTS';
    throw error;
  }

  let content;
  if (format === 'json') {
    const envelope = {
      tool: 'smart-file-organizer',
      version: 1,
      generatedAt: new Date().toISOString(),
      kind,
      root,
      note: note || undefined,
      data,
    };
    content = JSON.stringify(envelope, null, 2);
  } else {
    content = toCsv(data, columns || defaultColumns(kind));
  }

  const directory = path.dirname(absolute);
  fs.mkdirSync(directory, { recursive: true });

  // A unique temporary name that we CREATE EXCLUSIVELY ("wx" fails if the path
  // already exists), so this can never overwrite a real user file sitting next
  // to the report. placeFileNoOverwrite() then installs the finished report
  // without replacing anything either: with a hard link where the filesystem
  // supports one, or with an equally atomic exclusive claim where it does not.
  // A file appearing at the destination in the meantime (rename() would
  // silently replace it) is refused instead of destroyed.
  const temporary = makeTempPath(absolute);
  let createdTemporary = false;
  try {
    // BOM first: makes Excel read UTF-8 correctly on Windows.
    fs.writeFileSync(temporary, format === 'csv' ? `\uFEFF${content}` : content, {
      encoding: 'utf8',
      flag: 'wx',
    });
    createdTemporary = true;
    placeFileNoOverwrite(temporary, absolute);
  } catch (error) {
    // Remove our own temporary file only — never anything pre-existing.
    if (createdTemporary) removeOwnTempFile(temporary);
    throw error;
  }

  return absolute;
}

/** Standard columns for each report kind. */
function defaultColumns(kind) {
  switch (kind) {
    case 'duplicates':
      return [
        { header: 'group_id', value: (row) => row.groupId },
        { header: 'sha256', value: (row) => row.hash },
        { header: 'size_bytes', value: (row) => row.size },
        { header: 'file_count', value: (row) => row.fileCount },
        { header: 'path', value: (row) => row.path },
      ];
    case 'summary':
      return [
        { header: 'metric', value: (row) => row.metric },
        { header: 'value', value: (row) => row.value },
      ];
    case 'organize-plan':
      return [
        { header: 'source', value: (row) => row.from },
        { header: 'destination', value: (row) => row.to },
        { header: 'category', value: (row) => row.category },
        { header: 'status', value: (row) => row.status },
        { header: 'reason', value: (row) => row.reason || '' },
      ];
    case 'inventory':
    default:
      return [
        { header: 'path', value: (row) => row.path },
        { header: 'name', value: (row) => row.name },
        { header: 'extension', value: (row) => row.ext },
        { header: 'size_bytes', value: (row) => row.size },
        { header: 'size_human', value: (row) => row.sizeHuman },
        { header: 'category', value: (row) => row.category },
        { header: 'modified_iso', value: (row) => row.modified },
        { header: 'error', value: (row) => row.error || '' },
      ];
  }
}

/** Flatten an inventory into report rows. */
function inventoryRows(inventory, formatBytes) {
  return inventory.files.map((file) => ({
    ...file,
    sizeHuman: formatBytes(file.size),
  }));
}

/** Flatten duplicate groups into one row per file. */
function duplicateRows(result) {
  const rows = [];
  result.groups.forEach((group, index) => {
    for (const filePath of group.paths) {
      rows.push({
        groupId: index + 1,
        hash: group.hash,
        size: group.size,
        fileCount: group.paths.length,
        path: filePath,
      });
    }
  });
  return rows;
}

/** Flatten the scan statistics into metric/value rows. */
function summaryRows(inventory) {
  const rows = [
    { metric: 'root', value: inventory.root },
    { metric: 'files', value: inventory.stats.fileCount },
    { metric: 'directories', value: inventory.stats.dirCount },
    { metric: 'total_bytes', value: inventory.stats.totalSize },
    { metric: 'skipped_entries', value: inventory.skipped.length },
  ];
  for (const [category, info] of Object.entries(inventory.stats.byCategory)) {
    rows.push({ metric: `category_${category}_files`, value: info.count });
    rows.push({ metric: `category_${category}_bytes`, value: info.size });
  }
  return rows;
}

module.exports = {
  escapeCsvValue,
  toCsv,
  writeReport,
  resolveReportPath,
  detectFormat,
  defaultColumns,
  inventoryRows,
  duplicateRows,
  summaryRows,
};
