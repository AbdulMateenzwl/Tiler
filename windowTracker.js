// windowTracker.js
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import { EventEmitter } from 'resource:///org/gnome/shell/misc/signals.js';
import { ContainerTree } from './containerTree.js';

export class WindowTracker extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._tree = new ContainerTree();
        this._maximizedWindows = new Set();
        this._minimizedWindows = new Set();
        this._minimizedStore = new Map();   // window → unminimize signal id
        this._windowSignals = new Map();
        this._displaySignals = [];
        this._recentlyUnmaximized = new Set();
        this._floatingWindows = new Set();
        this._floatingSignals = new Map();
        this._unmaximizeStore = new Map();  // moved here from lazy init in _watchForUnmaximize
    }

    enable() {
        this._displaySignals.push(
            global.display.connect('window-created', (_, window) => {
                this._onWindowCreated(window);
            })
        );

        this._displaySignals.push(
            global.workspace_manager.connect('workspace-removed', (_, wsIndex) => {
                this._onWorkspaceRemoved(wsIndex);
            })
        );

        this._displaySignals.push(
            global.workspace_manager.connect('workspace-added', (_, wsIndex) => {
                this._onWorkspaceAdded(wsIndex);
            })
        );

        const existing = global.display.list_all_windows().filter(w => this._shouldTrack(w));
        existing.forEach(window => {
            this._addToTiling(window);
        });
    }

    disable() {
        this._displaySignals.forEach(id => global.display.disconnect(id));
        this._displaySignals = [];

        for (const [window, entry] of this._windowSignals) {
            entry.windowSignals.forEach(id => window.disconnect(id));
            entry.trackerSignals.forEach(id => {
                try { this.disconnect(id); } catch { }
            });
        }
        this._windowSignals.clear();

        for (const [window, id] of this._minimizedStore) {
            window.disconnect(id);
        }
        this._minimizedStore.clear();
        this._maximizedWindows.clear();
        this._minimizedWindows.clear();
        this._recentlyUnmaximized.clear();
        this._floatingWindows.clear();

        for (const [window, signals] of this._floatingSignals) {
            signals.forEach(id => window.disconnect(id));
        }
        this._floatingSignals.clear();

        for (const [window, id] of this._unmaximizeStore) {
            try { window.disconnect(id); } catch { }
        }
        this._unmaximizeStore.clear();
    }

    // ─── Settings Accessors ──────────────────────────────────────────────────────

    _floatWindowWidth() {
        return this._settings.get_int('float-window-width');
    }

    _floatWindowHeight() {
        return this._settings.get_int('float-window-height');
    }

    // ─── Workspace Shift Handling ────────────────────────────────────────────────

    /**
     * Rebuild a Map with all keys shifted according to `shiftFn`.
     * Keys for which `shiftFn` returns null are dropped (used for the removed workspace).
     *
     * @param {Map} map
     * @param {Function} shiftFn  – (idx) → number | null
     * @returns {Map}
     */
    _shiftMapKeys(map, shiftFn) {
        const result = new Map();
        for (const [idx, value] of map) {
            const newIdx = shiftFn(idx);
            if (newIdx !== null) result.set(newIdx, value);
        }
        return result;
    }

    _onWorkspaceRemoved(removedWsIndex) {

        const shift = idx => {
            if (idx < removedWsIndex) return idx;
            if (idx === removedWsIndex) {
                return null;
            }
            return idx - 1;
        };

        this._tree._roots = this._shiftMapKeys(this._tree._roots, shift);
        this._tree._pendingSplitDirection = this._shiftMapKeys(this._tree._pendingSplitDirection, shift);

        this.emit('workspaces-shifted', removedWsIndex);
    }

    _onWorkspaceAdded(addedWsIndex) {
        const maxExisting = Math.max(...this._tree._roots.keys(), -1);
        if (addedWsIndex > maxExisting) return;

        const shift = idx => idx >= addedWsIndex ? idx + 1 : idx;

        this._tree._roots = this._shiftMapKeys(this._tree._roots, shift);
        this._tree._pendingSplitDirection = this._shiftMapKeys(this._tree._pendingSplitDirection, shift);
    }

    // ─── Public API ──────────────────────────────────────────────────────────────

    getWindowsForWorkspace(wsIndex) {
        return this._tree.getWindows(wsIndex);
    }

    getRootForWorkspace(wsIndex) {
        return this._tree.getRoot(wsIndex);
    }

    setPendingSplit(wsIndex, direction) {
        this._tree.setPendingSplit(wsIndex, direction);
    }

    wasRecentlyUnmaximized(window) {
        return this._recentlyUnmaximized.has(window);
    }

    addWindowToTiling(window) {
        if (this._floatingWindows.has(window)) return;
        this._addToTiling(window);
    }

    // ─── Shared Tree Helpers ─────────────────────────────────────────────────────

    _shouldTrack(window) {
        if (window.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (window.is_skip_taskbar()) return false;
        if (window.minimized) return false;
        if (window.get_maximized() !== 0) return false;
        return true;
    }

    /**
     * Collapse a window out of the tile tree and emit 'window-removed'.
     * Disconnects window signals so the window stops being tracked.
     */
    _collapseFromTiling(window, wsIndex) {
        this._tree.collapseNode(window, wsIndex);
        this._disconnectWindowSignals(window);
        this.emit('window-removed', window, wsIndex);
    }

    /**
     * Restore a window back into the tile tree and emit 'window-added'.
     * Reconnects window signals so the window is tracked again.
     */
    _restoreToTiling(window, wsIndex) {
        this._tree.restoreNode(window, wsIndex);
        this._connectWindowSignals(window);
        this.emit('window-added', window, wsIndex);
    }

    /**
     * Mark a window as recently unmaximized and auto-clear after 1 second.
     */
    _markRecentlyUnmaximized(window) {
        this._recentlyUnmaximized.add(window);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._recentlyUnmaximized.delete(window);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Tear down and remove floating signals for a window.
     */
    _clearFloatingSignals(window) {
        const sigs = this._floatingSignals.get(window);
        if (sigs) {
            sigs.forEach(id => window.disconnect(id));
            this._floatingSignals.delete(window);
        }
    }

    // ─── Float / Unfloat ─────────────────────────────────────────────────────────

    toggleFloat(window) {
        const wsIndex = window.get_workspace().index();

        if (this._floatingWindows.has(window)) {
            if (window.get_maximized() !== 0) return;

            this._floatingWindows.delete(window);
            this._clearFloatingSignals(window);

            this._restoreToTiling(window, wsIndex);
            this.emit('window-unfloating', window, wsIndex);
        } else {
            const leaf = this._tree.findLeaf(window, this._tree.getRoot(wsIndex));
            if (!leaf) return;

            if (window.get_maximized() !== 0) {

                const id = window.connect('notify::maximized-horizontally', () => {
                    if (window.get_maximized() === 0) {
                        window.disconnect(id);
                        this._tree.restoreNode(window, wsIndex);
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                            this._floatWindow(window, wsIndex);
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                });

                this._maximizedWindows.delete(window);
                this._disconnectWindowSignals(window);
                window.unmaximize(Meta.MaximizeFlags.BOTH);
                return;
            }

            if (leaf.ratio === 0) return;
            this._floatWindow(window, wsIndex);
        }
    }

    _floatWindow(window, wsIndex) {
        const leaf = this._tree.findLeaf(window, this._tree.getRoot(wsIndex));
        if (!leaf) return;

        this._floatingWindows.add(window);
        this._collapseFromTiling(window, wsIndex);
        this.emit('window-floating', window, wsIndex);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            const frame = window.get_frame_rect();
            this._resizeToFloat(window, wsIndex);
            const frame2 = window.get_frame_rect();
            return GLib.SOURCE_REMOVE;
        });

        this._watchFloatingWindow(window, wsIndex);
    }

    _resizeToFloat(window, wsIndex) {
        const workspace = global.workspace_manager.get_workspace_by_index(wsIndex);
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);

        const floatWindowWidth = this._floatWindowWidth();
        const floatWindowHeight = this._floatWindowHeight();

        const x = workArea.x + Math.floor((workArea.width - floatWindowWidth) / 2);
        const y = workArea.y + Math.floor((workArea.height - floatWindowHeight) / 2);

        window.move_resize_frame(false, x, y, floatWindowWidth, floatWindowHeight);
    }

    _watchFloatingWindow(window, wsIndex) {
        const signals = [];

        signals.push(window.connect('unmanaged', () => {
            this._clearFloatingSignals(window);
            this._floatingWindows.delete(window);
            this._tree.removeWindow(window, wsIndex);
            this.emit('window-removed', window, wsIndex);

            const unMaxId = this._unmaximizeStore.get(window);
            if (unMaxId) {
                try { window.disconnect(unMaxId); } catch { }
                this._unmaximizeStore.delete(window);
            }
        }));

        signals.push(window.connect('notify::maximized-horizontally', () => {
            const maximized = window.get_maximized();
            if (maximized === 3) {
                this.emit('window-float-maximized', window);
            } else if (maximized === 0) {
                this.emit('window-float-restored', window);
            }
        }));

        signals.push(window.connect('notify::minimized', () => {
            if (window.minimized) {
                this.emit('window-float-maximized', window);
            } else {
                this.emit('window-float-restored', window);
            }
        }));

        this._floatingSignals.set(window, signals);
    }

    // ─── Tiling Add / Remove ─────────────────────────────────────────────────────

    _addToTiling(window) {
        const wsIndex = window.get_workspace().index();

        if (this._tree.findLeaf(window, null, wsIndex)) return;

        const focusedWindow = global.display.focus_window;
        const focused = focusedWindow !== window ? focusedWindow : null;

        this._tree.insertWindow(window, wsIndex, focused);
        this._connectWindowSignals(window);
        this.emit('window-added', window, wsIndex);
    }

    _addToTilingWithFocus(window, wsIndex, focusedWindow) {
        if (this._tree.findLeaf(window, null, wsIndex)) return;

        this._tree.insertWindow(window, wsIndex, focusedWindow);
        this._connectWindowSignals(window);
        this.emit('window-added', window, wsIndex);
    }

    // ─── Window Signal Management ────────────────────────────────────────────────

    _connectWindowSignals(window) {
        // Always disconnect first to prevent stale or duplicate signals
        if (this._windowSignals.has(window)) {
            this._disconnectWindowSignals(window);
        }

        let savedWsIndex = window.get_workspace().index();
        const windowSignals = [];
        const trackerSignals = [];

        windowSignals.push(window.connect('unmanaged', () => {
            this._tree.removeWindow(window, savedWsIndex);
            this._maximizedWindows.delete(window);
            this._minimizedWindows.delete(window);
            const minId = this._minimizedStore.get(window);
            if (minId) {
                window.disconnect(minId);
                this._minimizedStore.delete(window);
            }
            this._disconnectWindowSignals(window);
            this.emit('window-removed', window, savedWsIndex);
        }));

        windowSignals.push(window.connect('notify::minimized', () => {
            if (window.minimized) {
                const wsIndex = window.get_workspace().index();

                if (this._maximizedWindows.has(window)) {
                    // Already collapsed from maximize — just watch for restore.
                    // Don't call collapseNode again or savedRatio gets corrupted.
                    this._minimizedWindows.add(window);
                    this.emit('window-removed', window, wsIndex);
                    this._disconnectWindowSignals(window);
                    this._watchForUnminimize(window);
                    return;
                }

                this._minimizedWindows.add(window);
                this._collapseFromTiling(window, wsIndex);
                this._watchForUnminimize(window);
            }
        }));

        windowSignals.push(window.connect('workspace-changed', () => {
            const ws = window.get_workspace();
            if (!ws) return;
            const newWsIndex = ws.index();
            this._tree.moveToWorkspace(window, savedWsIndex, newWsIndex);
            this.emit('window-workspace-changed', window, newWsIndex);
            savedWsIndex = newWsIndex;
        }));

        windowSignals.push(window.connect('notify::maximized-horizontally', () => {
            const maximized = window.get_maximized();
            const wsIndex = window.get_workspace().index();

            const isFullyMaximized = maximized === 3;
            const isPartiallyMaximized = maximized === 1 || maximized === 2;

            if (isFullyMaximized) {
                this._maximizedWindows.add(window);
                this._tree.collapseNode(window, wsIndex);
                this.emit('window-removed', window, wsIndex);
                this.emit('window-maximized', window, wsIndex);
            } else if (isPartiallyMaximized) {
                // GNOME half-tiling (Super+Arrow) — ignore completely.
                // Don't touch the tiling layer.
                return;
            } else if (maximized === 0 && this._maximizedWindows.has(window)) {
                this._maximizedWindows.delete(window);
                this._tree.restoreNode(window, wsIndex);
                this._recentlyUnmaximized.add(window);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    this._recentlyUnmaximized.delete(window);
                    return GLib.SOURCE_REMOVE;
                });
                this.emit('window-added', window, wsIndex);
                this.emit('window-unmaximized', window, wsIndex);
            } else if (maximized === 0 && !this._maximizedWindows.has(window)) {
                const leaf = this._tree.findLeaf(window, this._tree.getRoot(wsIndex));
                if (!leaf) {
                    if (this._shouldTrack(window)) {
                        this._addToTiling(window);
                    }
                } else if (leaf.ratio === 0) {
                    // In tree but collapsed — restore it
                    this._tree.restoreNode(window, wsIndex);
                    this.emit('window-added', window, wsIndex);
                }
            }
        }));

        trackerSignals.push(this.connect('workspaces-shifted', (_, removedWsIndex) => {
            if (savedWsIndex > removedWsIndex) {
                savedWsIndex -= 1;
            }
        }));

        this._windowSignals.set(window, { windowSignals, trackerSignals });
    }

    _disconnectWindowSignals(window) {
        const entry = this._windowSignals.get(window);
        if (!entry) return;

        entry.windowSignals?.forEach(id => {
            try { window.disconnect(id); } catch { }
        });
        entry.trackerSignals?.forEach(id => {
            try { this.disconnect(id); } catch { }
        });

        this._windowSignals.delete(window);
    }

    _watchForUnminimize(window) {
        const id = window.connect('notify::minimized', () => {
            if (!window.minimized) {
                window.disconnect(id);
                this._minimizedStore.delete(window);
                this._minimizedWindows.delete(window);

                if (window.get_maximized() !== 0) {
                    // Restored to maximized state
                    if (this._maximizedWindows.has(window)) {
                        this._connectWindowSignals(window);
                    } else {
                        this._watchForUnmaximize(window);
                    }
                } else {
                    const wsIndex = window.get_workspace().index();
                    if (this._maximizedWindows.has(window)) {
                        this._maximizedWindows.delete(window);
                        this._tree.restoreNode(window, wsIndex);
                        this._connectWindowSignals(window);
                        this._recentlyUnmaximized.add(window);
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                            this._recentlyUnmaximized.delete(window);
                            return GLib.SOURCE_REMOVE;
                        });
                        this.emit('window-added', window, wsIndex);
                        this.emit('window-unmaximized', window, wsIndex);
                    } else {
                        this._restoreToTiling(window, wsIndex);
                    }
                }
            }
        });
        this._minimizedStore.set(window, id);
    }

    _watchForUnmaximize(window) {
        const existing = this._unmaximizeStore.get(window);
        if (existing) {
            try { window.disconnect(existing); } catch { }
        }

        const id = window.connect('notify::maximized-horizontally', () => {
            const maximized = window.get_maximized();
            if (maximized === 0) {
                try { window.disconnect(id); } catch { }
                this._unmaximizeStore.delete(window);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    if (window.get_maximized() === 0 && this._shouldTrack(window)) {
                        this._addToTiling(window);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        this._unmaximizeStore.set(window, id);
    }

    _onWindowCreated(window) {
        // Capture focused window and pending split immediately — before any delay
        const wsIndex = window.get_workspace()?.index() ?? 0;
        const focusedWindow = global.display.focus_window;
        const capturedFocus = focusedWindow !== window ? focusedWindow : null;
        const hasPendingSplit = this._tree._pendingSplitDirection.has(wsIndex);
        const pendingSplitDir = hasPendingSplit ? this._tree.getPendingSplit(wsIndex) : null;

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                const maximized = window.get_maximized();

                if (window.get_window_type() === Meta.WindowType.NORMAL
                    && !window.is_skip_taskbar()
                    && maximized !== 0) {
                    this._watchForUnmaximize(window);
                    return GLib.SOURCE_REMOVE;
                }

                if (this._shouldTrack(window)) {
                    if (pendingSplitDir) {
                        this._tree.setPendingSplit(wsIndex, pendingSplitDir);
                    }
                    this._addToTilingWithFocus(window, wsIndex, capturedFocus);
                }

                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }
}