# Timeline TV

A Firefox and Chrome extension that turns the videos already in your X (Twitter) timeline
into a full-window wall of video — up to eight clips playing at once, no new tab, no leaving
the feed.

Scroll your timeline, hit the toolbar button (or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>),
and the timeline's videos start playing. With several columns, each one works through
the queue on its own: the moment a clip finishes, that column pulls the next video in
line. The overlay follows X's current light or dark theme, accent colour and contrast
setting, without injecting any CSS into the page.

> An independent implementation of a Chrome-only idea. See [NOTICE.md](NOTICE.md)
> — no code from any other extension is used here.

## Features

- **Several videos at once.** Choose 1 to 8 columns in the popup. Each column pulls the next
  item from one shared queue as it finishes, so nothing sits idle. Past three, the popup warns
  that the graphics card may not be able to decode every stream — see [Hardware
  acceleration](#hardware-acceleration).
- **Plays what's on screen.** Collects the videos in the tweets you've already scrolled
  past, in timeline order, and queues them.
- **Keeps going — and keeps looking.** While any column is still empty it scrolls the page so
  X loads more of the timeline, which is what fills eight columns when the videos are far
  apart. A search stops as soon as every column has a clip, and gives up after a few
  consecutive rounds that come back empty, so it cannot scroll forever underneath a grid the
  timeline cannot fill. A finished clip keeps its last frame on screen while the next one is
  fetched, and the end-of-timeline note waits for the search to come back empty for about
  twelve seconds before it appears.
- **Per-column audio.** Every column has its own speaker button, and the bar has a master
  mute on top. Playback always starts silent — browsers only allow audible autoplay after
  a click inside the page, so unmuting is one explicit click.
- **One click to hear everything.** Next to the mute button and the volume slider there is a
  bulk unmute: it clears every column's own mute flag and the master mute together, so an
  eight-column grid does not take eight clicks to listen to. It lights up when every column
  is already audible, so it also reports the state of the grid.
- **Columns start one at a time.** The grid fills a column roughly every second instead of
  asking X for eight players in the same instant, and several columns finishing together are
  spaced out the same way. A clip that ends on its own never waits for a fixed delay: the
  spacing is measured from the last player that actually started, so on a quiet grid the next
  clip replaces the held last frame on the next paint tick.
- **Next takes the oldest column.** Pressing <kbd>→</kbd> advances whichever column started
  its current clip longest ago, and focuses it — so repeated presses rotate through the
  columns in order, one fresh video each. You never have to click or <kbd>Tab</kbd> to a
  tile first.
- **A focused column.** The rest of the bar — seek, speed and volume — acts on the focused
  tile: the newest one by default, or whichever tile you clicked (shown with an accent ring).
- **Full playback control.** Play/pause, previous/next with per-column history, seekable
  progress bar with time remaining, volume with mute, and speed from 0.25× to 3×.
- **Follows your X theme.** Light, dark, the chosen accent colour and high contrast are read
  from X's own `--x-*` tokens, so the overlay changes with the site instead of imposing a
  fixed palette. The popup follows the operating system's light/dark preference.
- **Optional images.** Flip on *Include images* in the popup to mix tweet images into the
  grid on a timer you choose.

| Key | Action |
| --- | --- |
| <kbd>Esc</kbd> | Close the overlay (every column's video goes back where it came from) |
| <kbd>←</kbd> / <kbd>→</kbd> | Previous / next item — <kbd>→</kbd> always takes the oldest column |
| <kbd>Space</kbd> or <kbd>K</kbd> | Play / pause the focused column |
| <kbd>M</kbd> | Mute / unmute the master flag (per-column flags stay as they are) |
| <kbd>U</kbd> | Unmute every column at once |
| <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | Move the focus between columns |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Start / stop from anywhere (rebindable in `about:addons` → Manage → Shortcuts, or `chrome://extensions/shortcuts`) |

### How the columns behave

There is one ordered queue of media taken from the timeline. Columns claim items from it
in order and never share one:

```
queue: 1 2 3 4 5 6
       │ │ │
     ┌─┴─┴─┴─┐        column A ends → takes item 4
     │ 1│ 2│ 3│        column C ends → takes item 5
     └──┴──┴──┘        column A ends → takes item 6
```

- **Focus follows the newest column** unless you pin one by clicking it, so the control bar
  does not jump around every time a background clip finishes.
- **<kbd>→</kbd> advances the oldest column**, not the focused one. Since queue positions are
  claimed in order, the lowest index is the clip that started longest ago; advancing it
  gives that column the newest index, so the next press picks a different column.
- **A mounted column cannot be paused by the page.** X pauses players it does not consider
  primary — while they are still buffering, which is why reacting to `pause` events could
  never keep several columns alive. So a column plays in a player X cannot reach: either an
  element of the add-on's own, or X's own element with its `pause`/`load`/`remove` replaced *in
  the
  page's compartment*, which is the only place the page's code will run into it. That guard
  is proved before the clip starts (see [How it works](#how-it-works)), and a keep-alive
  resume stays as the safety net when the browser gives no way to install it.
- **Prev is per column.** Each column remembers what it has shown, so <kbd>←</kbd> walks
  that column's own history rather than yanking another column's video.
- **A column keeps looking.** If the next item in the queue can no longer be played — X
  unloaded or re-rendered that tweet — the column skips forward to the next playable one
  rather than dying on a "No more videos" card while the queue still has items.
- **A finished clip holds its last frame.** Ending a clip does not empty the tile. The spent
  player stays paused on its last frame until the next clip is ready, and the next clip
  replaces it in one step. If the queue is drained, the add-on keeps searching underneath
  the grid; only when the queue is empty and the search has produced nothing for twelve
  seconds does the tile say "No more videos". Emptying at `ended` made every normal advance
  flash that message while the next clip was still being fetched.
- **A paused clip is resumed, never skipped.** There is deliberately no "paused too long,
  move on" rule for a clip the page keeps pausing: a stalled column resumes however long it
  takes, its progress bar turns amber so the stall is visible, and the keep-alive never gives
  up. What does move a column on is a player that cannot play: one the add-on had to keep
  resuming is *not* spent (that is the page fighting, not the clip), but a player that claims
  to be playing while it holds the data and never advances is first restarted on the same clip
  after about thirty seconds; if it freezes again it is stepped over, and one whose media never
  arrived at all is stepped over after twenty. The stall clock is reset whenever the tab
  becomes visible, so a backgrounded tab cannot retire several clips at once.
- **The end of a clip is measured, not announced.** X's own players routinely pause a clip a
  fraction before its end and show a replay button, leaving `ended` unset — which is how a
  column used to sit on the last frame of video 60 while the queue ran on to 92. A column is
  finished when its player says so *or* when it is paused at the end of its own duration; a
  still-playing player is never retired just because its reported duration is short.
- **Media errors are retried per column.** A transient `error` reloads that column's player
  and tries again; it is only dropped if it fails twice. The retry flag is per column —
  a shared one meant one column's error made the others skip their clips immediately.
- **Audio is deliberate.** Columns start muted and stay muted until you say otherwise;
  muting a column is remembered as that column pulls new videos.


## Install

Build both browser packages from one checkout:

```bash
git clone https://github.com/rmburgess-dev/timeline-tv.git
cd timeline-tv
node tools/package.mjs .
# dist/timeline-tv-1.0.1.xpi        Firefox install file
# dist/timeline-tv-1.0.1.zip        Firefox / AMO upload
# dist/timeline-tv-1.0.1-chrome.zip Chrome Web Store upload
# dist/chrome/                      Chrome "Load unpacked" directory
```

The two targets differ only where the browsers require it: Firefox uses an MV3 event page
(`background.scripts`), Chrome uses a service worker, and Chrome gets `page-guard.js` as a
MAIN-world content script. Everything else is the same code.

### Firefox — Developer Edition / Nightly (permanent, unsigned)

Developer Edition and Nightly honour `xpinstall.signatures.required = false`, so you can
install a self-built add-on for good:

1. `about:config` → set `xpinstall.signatures.required` to `false`.
2. `about:addons` → gear icon → **Install Add-on From File…** → pick
   `dist/timeline-tv-1.0.1.xpi`.

### Firefox — any build (temporary)

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → choose the
repository's `manifest.json`. Temporary add-ons are removed when Firefox restarts.

### Chrome

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → choose `dist/chrome/`.

For the Chrome Web Store, upload `dist/timeline-tv-1.0.1-chrome.zip` at
[chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole).

**After updating either browser, reload the tab as well as the extension.** A content script
is injected once per page load and never hot-reloads, so an open x.com tab keeps running the
previous copy — which is what makes a fix look like it did nothing. The popup's footer shows
the version it was built from, and it says so plainly when the tab you are looking at is
still on an older one.

If you can't find the toolbar button afterwards: in Firefox 89+ extension buttons land in the
puzzle-piece **Extensions** panel, and in Chrome they land in the puzzle-piece **Extensions**
menu. Pin *Timeline TV* to the toolbar. The Firefox manifest also sets
`"default_area": "navbar"`, which Firefox honours on a fresh install.

### addons.mozilla.org and the Chrome Web Store

Upload `dist/timeline-tv-1.0.1.zip` at
[addons.mozilla.org/developers](https://addons.mozilla.org/developers/) for signing and
distribution. Upload `dist/timeline-tv-1.0.1-chrome.zip` at the Chrome Web Store developer
console. Store accounts and review are required; the built archives are the artefacts those
consoles expect.

## How it works

The interesting problems are all about X's media pipeline and about not breaking the
page you're borrowing media from.

**Shadow DOM, not injected CSS.** The overlay is mounted in a shadow root on
`<html>`, styled with a constructable stylesheet. Nothing is injected into the page, so
X's CSS can't reach the overlay, the overlay can't leak into X, and the site's
`style-src` policy is irrelevant.

**The page's own `<video>`, moved and returned.** X plays video through MSE with `blob:`
URLs, which cannot be re-loaded into a fresh element. So the extension moves the tweet's
actual `<video>` element into a tile, plays it, and then puts it back at its exact original
position — restoring the original `muted`, `volume`, `playbackRate`, `controls` and `loop`.
Every exit route (close button, <kbd>Esc</kbd>, media error, `pagehide`, navigating away)
funnels through the same `teardown()`, so no element is ever left stranded or stripped of its
source. With several columns that means several moved elements, each restored by its own
lane, and teardown walks all of them.

**A lane per column.** A `Lane` owns one column: the element mounted in it, its timers, its
history and its mute flag. Columns claim queue positions in order and never share one, so
two tiles can't try to play the same element. Lanes are restored independently, which is
what makes simultaneous playback safe to tear down.

**X fights back, so the guard moves to the page's side.** X pauses players it doesn't
consider primary, frees one it thinks is finished with `load()`, and removes one it is
virtualising away with `remove()`. Blocking those from the content script does not work: a DOM
node has one JavaScript reflection per compartment, and
Firefox's [Xray vision](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts)
keeps the content script's reflection and the page's apart, so `video.pause = () => {}` is
invisible to X and its `pause()` still reaches the native implementation. The guard is
therefore installed on the page's own view of the element (`wrappedJSObject`, via
`exportFunction`), and then **proved**: the add-on calls `pause()` back through that same
view before the clip starts. If the call comes back through the guard, the page cannot stop
that column; if it doesn't, the diagnostics say so and the keep-alive resume takes over. A
guard that only exists on this side of the wall is exactly the bug that kept several columns
pausing for three releases.

**The same guard, browser by browser.** Firefox exposes the page's JavaScript view of a node
as `wrappedJSObject`, so the guard is installed directly on that view and can be exercised
through it. Chrome content scripts run in an isolated world and cannot see that view at all.
There, `page-guard.js` runs as a `world: "MAIN"` content script at `document_start`: it wraps
the page's `pause`/`load`/`remove`/`removeChild` prototypes and blocks them only for elements
carrying the `data-tt-player` marker that the isolated content script sets while a column is
mounted. The marker is removed when the player is handed back, so the timeline gets its own
player back with all its methods intact. Chrome's diagnostics report the bridge as a page
guard; its per-call blocked counter lives in the page world and is not surfaced.

**A replaced player is noticed, not resumed.** X swaps and removes players as the timeline
virtualises, and a detached `<video>` still accepts `play()` and still reports a
`currentTime` — so a tile can show one frozen frame while the add-on keeps pushing a player
that no longer has a surface. A lane that finds its element detached picks the clip back up,
and takes the next one if the tweet is gone (capped, so a bad timeline cannot thrash).

**Serialised navigation.** A monotonic load token invalidates in-flight top-ups, so mashing
<kbd>→</kbd> can't interleave two mounts and end up with the wrong video in a tile.
Unplayable items are stepped over, with a cap so a broken timeline can't loop forever.

**Dedupe by tweet, not by URL.** Queue keys are *tweet permalink + media slot*, so a
re-rendered tweet isn't queued twice, but the same clip appearing in two different tweets
is queued twice, as you'd expect.

**Theme without injected CSS.** X publishes its current palette as `--x-*` custom properties
on `:root` (`--x-bg-primary`, `--x-fg-primary`, `--x-fg-brand`, `--x-border-normal`, …). Custom
properties inherit through a shadow boundary, so the overlay's own stylesheet consumes them
directly and a theme or accent switch is picked up without rebuilding anything. The host also
mirrors X's `data-theme`/`data-accent` attributes, and samples the page's computed colours as
a fallback for older markup that predates those tokens.

**No bar-level social buttons.** Like, repost and bookmark are per-tweet controls. With
several tweets on screen at once there is no single tweet a bar button could act on without
being wrong for every other column, so the overlay leaves those actions to the timeline.

## Performance

Three videos decoding at once is the expensive case, and the first version stuttered. Eight is
the widest grid the add-on lays out, and on most machines that is well past what the GPU can
decode at once — the popup says so, and the honest fix there is fewer columns. What was wrong
and what changed:

- **A blurred backdrop over video.** The close button used `backdrop-filter: blur()`
  while sitting on top of three playing videos, so the compositor re-blurred the backdrop
  on every frame. Removed; it is a flat translucent chip now.
- **Progress bars animated with `width`.** Layout on every tick, four bars at once.
  They are painted with `transform: scaleX()` now, which the compositor handles on its own
  without touching layout.
- **A pause/play tug-of-war with X.** X pauses players it doesn't consider primary, and it
  does so while they are still buffering. Reacting to `pause` events was both too slow and
  too violent: bounded retries let the grid collapse to one playing video, while unbounded
  retries produced a tight loop that was audible as stuttering audio. Resumption now
  re-checks state on a fixed 250 ms cadence and never gives up — but the real fix is that the
  page's own `pause()` cannot stop a mounted column (see [How it works](#how-it-works)), so
  the keep-alive is a net rather than the mechanism.
- **Full timeline scans during playback.** The mutation observer used to rescan the whole
  document every 1.5s. It now only scans when the result could matter — a column is idle or
  the queue is nearly drained.
- **Per-video paint handlers.** Each video drove its own DOM writes on `timeupdate`. One
  shared 200ms timer paints every tile instead, and tiles use `contain: layout paint style`
  so one tile's changes can't force the others to re-lay-out.
- **Eight players starting at once.** A wide grid used to mount every column in one tick: eight
  media pipelines, eight decoders and eight sets of segment requests arrived together, so the
  first columns stuttered while the last were still initialising. Mounting is serialised — one
  column per second — which also de-bursts several columns finishing at the same moment. A
  tile between clips holds its last frame rather than announcing that the timeline ran out.
- **No DOM churn between clips.** A finished tile used to be emptied, its player returned to
  the timeline, and its progress bar reset on every `ended` — then filled again a moment
  later, often with "No more videos" flashing in between. The spent player is now paused in
  place and replaced in one mount; the only DOM work while a clip waits is the frozen
  progress bar, and that is skipped when its value has not changed. The same change removes
  the per-second style churn from paused/idle tiles and redundant writes to the shared time
  readout.

If it still stutters, press <kbd>Shift</kbd>+<kbd>D</kbd> while the overlay is open. It
toasts one line — columns, dropped frames, guard state, resumes, hardware decode — and logs
full per-column state (`paused`, `readyState`, `networkState`, `source`, `guard`,
`blockedPauses`, `reroutes`, dropped/total frames). That separates the real possibilities:

| Symptom | Meaning | Fix |
| --- | --- | --- |
| High dropped-frame % on all columns | The machine/GPU can't decode that many streams | Use fewer columns, or a lower-resolution timeline |
| `UNGUARDED n` in the toast | The page's own view could not be reached, so X can still pause those columns; `resumes` climbs as the keep-alive recovers them | Report it — the browser build is not exposing `wrappedJSObject` |
| High `resumes` with low drops | The page is pausing players the guard could not cover (a player it captured before the mount, for instance) and the keep-alive is working hard | Report it — `RESUME_INTERVAL_MS` is the dial |
| `reroutes` climbing | X keeps replacing the player the column is showing | Nothing to tune: the column is picking its clip back up, which is the correct behaviour |

Dropped-frame counts come from `video.getVideoPlaybackQuality()`, not from guesswork.
A clip that is retired before its end is explained in the console rows too: `lastAdvance`
records the reason (`event`, `measured`, `stalled`, `dead-media`, `image-timer`) and the
position and duration at which that column moved on.

### Hardware acceleration

**No extension can enable hardware decoding.** It is a browser/driver decision; extensions
have no API for it and cannot touch `about:config` or `chrome://flags`. What this extension
*can* do is tell you whether you already have it — <kbd>Shift</kbd>+<kbd>D</kbd> reports
`HW decode` or `SOFTWARE decode`, taken from `navigator.mediaCapabilities.decodingInfo()`,
which is the browser stating whether a stream decodes on dedicated video hardware.

If it says **SOFTWARE decode**, that is the lag, and no code in this repository can fix it.
In Firefox Nightly, check in this order:

1. **`about:support` → Graphics.** "Compositing" should be `WebRender`. A blocklisted GPU
   driver is the usual cause and no pref reliably works around it — update the driver.
2. **`about:support` → Media.** Look for the hardware decoder entries; an empty list on a
   machine that should have one means the platform decoder isn't being found.
3. **`about:config`** — these are user-level, not add-on settings, and take effect after a
   restart:

   | Pref | Effect |
   | --- | --- |
   | `media.hardware-video-decoding.enabled` | Master switch, `true` by default |
   | `media.hardware-video-decoding.force-enabled` | Bypasses the GPU blocklist — can cause crashes or corrupted frames; a diagnostic, not a fix |
   | `layers.acceleration.force-enabled` | Forces GPU compositing when it was disabled |
   | `gfx.webrender.all` | Forces WebRender on builds where it is off |

4. **Watch the resolution** in the <kbd>Shift</kbd>+<kbd>D</kbd> console output. Three 1080p
   streams is six times the decode work of three 720p ones.

In Chrome, open `chrome://gpu` and look for **Video Decode: Hardware accelerated**; while a
clip is playing, `chrome://media-internals` shows which decoder is in use. Chrome has no
user pref for forcing hardware decode, so the fix there is the GPU driver, a lower-resolution
timeline, or fewer columns.

Worth knowing: **GPUs have a limited number of concurrent decode sessions** — commonly two
or four for H.264. With three columns it is entirely possible that two decode in hardware
and the third falls back to software, which drags the whole grid down; with four to six that
is the likely outcome. If `HW decode` shows but you still drop frames, the honest fix is
fewer columns or a lower-resolution timeline, not a code change.

## Privacy

No analytics, no remote code, and no requests to any server of the extension's own. Media is
loaded from X's own CDN, exactly as the page already did. Firefox requests only `storage`,
used to remember a few settings on your machine. Chrome requests `storage` and `activeTab`:
`activeTab` is temporary and only granted when you click the toolbar button or use the
keyboard shortcut, which is what lets the popup and the command message that tab's content
script without standing host permissions. Video is played from X's own media URLs; the
extension never proxies or reports what you watch.

## Development

```bash
node tools/test.mjs .     # 440 checks: both manifests, Chrome guard, markup, lanes, audio, stalls, icons
node tools/package.mjs .  # builds Firefox .xpi/.zip and Chrome -chrome.zip + dist/chrome/
node tools/make-icons.mjs icons   # regenerate the icon set
node tools/check-icons.mjs icons  # render icons as ASCII to eyeball them
```

The test harness has no dependencies: it implements a small DOM (HTML parser, selector
engine, shadow roots, media stubs) and drives `content.js` through its real message API
inside a Node VM. It asserts things that actually break in this kind of extension —
that the video is restored to its original position, that its source survives, that the
element's audio/rate state is put back, and that no timers survive teardown.

The DOM model keeps the two JavaScript reflections a DOM node really has apart, because that
distinction is the whole difficulty of this add-on: `wrappedJSObject` is a separate property
store, so a guard written from the content script is invisible through it. The Chrome path is
modelled separately: the suite runs the same code with `wrappedJSObject` unavailable and the
`document_start` bridge marker present, and checks that the mounted element gets the page-guard
marker and loses it on close. Every new guard in this repository is checked by reverting it and
confirming the suite fails.

There is no build step for the add-on sources themselves; `content.js`,
`background.js` and `popup.js` are shipped as authored.

## Licence

MIT — see [LICENSE](LICENSE).
