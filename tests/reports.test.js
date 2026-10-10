'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { escapeCsvValue, toCsv, writeReport, resolveReportPath, detectFormat } = require('../src/reports');
const { makeTempDir, writeFile, cleanup } = require('./helpers');

test('csv: comma inside a value is quoted', () => {
  assert.equal(escapeCsvValue('a,b'), '"a,b"');
});

test('csv: quote inside a value is doubled', () => {
  assert.equal(escapeCsvValue('say "hi"'), '"say ""hi"""');
});

test('csv: windows path with backslashes and comma stays one field', () => {
  const value = 'D:\\My Photos\\holiday, 2026\\a.jpg';
  assert.equal(escapeCsvValue(value), '"D:\\My Photos\\holiday, 2026\\a.jpg"');
});

test('csv: newline inside a value is preserved inside quotes', () => {
  const csv = toCsv([{ name: 'line1\nline2' }], [{ header: 'name', value: (row) => row.name }]);
  assert.ok(csv.includes('"line1\nline2"'));
  assert.ok(csv.endsWith('\r\n'));
});

test('csv: unicode content survives round-trip', () => {
  const csv = toCsv([{ name: 'héllo – Ảnh 新版 😀' }], [{ header: 'name', value: (row) => row.name }]);
  assert.ok(csv.includes('héllo – Ảnh 新版 😀'));
});

test('csv: leading formula characters are neutralised', () => {
  assert.equal(escapeCsvValue('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(escapeCsvValue('-cmd'), '"\'-cmd"');
  assert.equal(escapeCsvValue('@import'), '"\'@import"');
  assert.equal(escapeCsvValue('+1'), '"\'+1"');
});

test('csv: null and undefined become empty quoted fields', () => {
  assert.equal(escapeCsvValue(null), '""');
  assert.equal(escapeCsvValue(undefined), '""');
});

test('json: envelope is valid and preserves unicode', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const target = path.join(dir, 'out.json');
  writeReport({
    outPath: target,
    format: 'json',
    kind: 'inventory',
    root: 'D:\\Test',
    data: [{ path: 'D:\\Test\\tệp tin 新版.txt' }],
  });
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(parsed.tool, 'smart-file-organizer');
  assert.equal(parsed.kind, 'inventory');
  assert.equal(parsed.data[0].path, 'D:\\Test\\tệp tin 新版.txt');
});

test('reports: refuse to overwrite an existing file', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const target = path.join(dir, 'existing.csv');
  fs.writeFileSync(target, 'original');

  assert.throws(
    () =>
      writeReport({
        outPath: target,
        format: 'csv',
        kind: 'summary',
        root: dir,
        data: [{ metric: 'files', value: 1 }],
      }),
    (error) => error.code === 'EREPORTEXISTS'
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});

test('reports: written CSV starts with a BOM and is UTF-8', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const target = path.join(dir, 'out.csv');

  writeReport({
    outPath: target,
    format: 'csv',
    kind: 'inventory',
    root: dir,
    data: [{ path: 'D:\\x\\bản báo cáo.txt', name: 'bản báo cáo.txt', ext: '.txt', size: 3, sizeHuman: '3 B', category: 'Documents', modified: 'now' }],
  });

  const raw = fs.readFileSync(target);
  assert.equal(raw[0], 0xef); // UTF-8 BOM so Excel reads Unicode correctly
  assert.equal(raw[1], 0xbb);
  assert.equal(raw[2], 0xbf);
  assert.ok(raw.toString('utf8').includes('bản báo cáo.txt'));
  // No leftover temp file of any name (the temp file uses a unique name now).
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('reports: never overwrites or deletes a pre-existing user file', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  const target = path.join(dir, 'out.csv');
  // A user file that happens to sit exactly where the old temp name pointed.
  const decoy = path.join(dir, 'out.csv.tmp');
  fs.writeFileSync(decoy, 'PRECIOUS USER DATA');

  writeReport({
    outPath: target,
    format: 'csv',
    kind: 'summary',
    root: dir,
    data: [{ metric: 'files', value: 1 }],
  });

  assert.ok(fs.existsSync(target));
  // The decoy survived untouched: the temp file is created exclusively under a
  // unique name, so it can never clobber (or later delete) a user file.
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'PRECIOUS USER DATA');
});

