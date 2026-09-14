# Converting existing Mynda libraries to content ID scheme 2

Fix71 strengthens `video.id` while keeping it a content fingerprint. Two copies of the same media receive the same ID, even in independent libraries on different operating systems. The ID is one 64-character SHA-256 hexadecimal string. Library IDs, playlist IDs, and IMDb IDs do not change.

Existing libraries need a one-time conversion on a computer that can read their media. New libraries use the new scheme automatically. The conversion utility is separate from normal startup and scanning; it can be retired after the two test libraries are converted. The fingerprint format and compatibility checks remain part of Mynda.

**Quit every copy of Mynda before preparing or installing a conversion. Keep it closed until installation finishes. After conversion, use the updated source or a newly rebuilt app. An older packaged app does not understand this change and must not open the converted library.**

## First run: your library and Atelaes' library

Each of you should perform these steps on your own computer with your own library and media. You do not exchange converted library files.

1. Keep a copy of your working pre-fix71 source/app for rollback. Quit Mynda, including any packaged copy, and mount all media drives. Avoid moving, editing, or copying over media during conversion.
2. Apply the fix71 changed-files ZIP over the current project. It is based on remote `dev` commit `8c24fee`. Existing dependency installations and staged media tools can be reused; neither an Electron upgrade nor a media-tool rebuild is required.
3. In a terminal in the project directory, run the automated tests:

   ```bash
   npm test
   ```

   These tests use disposable fixtures, not your real library. Expect 34 suites and 282 cases.

4. Prepare the conversion:

   ```bash
   npm run library:migrate
   ```

   This command reads your library and media, preserves the original library, and prepares a separate converted copy. It does **not** replace the live library. The terminal prints the input path, periodic progress, a result, and an output directory.

5. Look for `Result: ready`, then open `report.json` in the printed output directory. Check the active/inactive counts, duplicate-path changes, archived count, and `droppedRecentIDs`. Each entry lists its old ID, new ID, title, and path. A blocked or interrupted conversion cannot be installed.
6. When the report is ready and its changes are acceptable, install it:

   ```bash
   npm run library:migrate -- --install
   ```

   Installation checks that the original library, preserved backup, prepared output, and fingerprinted media still match preparation. It replaces the source using Mynda's flushed, atomic file writer. The preserved original stays in the migration folder.

7. Start the updated development version:

   ```bash
   npm start
   ```

   Check a few edited titles, ratings, series, resume positions, playlists, and Recently Played entries. Run a library scan and check the Duplicates statistics. Files previously mistaken for duplicates may now be discovered as separate videos.

8. Keep the migration folder. Convert the other person's library before using Share between you. Create fresh Share requests; requests and fulfillments from the previous format are deliberately rejected. To use a packaged app again, rebuild it from this updated project with `npm run test:package` before launching it.

The updated app displays **Library Update Required** and quits if it encounters an old library. That is an expected compatibility check, not a damaged-library diagnosis. The dialog shows the actual file requiring conversion.

## Files the utility creates

By default, the output directory is beside the input. For `library.json`, it is `library-id-migration-v2/`.

| File | Purpose |
|---|---|
| `original-library.json` | Exact, unchanged source bytes; keep for rollback |
| `converted-library.json` | Completed library with scheme-2 IDs; exists only after a successful preparation |
| `report.json` | Status, counts, old/new ID mappings, unresolved issues, changed duplicate paths, and removed dangling recent references |
| `checkpoint.json` | Reusable fingerprints and filesystem snapshots for resuming preparation |
| `archived-inactive.json` | Missing inactive records, only if explicitly archived; includes their metadata and the original recent-ID list |

The converted copy retains the records' metadata, including titles, ratings, tags, series grouping, seen state, dates, and playback positions. It remaps `recently_watched` and straightforward playlist comparisons such as `video.id === 'old-id'`. Existing recent IDs with no remaining record are reported and omitted. Ordinary text containing an old ID is not globally replaced.

