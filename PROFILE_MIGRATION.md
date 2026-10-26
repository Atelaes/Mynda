# Mynda profile and portable artwork migration

The package name remains `mynda`. Top-level `productName: "Mynda"` supplies
Electron's runtime name, default profile name and native package display name.
The bundle ID remains `com.torvor.mynda`. Existing development installations
need this explicit offline migration; new installations need no conversion.

## Prepare and install

Quit every Mynda instance, including development runs. Keep the app closed
through both steps. Choose a new private backup directory outside the profile
and outside the source repository; allow space for three additional profile
copies during installation.

```bash
npm run profile:migrate -- --output "/absolute/path/mynda-profile-backup" --app-closed
```

The command copies the entire profile to `original-profile`, verifies every
file with SHA-256, then creates a separate `prepared-profile`. The live profile
is unchanged. On macOS the default source is
`~/Library/Application Support/mynda` and destination is
`~/Library/Application Support/Mynda`. Windows uses `%APPDATA%`; Linux uses
`$XDG_CONFIG_HOME` or `~/.config`. Use `--source` and `--destination` to override
these defaults. The destination must be a sibling; a different existing profile
is never merged or overwritten.

Review the summary and private `report.json`. Missing artwork references are
preserved and reported; unreadable historical snapshots stay byte-for-byte
intact. An unreadable primary library blocks preparation. Reports and manifests
can include personal filenames, so keep the migration directory private.

```bash
npm run profile:migrate -- --output "/absolute/path/mynda-profile-backup" --app-closed --install
```

Installation rechecks the source, backup and prepared checksums, copies a
verified sibling staging directory, retains the original under a unique
`.mynda-before-migration-…` name and installs the new profile. This also handles
a case-only rename on a case-insensitive filesystem. An interrupted install
can be resumed using the same command; conflicting or changed files stop the
operation instead of being replaced. Failed swaps restore the old profile.

The new profile contains an activation-removal marker. Original encrypted
credentials, if present, remain in the verified backup. System Keychain entries
are untouched. Enter the license key in Settings after the migration.

## Artwork references

Managed artwork is stored as a plain relative path, for example `poster.jpg`
or `series/poster.jpg`. Its root is defined once by `artworkDirectory(userData)`
in `src/platform/ArtworkPaths.js`. The backend publishes that location with the
library snapshot; the renderer resolves references for display without Node
or filesystem access. New catalog downloads and editor saves use the same root.

Preparation converts both active and inactive videos in the primary library,
named working copies such as `Library/library-real.json` and
`Library/library-before-autotag.json` (`library-*.json`), and valid backup/recovery
snapshots. Each file keeps its own library; none replaces the active library. Available external images are copied into
managed storage using names derived from their content, avoiding collisions.
Missing external images and remote URLs remain intact for repair. Empty artwork
stays empty. Existing managed relative paths do not change.

Library loading also recognizes absolute paths under the current managed root
and the legacy lowercase profile root. This supports restoring an older backup.
Unrelated absolute paths are not guessed to be managed files. Relative traversal
and symlink escapes are rejected for privileged file operations; editor file
approval remains required.

To relocate managed artwork later, move its files and change the central root.
Already-relative library references and backups require no rewriting. Keep an
old root as an explicit legacy root if older absolute-path exports still need
conversion.

## Verification and recovery

After installation, check library counts, existing artwork, editing/downloading
artwork, playback, diagnostic export and restart. The source/ASAR startup tests
exercise relative artwork save, display, missing-file retry and removal. Tests
also cover library restoration, root changes, backup integrity, interrupted
installation and credential reset.

Keep `original-profile`, its manifest and the retained original until validation
is complete. For a manual rollback, quit Mynda, preserve the new profile under
a different name, restore the original lowercase profile from the verified
backup, and run the previous application version. Do not merge profile trees.
