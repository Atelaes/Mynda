# Diagnostic exports

For the beta, testers can use **Settings → Library → Export Diagnostics…**,
review the resulting ZIP, and email it to the team along with a description
of the problem and approximately when it happened. Mynda saves the ZIP through
the operating system's save dialog. It does not upload reports, send email, or
contact the metadata service during export. Export works without activation.

## Contents

- `diagnostics.json`: app/runtime/OS versions, platform and architecture,
  locally known activation status, server origin, scan/tagging status, media
  tool status, library counts/revision, included log files and export warnings.
- `logs/`: recent `mynda-info`, `mynda-error` and, when present, opt-in UI
  diagnostic logs and their numbered rotations. Unrelated files are excluded.
- `README.txt`: contents/privacy explanation and sharing instructions.
- `library-diagnostic.json`, only if the user checks **Include a diagnostic
  library snapshot**: selected fields and matching evidence for **every active
  and inactive video** from one committed library revision. This checkbox
  defaults to off. No videos are omitted to meet a size limit.

The optional snapshot keeps titles, filenames, kind, year, series/episode
numbers, media metadata, provider/IMDb identities, catalogue ratings, New and
attempted-tagging flags, and tagging evidence/decisions. It omits viewing
history, personal ratings, custom tags, cast, descriptions, artwork, media,
settings and playlists. It is not a restorable library backup; use **Export
Library** for that purpose. Export never changes or forces a save of the library.

## Privacy and size

Exported copies redact known secret fields, the currently accessible license
token, Bearer/Basic authorization, URL credentials/queries/fragments and email
addresses. Configured home, application, profile and watchfolder prefixes use
placeholders such as `[HOME]` and `[WATCHFOLDER_1]`. Original local logs remain
unchanged. Request IDs are retained so a desktop event can be correlated with
the server's retained logs.

This is not anonymization: titles, filenames, nested folder names, server
hostnames and other free-form log text can remain. The UI explains that the
tester should review the ZIP before sharing it. Mynda never copies credential
files, environment variables, media, artwork or crash dumps into the report.

The collector reads at most 8 MiB of recent log input, newest files first, and
keeps complete lines. The optional diagnostic library has no byte or record
cutoff: every active and inactive video is included, with the same field
exclusions and redactions. Records are serialized and compressed incrementally
to avoid constructing another full library object and JSON buffer in memory.
No unredacted library snapshot is written to a temporary file.

A finished ZIP over 18 MiB still saves successfully. Its Settings result shows
the compressed size and recommends sharing a file link if the report exceeds
the tester's email attachment limit. This is an advisory threshold, not a size
cap or a guarantee that smaller attachments will be accepted. The README also
explains sharing by link. The exact ZIP size is known after writing, so this
size note appears in the UI rather than inside `diagnostics.json`.

Log truncation, missing logs and unavailable activation status appear in
`diagnostics.json` and in the export's UI notes. The report's
`limits.libraryBytes` is `null` (no cutoff), and an included snapshot reports
its active/inactive counts and `truncated: false`. Bounded logs can omit the
start of a long session; individually requested logs remain available for
deeper investigations.

The writer creates a private temporary ZIP beside the chosen destination and
renames it only after completion. Failures remove the temporary ZIP and preserve
any previous export. Another export cannot run concurrently. A completed ZIP
can be revealed in the file manager only by the application window that made it.

## Implementation boundaries

- `src/renderer/DiagnosticExport.js`: compact Settings controls and results.
- `src/main/DesktopService.js`: named, trusted-window export/reveal operations.
- `src/main/DiagnosticExport.js`: local log collection, full redacted snapshot and atomic
  ZIP writing, using `yazl` as a production dependency.
- `src/platform/DiagnosticRedaction.js`: redaction of exported copies.

There is no renderer filesystem API or arbitrary path input. The renderer
supplies only the snapshot checkbox. `yauzl` is a development dependency used
to read and verify actual ZIP contents in automated tests.

## Manual check

1. Open Settings → Library, export with the snapshot checkbox off, and open the
   ZIP. Confirm `diagnostics.json`, the logs and README are readable.
2. Repeat with the checkbox on. Confirm `library-diagnostic.json` appears and
   known home/watchfolder prefixes and credentials are absent. Confirm both
   `media.length` and `inactive_media.length` match the corresponding counts in
   `diagnostics.json`, including for a snapshot whose JSON exceeds 8 MiB.
3. Cancel the save dialog, retry, and use **Show in Finder/File Explorer/File
   Manager** on a successful result. Exporting must not require activation.
4. Check the **Mynda** window and macOS application menu labels. After a rebuild,
   confirm the existing library and saved activation still open normally.

`npm run test:diagnostics` covers ZIP contents, redaction, cancellation,
concurrent exports, immutable revisions, full snapshots beyond 8 MiB, advisory
ZIP sizes, bounded logs, missing logs, streaming/write failures and restricted
IPC. `test:core` includes those checks. The source/ASAR
Electron startup suites exercise the real Settings export and visible title;
native macOS menu/keychain presentation still needs a check on macOS.

If email becomes cumbersome, an opt-in **Send Report** action can reuse this
same collector. Upload storage, retention, abuse controls and consent would
belong to that later step rather than silently sending these files now.