The utility does not rename or edit media, download metadata, delete duplicates, or change artwork files. Absolute artwork and subtitle references remain as stored. Migration files contain your library's information and paths; they are intended to stay with your local backups.

## If preparation reports `blocked`

The live library is unchanged. Read the issues in `report.json`, resolve them, and rerun preparation with the same input and output to resume. Unchanged files reuse their fingerprints after filesystem checks. A new run rebuilds the report and removes any previous prepared copy before starting, so a stale result cannot look complete.

### Missing active videos

Every active record needs readable media. Mount its drive or restore the file. A renamed or moved file can be linked explicitly using the option below. The tool never drops missing active records automatically.

For a permanently deleted active file, resolve the record in the old version using the original library before converting. If the source library changes, use a fresh `--output` directory for the next attempt. Preserve the previous migration directory.

### Missing inactive videos

Inactive records can contain edits and viewing history even though their files are no longer available. By default these block conversion too: an old partial hash cannot reveal the new fingerprint without the original media.

If these files are permanently gone and you want to keep their records outside the working library, explicitly prepare with:

```bash
npm run library:migrate -- --archive-missing-inactive
```

This moves only missing inactive entries into `archived-inactive.json` in the prepared result. Permission failures, unreadable DVD structures, and missing active records still block conversion. The original library remains intact. Review the archived count before installing with the ordinary `--install` command.

**Archived records will no longer be available inside Mynda. If a file returns later, a scan treats it as new; its old metadata is retained in the archive for manual recovery, not automatically reattached.** Do not archive entries just because their drive is temporarily disconnected.

### Moved or renamed files

Create a JSON file containing exact old-path/new-path pairs. For example, `relinks.json`:

```json
{
  "/Volumes/Movies/Old name.mkv": "/Volumes/Movies/New name.mkv",
  "/Volumes/Movies/Old DVD folder": "/Volumes/Movies/New DVD folder"
}
```

Then run:

```bash
npm run library:migrate -- --relink "/absolute/path/relinks.json"
```

These are explicit mappings, not filename guesses. The replacement's bytes establish the new ID. The map can also repair a stored duplicate path. It changes the record's media path only; watchfolder settings, artwork paths, and subtitle paths are not relocated automatically. On Windows, JSON backslashes must be doubled, or use forward slashes in absolute paths.

### Conflicting records or unusual playlists

Conversion stops if one old ID maps to different new IDs, or if multiple stored records produce the same new ID. These cases need a decision about their metadata and references; the tool does not choose a winner or merge them silently.

Simple ID equality/inequality filters are rewritten automatically. More complex ID expressions, calculated video property names, or references to unresolved IDs require review. A populated retired `object_media` index also requires review. Keep the report and original so these cases can be resolved deliberately before retrying.

### Duplicate paths that no longer match

The `duplicates` arrays are checked using the new fingerprints. Only readable paths whose IDs match the library copy remain in the converted arrays. Different or unavailable paths are listed in `report.json` and preserved in the original library. They do not block otherwise valid records, because duplicates themselves are not library entries.

The migration does not create video records for newly distinguished files or copy the original video's metadata onto them. The next normal watchfolder scan discovers those files using the new IDs. Reconnect unavailable duplicate drives before that scan.

## Choosing an input or output

The default input is Mynda's platform-specific live library:

| Platform | Default location |
|---|---|
| macOS | `~/Library/Application Support/mynda/Library/library.json` |
| Windows | `%APPDATA%\mynda\Library\library.json` |
| Linux | `$XDG_CONFIG_HOME/mynda/Library/library.json`, or `~/.config/mynda/Library/library.json` when unset |

If Mynda shows a different path, pass that exact path. You can also prepare a manual export first as a rehearsal:

```bash
npm run library:migrate -- --input "/absolute/path/library.json" --output "/absolute/path/conversion-review"
```

Use the same input/output paths for installation:

```bash
npm run library:migrate -- --input "/absolute/path/library.json" --output "/absolute/path/conversion-review" --install
```

