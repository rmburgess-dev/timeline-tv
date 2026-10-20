# NOTICE

## Originality

Everything in this repository — `content.js`, `background.js`, `page-guard.js`, `popup.js`,
`popup.html`, `popup.css`, the icon artwork, and the tooling — was written for this
project and is original work by Robert Burgess. No source code, markup, stylesheet or
image from any other extension is included or adapted here.

## Prior art

This extension exists because the Chrome extension **"Twitter Video Slideshow"** by
*kurucowa* had no Firefox build. That extension's public behaviour was used as the
**functional specification** for playback: playing a timeline's videos in a full-window
overlay, with next/previous, speed and volume. The implementation now ships for both
Firefox and Chrome. Bar-level like/repost/bookmark buttons were considered and removed —
with several tweets on screen, one button cannot sensibly target one tweet.

Ideas and user-facing behaviour are not copyrightable; the implementation in this
repository is independent. Notable differences in approach:

| Concern | This add-on |
| --- | --- |
| Overlay isolation | Shadow DOM with constructable stylesheets — no CSS is injected into the page |
| Styling | Original CSS and SVG icons, consuming X's own theme tokens rather than copying its stylesheets |
| Media playback | Moves the page's own `<video>` and restores it to its exact original position; original muted/volume/rate/loop are preserved |
| Teardown | One `teardown()` path shared by every exit route (close button, Escape, error, navigation) |
| Navigation | A monotonic token serialises async navigation so rapid input cannot interleave mounts |
| Page guard | Firefox's `wrappedJSObject` guard plus a Chrome MAIN-world guard (`page-guard.js`); both block the page's pause/load/remove only for mounted players |
| Permissions | Firefox: `storage`. Chrome: `storage` and temporary `activeTab`. No `host_permissions`; no network access of the extension's own |
| Iconography | Generated from scratch by `tools/make-icons.mjs` |
| Naming and branding | Independent name; no third-party donation link or artwork |

If the upstream author would like this work to carry their name, credit, or a shared
listing, that is welcome — open an issue.
