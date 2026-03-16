# Features

**Core Tiling**
- Auto-tiling of windows in equal columns when opened
- Windows reorganize when any window is closed
- Columns layout engine with gap support

**Window State Management**
- Maximized windows are excluded from tiling layer, GNOME handles them natively
- Unmaximized windows rejoin tiling layer at their original column position
- Minimized windows are removed from tiling layer
- Restored minimized windows rejoin tiling at their original position
- Windows that open in maximized state are watched and tiled when unmaximized

**Workspace Support**
- Each workspace has its own independent tiling layout
- Moving a window to another workspace reorganizes both workspaces

**Focus and Raise Behaviour**
- Focusing any tiled window raises all tiled windows together as a group
- Unmaximizing a window raises all tiled windows so full layout is visible
- Maximizing a tiled window keeps it above tiling layer without interference

**Mouse Interaction**
- Dragging a tiled window with title bar snaps it back to its column with animation
- Dragging with Super+drag also snaps back
- All resize handles supported - left, right, corners, Super+right mouse
- Live resize — neighbouring windows resize in real time as you drag
- Final ratios committed on mouse release

**Width Ratios**
- Each window has a persistent width ratio for the session
- Resizing from right edge redistributes space to right neighbours
- Resizing from left edge redistributes space to left neighbours
- Ratios normalized correctly when windows are added, removed, maximized, minimized

**Keybinding**
- Super+Alt+T retiles all windows on current workspace


# TODO:
- when the a tiled window is closed do not switch to most recently used windows, instead switch to most recently used tiled window