`--install` replaces the specified input, not some other live library. Installing a manual export therefore changes only that export. Relinking and archiving are preparation options; omit those flags during installation because they are already reflected in the validated copy.

For all options, run `npm run library:migrate -- --help`.

## Interruption, installation failure, and rollback

Press Ctrl+C once to request cancellation. The tool finishes the current filesystem operation, records an interrupted result, and saves its checkpoint. Rerun the same preparation command, including any relinking/archiving flags, to resume. A forced process kill can lose the most recent checkpoint batch, but does not replace the source during preparation.

If you edit the source library, its exact-byte check fails instead of mixing two versions. Keep the existing migration folder and supply a fresh `--output` directory. If media changes after preparation, rerun preparation before installation. Do not edit `checkpoint.json`, `converted-library.json`, or the preserved original to bypass checks.

Keep Mynda closed throughout preparation and installation. The utility checks the source again immediately before replacing it, but does not lock out an already running older app. Do not run multiple conversion processes against the same library/output folder at once.

For rollback, quit Mynda, retain a copy of the converted library and migration report, and copy `original-library.json` back to the original live-library path. Use the compatible pre-fix71 application with that original. Restoring the original also rolls back any edits made after conversion, so preserve both versions if those edits matter. The converted library requires fix71 or later; an older app must never save it.

Existing backups are not rewritten wholesale. Restoring a pre-conversion backup into the new app requires converting that backup first. If startup names a backup because the primary is damaged, keep the damaged primary and follow the backup path shown in the dialog; do not overwrite it with an unreviewed file.

## The permanent fingerprint recipe

Normal scans and migration call the same `src/library/ContentFingerprint.js` implementation. Libraries store `videoIdScheme: 2`; Share manifests use version 2 and also declare that scheme.

For an ordinary file, the hash includes its exact byte size and five 256 KiB blocks distributed across it. That reads at most 1.25 MiB of video data, plus filesystem metadata. Files at or below 1.25 MiB are read completely. For larger files, block starts are `floor((size - 262144) * i / 4)` for `i = 0, 1, 2, 3, 4`. These are positions across the byte stream, not playback timestamps.

For DVDs, every IFO, BUP, and VOB playback file participates. IFO/BUP control files are read completely; each VOB uses the same sampled-file recipe. Their normalized relative names, exact sizes, and individual hashes are combined into one DVD ID. A disc root with a `VIDEO_TS` child and the same playback folder supplied directly produce the same ID. Names within the playback tree are uppercased, `/` separates components, and names are sorted by code-unit order. Extra artwork, external subtitles, outer folder names, absolute paths, and timestamps do not participate. Ambiguous layouts and symlink media are rejected.

Every hash input field is framed with an unsigned 64-bit big-endian byte-length prefix. Text uses UTF-8; numeric fields are decimal ASCII. The first two fields are `mynda-content-id-v2` and a type: `sampled-file`, `complete-playback-file`, or `dvd`. A file then frames its size, range count, and each range's offset, length, and bytes. A DVD frames its playback-file count, summed size, then each sorted file's normalized name, size, and lowercase hexadecimal subhash. The final lowercase SHA-256 hex digest itself is `video.id`.

The format is fixed across operating systems. Golden test vectors pin its results independently of the implementation. Do not change its tag, sampling, framing, DVD inclusion rules, or normalization under scheme 2; a future recipe needs a new scheme version.

**This is still a sampled fingerprint, not a full-file integrity checksum.** Two same-size videos differing only outside the sampled blocks can share an ID. The stronger sampling greatly improves on the old beginning-only fingerprint, but does not eliminate that limitation. Mynda continues using ID equality alone for duplicate detection as agreed; Share's existing full-file transfer checksums remain separate. Re-encoding or changing container bytes can produce a different ID even when the visible movie is the same.

Checkpoint timestamps and filesystem identifiers are used only to decide whether a local migration result can be reused. They are never included in the content ID. Preparation performs bounded asynchronous reads and reports progress, but speed still depends on disk seeks, DVD file counts, and storage availability.