test('reports: a report that already exists is not written and leaves no temp file', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  const target = path.join(dir, 'out.json');
  fs.writeFileSync(target, 'ORIGINAL');

  assert.throws(
    () => writeReport({ outPath: target, format: 'json', kind: 'summary', root: dir, data: [] }),
    (error) => error.code === 'EREPORTEXISTS'
  );

  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('reports: a failure while installing the report cleans up only its own temp file', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  const target = path.join(dir, 'out.csv');
  // A user file that must survive the whole failed operation untouched.
  const bystander = path.join(dir, 'bystander.csv');
  fs.writeFileSync(bystander, 'DO NOT TOUCH');

  // Make the placement step fail the way a full disk or broken link would.
  const originalLink = fs.linkSync;
  fs.linkSync = () => {
    const error = new Error('EIO: i/o error, link');
    error.code = 'EIO';
    throw error;
  };
  t.after(() => {
    fs.linkSync = originalLink;
  });

  assert.throws(
    () => writeReport({ outPath: target, format: 'csv', kind: 'summary', root: dir, data: [{ metric: 'x', value: 1 }] }),
    /EIO/
  );

  assert.equal(fs.readFileSync(bystander, 'utf8'), 'DO NOT TOUCH');
  assert.ok(!fs.existsSync(target), 'an incomplete report must not be left at the destination');
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
    'the temp file created by this call must be cleaned up'
  );
});

test('reports: a destination appearing mid-write is refused, not overwritten', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));

  const target = path.join(dir, 'out.csv');

  // Simulate another process creating the report between our check and our
  // install: linkSync() then fails with EEXIST instead of replacing it.
  const originalLink = fs.linkSync;
  fs.linkSync = (from, to) => {
    fs.writeFileSync(to, 'RACED IN BY SOMEONE ELSE');
    const error = new Error(`EEXIST: file already exists, link '${from}' -> '${to}'`);
    error.code = 'EEXIST';
    throw error;
  };
  t.after(() => {
    fs.linkSync = originalLink;
  });

  assert.throws(
    () => writeReport({ outPath: target, format: 'csv', kind: 'summary', root: dir, data: [{ metric: 'x', value: 1 }] }),
    /EEXIST/
  );

  assert.equal(fs.readFileSync(target, 'utf8'), 'RACED IN BY SOMEONE ELSE');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('reports: empty data still produces a valid file', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const target = path.join(dir, 'empty.json');

  writeReport({ outPath: target, format: 'json', kind: 'duplicates', root: dir, data: [] });
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(parsed.data, []);
});

test('reports: resolveReportPath puts bare names into reports/', () => {
  const resolved = resolveReportPath('report.csv', 'D:\\somewhere');
  assert.equal(resolved, path.join('D:\\somewhere', 'reports', 'report.csv'));

  const explicit = resolveReportPath(path.join('D:\\other', 'report.csv'), 'D:\\somewhere');
  assert.equal(explicit, path.join('D:\\other', 'report.csv'));
});

test('reports: format is detected from the extension and can be forced', () => {
  assert.equal(detectFormat('a.json'), 'json');
  assert.equal(detectFormat('a.csv'), 'csv');
  assert.equal(detectFormat('a.txt'), 'csv');
  assert.equal(detectFormat('a.txt', 'json'), 'json');
});

test('reports: csv file written next to unicode temp dirs', (t) => {
  const dir = makeTempDir('sfo-báo cáo-😀-');
  t.after(() => cleanup(dir));
  const target = path.join(dir, 'kết quả.csv');

  writeReport({
    outPath: target,
    format: 'csv',
    kind: 'summary',
    root: dir,
    data: [
      { metric: 'root', value: dir },
      { metric: 'files', value: 2 },
    ],
  });

  const text = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '');
  assert.ok(text.includes('"root"'));
  assert.ok(text.includes('"2"'));
});
