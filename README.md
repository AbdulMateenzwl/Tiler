# Tiler - GNOME Shell Tiling Window Manager Extension

A native GNOME Shell extension that brings i3/Sway-style tiling window management to GNOME 46+. Built on a recursive BSP container tree - every layout operation is a tree manipulation. No forking of Mutter or gnome-shell required.

---

## Installation

### Requirements

- GNOME Shell 46, 47, 48, 49 or 50
- Wayland session (X11 is not supported)
- `glib-compile-schemas` available (comes with `libglib2.0-dev` on Debian/Ubuntu)

### Install from GitHub

```bash
# Clone into the GNOME extensions directory
git clone https://github.com/abdulmateenzwl/tiler.git ~/.local/share/gnome-shell/extensions/tiler@abdulmateenzwl

# Compile the settings schema
glib-compile-schemas ~/.local/share/gnome-shell/extensions/tiler@abdulmateenzwl/schemas/

# Log out and log back in (required on Wayland - module cache must reload)
# Then enable the extension
gnome-extensions enable tiler@abdulmateenzwl
```

### Verify it is running

```bash
gnome-extensions info tiler@abdulmateenzwl
```

You should see `State: ENABLED`. If the state is `ERROR`, check the logs:

```bash
journalctl /usr/bin/gnome-shell -f | grep -i tiler
```

### Open settings

```bash
gnome-extensions prefs tiler@abdulmateenzwl
```

Or open the GNOME Extensions app and click the settings icon next to Tiler.

### Reloading after changes

Any time you edit extension files or recompile the schema, you must log out and log back in. On Wayland, GNOME Shell cannot be restarted in-place.

---

## Features

### Core tiling engine

Tiler uses a **recursive BSP container tree** as its core data structure. Every open window is a leaf node in this tree. Containers hold children arranged either horizontally (side by side) or vertically (stacked). The tree can nest arbitrarily deep, giving you full control over complex layouts.

When a new window opens, it takes **half the ratio** of the currently focused window - so your existing layout proportions are preserved rather than being redistributed equally. Windows reorganize automatically whenever any window is opened, closed, moved to another workspace, or changes state.

The gap between windows is configurable from preferences and applied consistently across all layouts.

### Splitting and nesting

By default, new windows are added as siblings in the same container as the focused window. You can change where the next window will be placed before opening it:

- `Super+Shift+H` - the next window will open **side by side** (horizontal split) with the focused window
- `Super+Shift+V` - the next window will open **above or below** (vertical split) the focused window

If the current container already has the same direction as your split, the window is added as a sibling. If it is a different direction, a new nested container is created automatically.

```
Example - three windows in a root horizontal container:
root (horizontal)
├── Terminal (ratio: 0.33)
├── vertical_container (ratio: 0.33)
│   ├── Editor (ratio: 0.5)
│   └── File Manager (ratio: 0.5)
└── Browser (ratio: 0.33)
```

### Window state management

Tiler tracks every tiled window and handles all state transitions cleanly:

**Maximize** - when you maximize a tiled window, it is removed from the tiling layer and its space is redistributed proportionally to its siblings. When you restore it, it comes back to exactly the same position with the same ratio, and siblings restore to their previous sizes.

**Minimize** - same behaviour as maximize. The window leaves the tiling layer and its siblings fill the gap. On restore it rejoins at its original position.

**Float** - pressing `Super+F` on a tiled window removes it from the tiling layer and centers it on screen at a configurable size (default 800×600). The other tiled windows reorganize to fill the space. Pressing `Super+F` again retiles the window at its original position with its saved ratio. Floating windows can be moved and resized freely.

**Launched maximized** - some apps (like file managers or system dialogs) launch in maximized state. Tiler detects these and watches for them - as soon as they are unmaximized they join the tiling layer automatically.

**Minimize while maximized** - if you minimize a window that is already maximized, Tiler handles this correctly without corrupting the saved ratio. Restoring from minimized then unmaximizing tiles the window correctly.

