// windowTracker.js
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import { EventEmitter } from 'resource:///org/gnome/shell/misc/signals.js';
import { ContainerTree } from './containerTree.js';


const FLOAT_WIDTH = 800;
const FLOAT_HEIGHT = 600;


export class WindowTracker extends EventEmitter {
    constructor() {
        super();
        this._tree = new ContainerTree();
        this._maximizedWindows = new Set(); // windows currently maximized
        this._minimizedWindows = new Set(); // windows currently minimized
        this._minimizedStore = new Map();   // window -> unminimize signal id
        this._windowSignals = new Map();
        this._displaySignals = [];
        this._recentlyUnmaximized = new Set();
        this._floatingWindows = new Set();
        this._floatingSignals = new Map();
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
        console.log(`[Tiler] enable: found ${existing.length} existing windows`);
        existing.forEach(window => {
            console.log(`[Tiler] enable: adding "${window.get_title()}"`);
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

        if (this._floatingSignals) {
            for (const [window, signals] of this._floatingSignals) {
                signals.forEach(id => window.disconnect(id));
            }
            this._floatingSignals.clear();
        }

        if (this._unmaximizeStore) {
            for (const [window, id] of this._unmaximizeStore) {
                try { window.disconnect(id); } catch { }
            }
            this._unmaximizeStore.clear();
        }
    }

    _onWorkspaceRemoved(removedWsIndex) {
        console.log(`[Tiler] workspace-removed: wsIndex=${removedWsIndex}`);

        // Shift all roots with index > removedWsIndex down by 1
        const newRoots = new Map();
        for (const [idx, root] of this._tree._roots) {
            if (idx < removedWsIndex) {
                newRoots.set(idx, root);
            } else if (idx === removedWsIndex) {
                // This workspace was removed — discard its tree
                // Windows should already be gone since GNOME only removes empty workspaces
                console.log(`[Tiler] dropping tree for removed workspace ${idx}`);
            } else {
                // Shift down by 1
                newRoots.set(idx - 1, root);
            }
        }
        this._tree._roots = newRoots;

        // Also shift pending splits
        const newPending = new Map();
        for (const [idx, direction] of this._tree._pendingSplitDirection) {
            if (idx < removedWsIndex) {
                newPending.set(idx, direction);
            } else if (idx > removedWsIndex) {
                newPending.set(idx - 1, direction);
            }
            // idx === removedWsIndex is dropped
        }
        this._tree._pendingSplitDirection = newPending;

        // Update savedWsIndex for all tracked windows
        // savedWsIndex is a closure variable inside _connectWindowSignals
        // so we emit a signal to let windows know their index shifted
        this.emit('workspaces-shifted', removedWsIndex);
    }

    _onWorkspaceAdded(addedWsIndex) {
        // Only shift if workspace inserted before existing ones
        // GNOME typically appends at the end so this is usually a no-op
        const maxExisting = Math.max(...this._tree._roots.keys(), -1);
        if (addedWsIndex > maxExisting) return; // appended at end — no shift needed

        const newRoots = new Map();
        for (const [idx, root] of this._tree._roots) {
            newRoots.set(idx >= addedWsIndex ? idx + 1 : idx, root);
        }
        this._tree._roots = newRoots;

        const newPending = new Map();
        for (const [idx, direction] of this._tree._pendingSplitDirection) {
            newPending.set(idx >= addedWsIndex ? idx + 1 : idx, direction);
        }
        this._tree._pendingSplitDirection = newPending;
    }

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

    _shouldTrack(window) {
        if (window.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (window.is_skip_taskbar()) return false;
        if (window.minimized) return false;
        if (window.get_maximized() !== 0) return false;
        return true;
    }

    toggleFloat(window) {
        const wsIndex = window.get_workspace().index();

        if (this._floatingWindows.has(window)) {
            // Don't untile if floating window is currently maximized
            if (window.get_maximized() !== 0) return;

            // Window is floating — retile it
            this._floatingWindows.delete(window);

            // Clean up floating signals
            const sigs = this._floatingSignals?.get(window);
            if (sigs) {
                sigs.forEach(id => window.disconnect(id));
                this._floatingSignals.delete(window);
            }

            this._tree.restoreNode(window, wsIndex);
            this._connectWindowSignals(window);
            this.emit('window-added', window, wsIndex);

            // When window stops floating
            this.emit('window-unfloating', window, wsIndex);
        } else {
            // Window is tiled — float it
            const leaf = this._tree.findLeaf(window, this._tree.getRoot(wsIndex));
            if (!leaf) return;

            if (window.get_maximized() !== 0) {
                console.log(`[Tiler] toggleFloat: window is maximized=${window.get_maximized()} — unmaximizing first`);

                // Connect listener FIRST before anything else
                const id = window.connect('notify::maximized-horizontally', () => {
                    console.log(`[Tiler] toggleFloat: unmaximize signal fired maximized=${window.get_maximized()}`);
                    if (window.get_maximized() === 0) {
                        window.disconnect(id);
                        console.log(`[Tiler] toggleFloat: now floating window`);
                        this._tree.restoreNode(window, wsIndex);
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                            this._floatWindow(window, wsIndex);
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                });

                // Now remove from tracking and disconnect window signals
                this._maximizedWindows.delete(window);
                this._disconnectWindowSignals(window);

                // Unmaximize last
                window.unmaximize(Meta.MaximizeFlags.BOTH);
                return;
            }

            // Window is normal tiled — float directly
            if (leaf.ratio === 0) return;
            this._floatWindow(window, wsIndex);
        }
    }

    _floatWindow(window, wsIndex) {
        const leaf = this._tree.findLeaf(window, this._tree.getRoot(wsIndex));
        console.log(`[Tiler] _floatWindow: "${window.get_title()}" leaf=${!!leaf} leafRatio=${leaf?.ratio}`);
        if (!leaf) return;

        this._floatingWindows.add(window);
        this._tree.collapseNode(window, wsIndex);
        this._disconnectWindowSignals(window);
        this.emit('window-removed', window, wsIndex);
        this.emit('window-floating', window, wsIndex);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            const frame = window.get_frame_rect();
            console.log(`[Tiler] _floatWindow: before resize frame=${frame.x},${frame.y} ${frame.width}x${frame.height}`);
            this._resizeToFloat(window, wsIndex);
            const frame2 = window.get_frame_rect();
            console.log(`[Tiler] _floatWindow: after resize frame=${frame2.x},${frame2.y} ${frame2.width}x${frame2.height}`);
            return GLib.SOURCE_REMOVE;
        });

        this._watchFloatingWindow(window, wsIndex);
    }

    _resizeToFloat(window, wsIndex) {
        const workspace = global.workspace_manager.get_workspace_by_index(wsIndex);
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);

        const x = workArea.x + Math.floor((workArea.width - FLOAT_WIDTH) / 2);
        const y = workArea.y + Math.floor((workArea.height - FLOAT_HEIGHT) / 2);

        console.log(`[Tiler] _resizeToFloat: "${window.get_title()}" target=${x},${y} ${FLOAT_WIDTH}x${FLOAT_HEIGHT}`);
        window.move_resize_frame(false, x, y, FLOAT_WIDTH, FLOAT_HEIGHT);
    }

    _watchFloatingWindow(window, wsIndex) {
        const signals = [];

        signals.push(window.connect('unmanaged', () => {
            const sigs = this._floatingSignals?.get(window);
            if (sigs) {
                sigs.forEach(id => window.disconnect(id));
                this._floatingSignals.delete(window);
            }
            this._floatingWindows.delete(window);
            this._tree.removeWindow(window, wsIndex);
            this.emit('window-removed', window, wsIndex);

            const unMaxId = this._unmaximizeStore?.get(window);
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

    _addToTiling(window) {
        const wsIndex = window.get_workspace().index();
        const existing = this._tree.findLeaf(window, null, wsIndex);
        console.log(`[Tiler] addToTiling: "${window.get_title()}" wsIndex=${wsIndex} alreadyInTree=${!!existing}`);

        if (this._tree.findLeaf(window, null, wsIndex)) return;

        const focusedWindow = global.display.focus_window;
        const focused = focusedWindow !== window ? focusedWindow : null;

        this._tree.insertWindow(window, wsIndex, focused);
        this._connectWindowSignals(window);
        this.emit('window-added', window, wsIndex);
    }

    _connectWindowSignals(window) {

        // Always disconnect first to prevent stale or duplicate signals
        if (this._windowSignals.has(window)) {
            this._disconnectWindowSignals(window);
        }

        if (this._windowSignals.has(window)) return;

        let savedWsIndex = window.get_workspace().index();
        const windowSignals = [];
        const trackerSignals = [];

        windowSignals.push(window.connect('unmanaged', () => {
            console.log(`[Tiler] unmanaged: "${window.get_title()}" ws=${savedWsIndex}`);
            console.log(`[Tiler] tree before: ${JSON.stringify(this._tree.getWindows(savedWsIndex).map(w => w.get_title()))}`);
            this._tree.removeWindow(window, savedWsIndex);
            console.log(`[Tiler] tree after: ${JSON.stringify(this._tree.getWindows(savedWsIndex).map(w => w.get_title()))}`);
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
                    // Already collapsed from maximize — just watch for restore
                    // Don't call collapseNode again or savedRatio gets corrupted
                    this._minimizedWindows.add(window);
                    this.emit('window-removed', window, wsIndex);
                    this._disconnectWindowSignals(window);
                    this._watchForUnminimize(window);
                    return;
                }

                this._minimizedWindows.add(window);
                this._tree.collapseNode(window, wsIndex);
                this.emit('window-removed', window, wsIndex);
                this._disconnectWindowSignals(window);
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

            console.log(`[Tiler] maximized-horizontally: "${window.get_title()}" get_maximized()=${window.get_maximized()} isMaximized=${maximized} ws=${wsIndex}`);

            const isFullyMaximized = maximized === 3;
            const isPartiallyMaximized = maximized === 1 || maximized === 2;

            if (isFullyMaximized) {
                this._maximizedWindows.add(window);
                this._tree.collapseNode(window, wsIndex);
                this.emit('window-removed', window, wsIndex);
                this.emit('window-maximized', window, wsIndex);
            } else if (isPartiallyMaximized) {
                // GNOME half-tiling (Super+Arrow) — ignore completely
                // Don't touch the tiling layer
                // TODO: if we want to support this, we'll need to track it separately from full maximize and restore to the correct state on unmaximize
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

        // Listen for workspace shifts on tracker itself
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

        if (Array.isArray(entry)) {
            // Old format — plain array of window signal ids
            entry.forEach(id => {
                try { window.disconnect(id); } catch { }
            });
        } else {
            // New format — {windowSignals, trackerSignals}
            entry.windowSignals?.forEach(id => {
                try { window.disconnect(id); } catch { }
            });
            entry.trackerSignals?.forEach(id => {
                try { this.disconnect(id); } catch { }
            });
        }

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
                    // If it was already tracked as maximized, just reconnect signals
                    if (this._maximizedWindows.has(window)) {
                        this._connectWindowSignals(window);
                    } else {
                        this._watchForUnmaximize(window);
                    }
                } else {
                    // Restored to normal — restore node in tree
                    const wsIndex = window.get_workspace().index();
                    // If it was previously maximized, it's already in tree with ratio=0
                    // restoreNode will bring it back
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
                        this._tree.restoreNode(window, wsIndex);
                        this._connectWindowSignals(window);
                        this.emit('window-added', window, wsIndex);
                    }
                }
            }
        });
        this._minimizedStore.set(window, id);
    }

    _watchForUnmaximize(window) {
        // Guard — if already watching, disconnect old one first
        const existing = this._unmaximizeStore?.get(window);
        if (existing) {
            try { window.disconnect(existing); } catch { }
        }

        const id = window.connect('notify::maximized-horizontally', () => {
            const maximized = window.get_maximized();
            if (maximized === 0) {
                try { window.disconnect(id); } catch { }
                this._unmaximizeStore?.delete(window);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    if (window.get_maximized() === 0 && this._shouldTrack(window)) {
                        this._addToTiling(window);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        this._unmaximizeStore = this._unmaximizeStore ?? new Map();
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
                console.log(`[Tiler] onWindowCreated: "${window.get_title()}" maximized=${maximized} shouldTrack=${this._shouldTrack(window)}`);

                if (window.get_window_type() === Meta.WindowType.NORMAL
                    && !window.is_skip_taskbar()
                    && maximized !== 0) {
                    this._watchForUnmaximize(window);
                    return GLib.SOURCE_REMOVE;
                }

                if (this._shouldTrack(window)) {
                    // Restore pending split before adding — it may have been cleared during delay
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

    _addToTilingWithFocus(window, wsIndex, focusedWindow) {
        if (this._tree.findLeaf(window, null, wsIndex)) return;

        this._tree.insertWindow(window, wsIndex, focusedWindow);
        this._connectWindowSignals(window);
        this.emit('window-added', window, wsIndex);
    }

    addWindowToTiling(window) {
        if (this._floatingWindows.has(window)) return;
        this._addToTiling(window);
    }
}