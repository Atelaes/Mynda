# Autotag UI freeze diagnostics

These opt-in observers help distinguish backend activity, renderer delays, stale
playlist counts, and missing frame callbacks. They do not change tagging,
matching, save batching, playlist refreshes, or Electron background throttling.

## Capture a reproduction

1. Fully quit any running Mynda instance.
2. From the desktop repository, run `MYNDA_UI_DIAGNOSTICS=1 npm start`.
3. Start an autotag run as usual. Switch to another app and back if that normally
   triggers the freeze. Note the approximate clock time, whether the ellipsis
   and New count stop together, and whether other controls still respond.
4. If it recovers, leave Mynda open for another 20 seconds before quitting
   normally. This gives the next summaries time to capture recovery.
5. Upload the usual logs folder, including `mynda-ui-diagnostics.log` and any
   numbered backups. Keep ordinary tagging logs too for correlation.

The dedicated log is in the same directory as `mynda-info.log`. It rotates at
2 MiB and retains two backups, independently of verbose tagging logs. It records
timings, revisions, counts, phases, and window state; it does not add filenames,
video titles, search results, or credentials. Existing logs keep their existing
contents and redaction rules.

Run ordinary `npm start` to disable diagnostics. No server deployment is needed.

## What is recorded

- Independent backend and renderer summaries about every ten seconds.
- Timer gaps over 2.5 seconds, window responsiveness, focus, visibility,
  minimize/restore, and system suspend/resume events.
- Renderer animation-frame activity and the existing ellipsis timer callbacks.
- Tagging phases and completed decisions, including later recovery passes.
- Library commit timing, save queue length, and revision numbers.
- Commit-to-renderer transit, renderer delivery queue wait, and time applying
  a library message and notifying subscribers.
- Root React update sequence, latest observed revision, actual New count, and
  the New count held in the root component's playlist count cache.

Observers aggregate work; they do not log each video, render, or animation frame.
Slow commits are summarized, with warnings over one second limited to one per
ten seconds. The diagnostics flag is read at process startup.

## Interpretation limits

Background windows can legitimately have fewer timer/frame callbacks. Compare
those gaps with focus/visibility and recovery after returning to the app. A
requestAnimationFrame callback indicates a rendering opportunity, not proof
that the GPU displayed the updated pixels. Root component updates also do not
prove that every child displayed the latest data.

Transit uses wall-clock timestamps across processes and is approximate if the
system clock changes. Within-process durations use a monotonic clock. A renderer
that is blocked cannot log until it runs again; backend samples provide an
independent timeline during that gap. These observations narrow the cause but
may indicate that a performance trace is needed to identify an expensive stack.

## Focused automated check

Run `node test/UiDiagnostics.unit.test.js`. These tests use controlled clocks to
check timer/frame gaps, visibility transitions, save/delivery timing, disabled
behavior, cleanup, and unchanged library application. The suite is also included
in the normal test catalog. The macOS background/foreground freeze still needs
a reproduction on the affected machine.