### Mouse interaction

**Live resize** - drag any window edge or corner handle and the neighbouring windows resize in real time alongside it. Each axis (horizontal/vertical) is handled independently. The final ratios are committed to the tree when you release the mouse.

**Corner resize** - dragging a corner handle resizes both axes simultaneously. Each axis finds its own container boundary in the tree, so complex nested layouts resize correctly.

**Drag to insert** - drag a tiled window over another tiled window. A blue highlight appears showing where the window will land:

- Drop on the **left 30%** - inserts before the target window
- Drop on the **right 30%** - inserts after the target window
- Drop on the **top 30%** - inserts above the target window
- Drop on the **bottom 30%** - inserts below the target window
- The **middle 40%** is reserved for future use

**Drag to swap** - press `Super+Shift+C` to switch to swap mode. Now dragging one window over another and releasing swaps their positions in the tree. An amber highlight shows the swap target. Press `Super+Shift+X` to return to insert mode. The mode resets to insert after each drag.

**Snap back** - if you drag a tiled window but do not drop it on another window, it animates back to its tiled position smoothly.

### Keyboard navigation

Focus moves between tiled windows using vim-style directional keys. The algorithm finds the window that shares the most border area with the current window in the given direction, preferring the topmost or leftmost candidate when multiple windows are tied.

| Shortcut  | Action                    |
| --------- | ------------------------- |
| `Super+H` | Focus window to the left  |
| `Super+L` | Focus window to the right |
| `Super+K` | Focus window above        |
| `Super+J` | Focus window below        |

### Keyboard resize

Press `Super+Enter` to enter **keyboard resize mode**. A red border appears around the focused window indicating it is active. While in resize mode:

| Shortcut        | Action                |
| --------------- | --------------------- |
| `Super+Shift+H` | Grow window leftward  |
| `Super+Shift+L` | Grow window rightward |
| `Super+Shift+K` | Grow window upward    |
| `Super+Shift+J` | Grow window downward  |
| `Super+Enter`   | Exit resize mode      |

Each keypress moves the window edge by a configurable pixel step (default 50px). The resize algorithm walks up the container tree to find the correct neighbour to take space from, so it works correctly even when the neighbour is in a different container.

Floating windows can also be resized in keyboard resize mode - their size changes freely without affecting any other window.

### Borders

Every tiled window gets a colored border that communicates its state at a glance:

- **Blue** - the currently focused window
- **Subtle white** - an unfocused tiled window
- **Amber** - a floating window
- **No border** - a maximized window

Borders update instantly when focus changes. They follow the window correctly across workspaces, respect minimize animations (disappearing immediately when minimized), and stay correctly stacked above their window at all times.

Border width, corner radius, and all three colors are configurable from the Appearance tab in preferences.

### Workspace support

Each workspace maintains its own completely independent container tree. Moving a window between workspaces reorganizes both the source and destination workspace layouts automatically. Dynamic workspaces are supported - when GNOME removes an empty workspace, all tree indices above it are shifted down correctly.

### Retile

Press `Super+Alt+T` to retile all windows on the current workspace. This is useful if any window has drifted from its tiled position or if you enable the extension with windows already open. Any window not currently tracked by the extension is added to the tiling layer automatically.

---

## Settings

Open preferences with `gnome-extensions prefs tiler@abdulmateenzwl`.

### Appearance tab

| Setting               | Description                              | Default   |
| --------------------- | ---------------------------------------- | --------- |
| Border Width          | Thickness of window borders in pixels    | 2         |
| Border Radius         | Corner radius of borders                 | 12        |
| Focused Border Color  | Border color for the focused window      | Blue      |
| Tiled Border Color    | Border color for unfocused tiled windows | White 85% |
| Floating Border Color | Border color for floating windows        | Amber     |
| Gap Size              | Gap between windows in pixels            | 8         |

### Behaviour tab

