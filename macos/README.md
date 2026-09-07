# macOS quick-share

Capture a region of the screen — or right-click any file in Finder — and get a link to it on
your clipboard. CleanShot X's cloud upload, built out of the CDN you already deployed.

Two pieces, and the split is the point:

- **`macos/quickshare`** — all the behavior, in git, runnable from a terminal, reviewable in a
  diff. bash and curl, nothing installed.
- **`macos/share-to-cdn.plist`** — a Shortcut that does exactly one thing: run `quickshare`.

The Shortcut decides *when* the script runs, never *what* it does. So it gets imported once and
never again — every change lands in `quickshare` and takes effect on the next invocation. The
alternative (real logic inside Shortcuts.app) is a blob nobody can diff, review, or run headless.

## Install

**1. A token file**, the same one the Claude Code hooks read:

```bash
mkdir -p ~/.config/cdn/hosts
printf 'CDN_TOKEN=%s\n' "$YOUR_UPLOAD_TOKEN" > ~/.config/cdn/hosts/cdn.example.com.env
chmod 600 ~/.config/cdn/hosts/cdn.example.com.env
```

The filename is the host. One file there is the default; several and you set `CDN_HOST`. The
script `source`s the file, which is exactly why it has to be yours and mode 0600.

**2. The Shortcut:**

```bash
./macos/install.sh                    # signs "macos/Share to CDN.shortcut" from the plist
open "macos/Share to CDN.shortcut"    # double-click → Add Shortcut
```

The plist runs `"$HOME/code/cdn/macos/quickshare"`. **If you cloned this repo somewhere else, edit
that one line in `share-to-cdn.plist` and re-run `install.sh`.** It is the only path in the file,
and a path change is the only reason to ever re-import.

**3. The GUI settings — and this is the step people miss.** Where a Shortcut is allowed to appear
is *not in the plist*: it lives in per-install GUI state that Apple exposes no CLI or file format
for, so a fresh import shows up **nowhere** until you set it by hand. In **Shortcuts.app →
"Share to CDN" → the ⓘ Details pane**:

| Setting | Set to | Why |
| --- | --- | --- |
| **Add Keyboard Shortcut** → e.g. `⌃⇧⌘4` | — | The capture flow. The one you'll actually use. |
| **Use as Quick Action** | **on** | Parent switch; nothing below it matters without it. |
| ↳ **Finder** | **on** | Right-click a file → Quick Actions → Share to CDN. Also what registers it in System Settings → Extensions → Finder — if it's missing from *that* list, this toggle is off. |
| ↳ **Services Menu** | **off** | A second, uglier path to the same thing: a duplicate entry in the *Services* submenu right under Quick Actions. Only useful for text selections, which a file uploader has no use for. |
| **Show in Share Sheet** | **on** | The `Share…` submenu, Preview, Safari. |
| **Provide Output** | **off** | For handing a *result* back to the caller (e.g. replacing the file). The script already owns its side effects — clipboard + notification — so there's nothing to hand back. |

Pick a hotkey that doesn't fight the system screenshot keys (`⌘⇧3/4/5`) — macOS lets a Shortcut
quietly lose that one. `⌃⇧⌘4` is clear, unless Raycast/Hammerspoon/Karabiner has claimed it.

## How it behaves

One Shortcut covers both surfaces because the script reads its own input:

```
hotkey, nothing selected  → no arguments → screencapture -i → …/a1b2c3.png
Finder right-click, 1 file                                  → …/a1b2c3.png
Finder right-click, several   → a random folder             → …/a1b2c3/   (a listing page)
Finder right-click, a folder  → keeps its name              → …/shots/
```

**Exactly one URL comes out, always.** That's a rule, not an accident. Handing back several links
is a trap: the clipboard can only join them with a separator, and any single-line paste target — a
browser bar, a chat input — silently eats the newlines and welds them into one dead string
(`…/7875cd.movhttps://…/aafa73.txt`). So a multi-selection becomes a **folder**: `quickshare` mints
a random 6-hex prefix client-side (a folder is just a key prefix, so the CDN needs no say in it)
and uploads everything under it. The Worker already serves any prefix as a public listing page, so
one link shows the whole set, and the files keep their real names inside it — `anim.mov` reads
better on that page than `7875cd.mov`. A directory in the selection keeps its own name as a
subfolder.

