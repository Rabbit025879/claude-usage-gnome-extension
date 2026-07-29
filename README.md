# Claude Usage GNOME Shell Extension

A GNOME Shell extension that shows Claude Code's 5-hour and weekly usage
limits in the top bar, complete with a small animated "Clawd" mascot that
reacts to how close you are to your limits.

## Features

- Top bar indicator showing current 5-hour and 7-day (weekly) utilization
  percentages, e.g. `5h 42%` · `7d 18%`.
- Dropdown menu with a progress bar, percentage, and relative reset time
  (`in 2h 14m`, `any moment now`, etc.) for each window.
- Color-coded status: green under 75%, yellow from 75–89%, red at 90%+.
- Weekly pacing hints: the weekly bar stamps a `|` marker showing where
  cumulative usage should be if spent evenly over ~6 active days (leaving
  the day before reset as slack), plus a line showing how many 5-hour
  sessions realistically remain before reset (discounting ~10 hours/day for
  sleep, meals, etc.) and roughly what % of the 5-hour limit each would need
  to use to fully spend the remaining weekly quota instead of leaving it
  unused. That per-session % is a rough estimate — Anthropic doesn't publish
  the actual weekly-to-5-hour ratio.
- Animated Clawd icon whose mood reflects usage — playful when 5-hour usage
  is at 0%, asleep when either window hits 100%, otherwise idling/trotting/
  sprinting based on how much you've used. Can be toggled off from the menu.
- "Refresh now" menu item, plus automatic polling every 5 minutes.
- Reads credentials from `~/.claude/.credentials.json` (the same file the
  `claude` CLI uses) and transparently refreshes the OAuth access token when
  it's expired, writing the new token back to that file.

## Requirements

- GNOME Shell 46.
- The [`claude` CLI](https://docs.claude.com/en/docs/claude-code) installed
  and logged in (`claude login`), so `~/.claude/.credentials.json` exists
  with a valid OAuth token.
- A Claude Pro/Max plan with usage limits (the extension calls Anthropic's
  `/api/oauth/usage` endpoint).

## Installation

There's no build step — GNOME loads the extension straight from source, so
installing just means getting this repo's contents into GNOME's user
extensions directory under the extension's UUID, `claude-usage@rabbit025879`.

### Option 1: clone directly into place

```sh
git clone https://github.com/Rabbit025879/claude-usage-gnome-extension.git \
  ~/.local/share/gnome-shell/extensions/claude-usage@rabbit025879
```

### Option 2: clone elsewhere and symlink

Useful if you want to keep the working copy somewhere else (e.g. alongside
other projects) and just link it into place:

```sh
git clone https://github.com/Rabbit025879/claude-usage-gnome-extension.git ~/src/claude-usage-gnome-extension
ln -s ~/src/claude-usage-gnome-extension ~/.local/share/gnome-shell/extensions/claude-usage@rabbit025879
```

### Option 3: download without git

Download and extract the [repo archive](https://github.com/Rabbit025879/claude-usage-gnome-extension/archive/refs/heads/main.zip)
into `~/.local/share/gnome-shell/extensions/claude-usage@rabbit025879/` (the folder
must contain `metadata.json` directly, not a nested subfolder).

### Enable the extension

```sh
gnome-extensions enable claude-usage@rabbit025879
```

If that command reports the extension isn't found, GNOME Shell hasn't
picked it up yet — reload the shell first (see below) and try again.

### Reload GNOME Shell

Newly installed extensions usually need a shell reload before they show up:

- **X11**: press `Alt+F2`, type `r`, then press Enter.
- **Wayland**: log out and back in (there's no in-session reload on
  Wayland).

After that, you can also manage the extension (enable/disable/remove)
through the **Extensions** app or the [extensions.gnome.org](https://extensions.gnome.org)
companion, in addition to `gnome-extensions`.

### Updating

If you installed via `git clone` (option 1 or 2), pull the latest changes
and reload the shell:

```sh
git -C ~/.local/share/gnome-shell/extensions/claude-usage@rabbit025879 pull
```

(Adjust the path if you used the symlink layout from option 2.)

### Uninstalling

```sh
gnome-extensions disable claude-usage@rabbit025879
rm -rf ~/.local/share/gnome-shell/extensions/claude-usage@rabbit025879
```

## Usage

Once enabled, the indicator appears in the top bar next to the clock. Click
it to see a detailed breakdown of both usage windows, toggle the Clawd
animation, or trigger a manual refresh.

If no credentials are found, or the stored token can't be refreshed, the
indicator shows a status message instead (e.g. `Claude: no token` or
`Claude: run "claude" to refresh`) prompting you to run the CLI to
authenticate.

## Files

- `extension.js` — entry point; creates and destroys the panel indicator.
- `indicator.js` — panel button, popup menu, credential/token handling, and
  usage polling.
- `clawdIcon.js` — draws and animates the Clawd mascot from pre-rendered PNG
  frame sequences.
- `clawd-assets/frames/` — Clawd's animation frames (`idle`, `play`, `sleep`
  moods) at multiple sizes for HiDPI displays.
- `metadata.json` — GNOME extension metadata (uuid, name, shell version).

## Privacy

All requests go directly from your machine to `api.anthropic.com` (and the
OAuth token endpoint) using your existing local Claude credentials. No data
is sent anywhere else.