| Setting                | Description                                    | Default |
| ---------------------- | ---------------------------------------------- | ------- |
| Float Width            | Default width when a window is floated         | 800     |
| Float Height           | Default height when a window is floated        | 600     |
| Horizontal Resize Step | Pixels per keypress when resizing horizontally | 50      |
| Vertical Resize Step   | Pixels per keypress when resizing vertically   | 50      |

### Keybindings tab

Every shortcut can be changed, cleared, or reset to its default. Click the edit icon next to any shortcut, press the new key combination, and it saves automatically. Click the undo icon to reset to the schema default.

---

## Architecture

Tiler is structured as five cooperating modules:

| File               | Responsibility                                                                      |
| ------------------ | ----------------------------------------------------------------------------------- |
| `extension.js`     | Entry point - wires all modules together                                            |
| `containerTree.js` | BSP tree data model - insert, remove, collapse, restore, swap, insert-relative      |
| `layoutEngine.js`  | Pure recursive layout calculator - takes a tree and a rect, returns pixel positions |
| `windowTracker.js` | GNOME signal management - window lifecycle, state transitions, workspace events     |
| `tileManager.js`   | Applies layouts to real windows - live resize, drag tracking, focus handling        |
| `borderManager.js` | Window border overlays - creation, stacking, color updates                          |
| `resizeManager.js` | Keyboard resize mode - indicator, directional resize, floating resize               |
| `keybindings.js`   | GNOME keybinding registration                                                       |
| `prefs.js`         | Extension preferences UI                                                            |

The layout engine is a pure function with no side effects. All tree mutations happen in `containerTree.js`. `windowTracker.js` owns all GNOME signal connections and emits higher-level events (`window-added`, `window-removed`, `window-maximized` etc.) that `tileManager.js` and `borderManager.js` listen to.

---

## Contributing

Contributions are welcome. Here is how to get started:

### Setting up for development

```bash
git clone https://github.com/abdulmateenzwl/tiler.git \
  ~/.local/share/gnome-shell/extensions/tiler@abdulmateenzwl

glib-compile-schemas \
  ~/.local/share/gnome-shell/extensions/tiler@abdulmateenzwl/schemas/

gnome-extensions enable tiler@abdulmateenzwl
```

Log out and back in to load the extension. After any code change, log out and back in again to reload.

### Viewing logs

```bash
journalctl /usr/bin/gnome-shell -f | grep Tiler
```

### Testing the container tree in isolation

The tree logic can be tested outside GNOME Shell using GJS directly:

```bash
gjs -m ~/.local/share/gnome-shell/extensions/tiler@abdulmateenzwl/test-tree.js
```

### What to work on

Check the TODO section below for planned features. Good first contributions:

- **Window rules** - always float or always tile specific apps by WM class
- **Multi-monitor support** - independent tree per monitor rather than primary only
- **Layout presets** - save and restore named layouts per workspace
- **Focus on close** - when a tiled window closes, focus the most recently used tiled window rather than GNOME's default MRU behaviour

### Guidelines

- Keep all tree mutations inside `containerTree.js`
- Keep `layoutEngine.js` a pure function - no side effects, no global access
- All GNOME signal connections must be stored and disconnected in `disable()`
- Test maximize, minimize, float, and workspace-move after any tree change

### Reporting issues

Please include:

- GNOME Shell version (`gnome-shell --version`)
- The relevant journal output (`journalctl /usr/bin/gnome-shell | grep Tiler`)
- Steps to reproduce

---

## TODO

- When a tiled window is closed, switch focus to the most recently used tiled window instead of GNOME's default MRU
- Multi-monitor support - independent tree per monitor
- Layout presets - quickly switch between common layouts (equal columns, main+stack, centered master)
- Window rules - always float or always tile specific apps by WM class
- Scratchpad workspace - send windows to a hidden workspace and recall them with a keybinding
- Per-workspace layout persistence across sessions