A lone file lands at the bucket root with a random slug and its real extension (`…/6d9a27.png`),
so the Worker types the object from the key and the local filename never reaches a public URL.
Pass `--permanent` for anything that must outlive the 30-day sweep.

The URL you get back is the one **the Worker returned** — `POST /api/upload` answers with the
public URL, so nothing on this side composes one out of a domain string. That is also why pointing
the script at a local Worker works: set `CDN_HOST=localhost:8787` and it talks http to loopback.

The clipboard gets the bare URL with **no trailing newline**, so pasting into Slack or a browser bar
doesn't submit the message or leave a dangling blank line. A Notification Center banner confirms.

Cancelling the capture (ESC) exits silently and leaves the clipboard alone — `screencapture -i`
still exits 0 on cancel, so the script tests for a non-empty file rather than trusting the status.

## The screenshot thumbnail can't be reached — don't try

The obvious wish is "take a screenshot with `⌘⇧4`, then right-click the floating thumbnail and share
it." **That menu is hardcoded by `screencaptureui`** (Save to Desktop / Documents / Clipboard, Open in
Mail / Preview / Photos, Show in Finder, Delete, Markup, Close). It honors no Quick Actions, no Share
extensions, no Services. There is no plist, entitlement, or app that adds an item to it — a Share
Extension in a real signed app doesn't get in either. This is a closed surface; the only reason it's
written down is so nobody spends another afternoon confirming it.

Which is fine, because the wish was two steps to begin with. **Press the hotkey instead of `⌘⇧4`.**
Same crosshair, same drag, and the link is on the clipboard when you let go — the thumbnail never
appears, because the screenshot never becomes a file on your Desktop. One step, not two.

The alternative — keep `⌘⇧4` and auto-upload whatever it writes — needs a launchd watcher on the
screenshot folder. It's ~15 lines, and it's the wrong trade: every throwaway shot burns a key and
churns the 30-day sweep. Opt in per capture; don't upload your whole screenshot history.

## Gotchas worth knowing

**Shortcuts hands a script a bare environment** — no zshrc, no Homebrew, no `~/.bun/bin`. That's why
`quickshare` appends the system directories to its own `PATH` on the way in, and why every tool it
uses (`curl`, `screencapture`, `pbcopy`, `osascript`, `uuidgen`, `find`) lives there. Verified by
running it under `env -i PATH=/usr/bin:/bin`. Nothing needs installing — which is the reason this
path is bash and curl instead of the CLI.

**The token is read at runtime from `~/.config/cdn/hosts/`,** so the Shortcut itself carries no
secret and can be shared or re-signed freely. A *phone* shortcut would not get this — there is no
config file to read on iOS, so it has to carry the bearer in a Text action. That token is
upload-only and can't reach the destructive APIs, but it is a real difference in posture, and the
reason the Mac went first.

**There are two capture paths, and they are twins with opposite constraints.** `quickshare` captures
with `screencapture -i` — interactive, blocks until *you* drag a crosshair. An agent capturing on
your behalf wants `screencapture -x -m` — headless, no window shadow, for when something is driving
your Mac while you're on your phone. Same underlying tool, opposite rule about who's at the
keyboard.

That also means a bare `quickshare` would **hang forever** if an agent ran it. So it doesn't ask
nicely in a doc — it refuses: the script bails when `CLAUDECODE` is set and points at the headless
capture and the upload API. Anything that wants to upload without a human present should POST to
`/api/upload` directly, or use the Claude Code hooks; `quickshare` owns every GUI side effect and is
the wrong tool for an unattended caller.

**Screen Recording permission**: the first capture will prompt for it (System Settings → Privacy &
Security → Screen Recording), granted to *Shortcuts*, not to the script. Until you grant it,
`screencapture` silently produces a picture of your desktop wallpaper with no windows on it.

## Why not a menu-bar app

It'd be ~200 lines of SwiftUI duplicating a one-action Shortcut. The only things it would genuinely
buy: an upload-progress HUD for big videos (Shortcuts just spins), a recent-uploads list, and a
namespace picker. If those turn out to matter after living with this, that's the signal to build it —
not before.
