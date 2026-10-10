# Smart File Organizer & Duplicate Finder

A **local command-line tool for Windows** (and macOS/Linux) built with **Node.js** and **zero external dependencies**. It scans folders, finds truly identical files using SHA-256 hashes, and organizes files into category folders — always safely, with dry-run previews, explicit confirmation, manifests and undo.

> **Safety first:** this tool has **no delete command and never removes your files as an operation**. Organizing is a preview by default and only happens when you pass `--apply` and type `YES`. The only two clean-up paths are described in [Safety Behavior](#safety-behavior).

---

## Features

- **File scanner** — lists files and sizes, groups them by category and extension, totals counts and sizes, and reports anything it cannot read instead of crashing.
- **Duplicate finder** — uses file size as a cheap pre-filter, then confirms with **SHA-256 content hashes**. Two files are only "duplicates" when their hashes match.
- **Safe organizer** — previews every move (`source -> destination`), detects filename conflicts, refuses to overwrite, and keeps every destination inside the folder you chose.
- **Manifest + undo** — every apply run writes a JSON manifest; `undo` restores the original layout after re-validating every file.
- **Reports** — export inventory, duplicate groups and summaries to **CSV** (Excel-friendly, UTF-8 BOM) or **JSON**.
- **Windows-friendly** — handles paths with spaces, Unicode filenames (Vietnamese, emoji, CJK), permission errors and long paths.

---

## Requirements

- **Node.js 22 or newer** (developed and tested on Node.js 24) — <https://nodejs.org>
- No npm packages to install: the project uses only Node.js built-in modules.

Check your version:

```powershell
node --version
```

## Installation / Setup

```powershell
git clone https://github.com/HoriusHung/Smart-File-Organizer-Duplicate-Finder.git
cd Smart-File-Organizer-Duplicate-Finder
```

Run it directly:

```powershell
node src/cli.js help
```

Optionally make the `organizer` command available everywhere:

```powershell
npm link
organizer help
```

## CLI Examples

```powershell
# What is in this folder?
node src/cli.js scan "D:\Photos"

# Find duplicate files
node src/cli.js duplicates "D:\Downloads"

# Save a report (a bare file name goes into .\reports\)
node src/cli.js duplicates "D:\Downloads" --out duplicates.csv
node src/cli.js scan "D:\Photos" --out inventory.json

# Preview organizing (does NOTHING — this is the default)
node src/cli.js organize "D:\Photos"

# Actually organize (shows the plan, then asks you to type YES)
node src/cli.js organize "D:\Photos" --apply

# Undo an organize run (preview first, then apply)
node src/cli.js undo "D:\Photos\.organizer-manifests\organize-2026-01-01T00-00-00-000Z.json"
node src/cli.js undo "D:\Photos\.organizer-manifests\organize-2026-01-01T00-00-00-000Z.json" --apply
```

### Commands

| Command | What it does |
|---|---|
| `scan <directory>` | Lists files, sizes, categories and totals. Read-only. |
| `duplicates <directory>` | Finds identical files by SHA-256 hash. Read-only. |
| `organize <directory>` | Previews moves. **Default is dry-run — nothing changes.** |
| `organize <directory> --apply` | Moves files after you type `YES`. Writes a manifest. |
| `undo <manifest>` | Previews restoring a previous apply run. |
| `undo <manifest> --apply` | Restores files after you type `YES`. |
| `help` | Shows all commands and options. |

### Options

| Option | Meaning |
|---|---|
| `--dry-run` | Preview only (already the default for `organize` / `undo`). |
| `--apply` | Perform the changes. Always asks you to type `YES`. |
| `--out <file>` | Write a `.csv` or `.json` report. Bare names go to `reports/`. |
| `--json` / `--csv` | Print results as JSON or CSV on the screen. |
| `--no-recursive` | Only look at the top level, do not enter subfolders. |
| `--include-hidden` | Also scan files/folders starting with a dot. |
| `--version` | Prints the version. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Fatal error (invalid path, refused operation, existing report…). |
| `2` | Wrong usage (unknown command or option). |
| `3` | Finished, but some items were skipped (read the `Skipped` list). |

## File Categories

| Category | Examples |
|---|---|
| **Images** | `.jpg .jpeg .png .gif .bmp .webp .svg .ico .tiff .heic .raw .cr2 .nef` |
| **Documents** | `.pdf .doc .docx .xls .xlsx .ppt .pptx .txt .rtf .csv .md .json .xml …` |
| **Videos** | `.mp4 .mkv .avi .mov .wmv .flv .webm .m4v .mpg .mpeg` |
| **Audio** | `.mp3 .wav .flac .aac .ogg .m4a .wma .aiff` |
| **Archives** | `.zip .rar .7z .tar .gz .bz2 .xz .iso .cab` |
| **Other** | everything else, including files with no extension |

Files are placed in `<your folder>\Images`, `<your folder>\Documents`, and so on. Files already inside a category folder are skipped on later runs.

## How Duplicates Are Detected

1. Files are grouped by **exact byte size** — a cheap filter that removes almost everything.
2. Only the remaining candidates are hashed with **SHA-256**, computed with a stream (constant memory, works on very large files).
3. A group is only reported when **at least two files share the same hash**.

Matching hashes confirm identical content. Size alone is never treated as proof. The tool prints the reclaimable space (keeping one copy of each group) and **never deletes anything** — you review the list and decide.

## Safety Behavior

- **Dry-run is the default.** `organize` and `undo` preview unless you pass `--apply`.
- **Explicit confirmation.** `--apply` asks you to type exactly `YES`. Without an interactive terminal the operation is refused.
- **Your files are never deleted as an operation.** There is no delete command, and `scan`, `duplicates` and `organize` previews are read-only. Two narrow clean-up paths do remove files, and both are described exactly below.
- **The one real deletion is gated.** A source file is removed only as the last step of a move, and only after the destination already holds its bytes. On the same drive the destination name is created first with an atomic hard link, so the source is removed only once a second name for the same data exists. Across drives the source is hashed, the copy is made in a private temp file, the copy is hashed, **and the source is re-hashed a final time immediately before it is removed**. Any mismatch — including corruption that keeps the same file size — or a source that changed during the copy means the source is kept, any destination copy this call created is rolled back, and the failure is reported. This only runs inside `--apply` after you type `YES`, and undo reverses it.
- **Clean-up can only touch what the tool just created.** Temp files use collision-resistant names (pid + timestamp + random bytes), are created exclusively (`wx` / `COPYFILE_EXCL`), and are only removed after a check that positively identifies them as this tool's own `.…​.tmp` file. Destinations are installed **without replacing anything**: with a hard link where the filesystem supports one, or with an equally atomic exclusive `wx` claim where it does not, so a file appearing at the destination mid-write is refused instead of silently overwritten. Roll-backs only ever remove a plain file that the current call created itself moments earlier.
- **No silent overwrites.** If `photo.jpg` already exists at the destination, the file is saved as `photo (2).jpg`. If no free name can be found, the move is skipped and reported.
- **Containment.** Both the source and destination are verified to be inside your selected folder before anything moves.
- **No symlink following.** Symbolic links are listed as skipped, never followed.
- **Re-validated at move time.** A file that disappeared or changed between preview and apply is skipped with a reason — not forced.
- **Partial failures are reported honestly.** If 40 of 42 moves succeed, the tool says exactly that (exit code `3`) and lists every skipped file with the reason.
- **Undo is validated.** `undo` refuses to overwrite an occupied original path and refuses to restore a file whose content no longer matches the manifest hash.

## Manifests and Undo

Every `organize --apply` writes one manifest per run:

```
<your folder>\.organizer-manifests\organize-2026-01-01T00-00-00-000Z.json
```

Each entry records `from`, `to`, `size` and `sha256`. Undo checks, for every entry:

1. the moved file still exists at its destination,
2. the original location is free (never overwrites),
3. the file content still matches the recorded hash.

Anything that fails a check is **skipped with an explanation** while the rest are restored.

## Reports

`--out report.csv` / `--out report.json` exports:

- **File inventory** — path, name, extension, size, category, modified time.
- **Duplicate groups** — group id, SHA-256, size, file count, path.
- **Scan summary** — totals and per-category counts/sizes.

Details:

- CSV follows RFC 4180 (quotes doubled, commas/newlines safe) and every field is quoted, so Windows paths stay intact.
- CSV files start with a **UTF-8 BOM** so Excel shows Unicode names correctly.
- Cells starting with `=`, `+`, `-` or `@` are prefixed with `'` to block Excel formula injection.
- **Existing reports are never overwritten** — the tool stops and asks you to pick another name.
- Reports are written to a uniquely-named temp file (created exclusively, so it can never clobber a real file) and then installed without replacing anything — a hard link on normal filesystems, an exclusive `wx` claim where hard links are unavailable. A crash therefore cannot leave a half-written report behind, and a file appearing at the destination is refused, not destroyed.
- A bare file name (e.g. `--out report.csv`) is placed in `./reports/`, which is excluded from Git.

## Testing

```powershell
npm test
# or, without npm:
node scripts/run-tests.js
```

The suite uses `node:test` + `node:assert/strict` and covers: normal scans, empty directories, invalid paths, Unicode filenames, permission errors (POSIX), duplicate content, same-size-different-content, CSV escaping, JSON export, overwrite protection, dry-run making no changes, apply requiring confirmation, destination conflicts, successful undo, tampered manifests, partial failures, and the cross-drive move fallback — successful SHA-256-verified copies, same-size/different-content copies, verification failures that preserve the source, copy failures and their temp-file cleanup, pre-existing destinations, and report-writing failure cleanup.

It also covers the no-clobber guarantees directly: a competing file is dropped into the destination **inside the race window** (through both the hard link and the exclusive claim) and must be refused rather than replaced; a source that cannot be removed must have its destination rolled back; a hash that cannot be read must be reported as inconclusive while keeping the source; a reservation left by a failed rename must be cleaned up. Static checks assert that `src/` contains exactly two guarded deletion helpers, that no deletion targets anything other than the moved source or a destination the current call created, and that `removeOwnTempFile` refuses every name that does not match this tool's own temp-file shape.

`scripts/run-tests.js` passes **explicit file paths** to `node --test`. This keeps the command working on checkout paths that contain spaces or non-ASCII characters, where `node --test <directory>` can fail to resolve.

**Every test builds its own throw-away folder in the OS temp directory and deletes it afterwards.** No test ever touches your real files, the repository, or folders like Downloads/Documents.

## Limitations

- Only files are organized — folders, shortcuts and special items are skipped and reported.
- Empty category folders left behind by an undo are **not** removed (the tool has no folder-removal feature; it only moves files).
- Hidden files (dot-prefixed) are skipped unless you pass `--include-hidden`.
- The organizer works on one root folder at a time; there is no global search across drives.
- `--apply` needs a real terminal; it is refused when input is piped (this is intentional).
- Extremely long paths (> 260 characters) depend on Windows/Node long-path support; such files are reported as skipped rather than crashing the run.
- The cross-drive (EXDEV) branch is exercised in tests by forcing `link()`/`rename()` to report `EXDEV`. A genuine move between two physical volumes (C: → D:) was also run during development and verified by SHA-256 — but on one machine, one filesystem combination, and one file size.
- Neither an atomic hard link nor an exclusive `wx` claim can defend against a process that writes to a path with **non-exclusive** calls (a plain `open('w')`, or `rename()`). No filesystem API can. This tool refuses every collision it can detect, but a third party using those calls can still replace a file in that instant.
- On filesystems without hard links (FAT, exFAT, some network shares) the destination is reserved with an exclusive `wx` claim before the rename. That closes the "did somebody create it first" race, but a crash between the claim and the rename can leave an empty 0-byte file at the destination (never a partial report, and never data loss).
- On a cross-drive move the final SHA-256 re-check and the removal of the source are two separate calls, so a file rewritten in the microseconds between them would escape that last check. The pre-copy hash and the copy's hash still had to match for that point to be reached.
- Verification compares SHA-256 of the source (before and after) against the copy. Like any hash comparison it cannot prove the storage hardware reported correct bytes — only that what was read back matches.
- Development and testing were done on Node.js 24 on Windows. Node.js 22 is the declared minimum but was not itself executed here; compatibility with 22 is a reasoned API-level conclusion, not a test run.

## Project Structure

```
├── bin/organizer.js    # tiny launcher (npm link entry point)
├── src/
│   ├── cli.js          # commands, argument parsing, exit codes
│   ├── scanner.js      # read-only folder walking + categories
│   ├── duplicates.js   # size pre-filter + SHA-256 confirmation
│   ├── organizer.js    # plan, apply, manifest, undo
│   ├── reports.js      # CSV / JSON export
│   └── utils.js        # shared helpers
├── tests/              # node:test suites (temp fixtures only)
├── README.md
└── LICENSE             # MIT
```

## License

MIT — see [LICENSE](LICENSE).
