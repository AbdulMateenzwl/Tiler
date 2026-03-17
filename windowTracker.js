// windowTracker.js
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import { EventEmitter } from 'resource:///org/gnome/shell/misc/signals.js';
import { ContainerTree } from './containerTree.js';

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
    }

    enable() {
        this._displaySignals.push(
            global.display.connect('window-created', (_, window) => {
                this._onWindowCreated(window);
            })
        );

        global.display.list_all_windows().forEach(window => {
            if (this._shouldTrack(window))
                this._addToTiling(window);
        });
    }

    disable() {
        this._displaySignals.forEach(id => global.display.disconnect(id));
        this._displaySignals = [];

        for (const [window, signals] of this._windowSignals) {
            signals.forEach(id => window.disconnect(id));
        }
        this._windowSignals.clear();

        for (const [window, id] of this._minimizedStore) {
            window.disconnect(id);
        }
        this._minimizedStore.clear();
        this._maximizedWindows.clear();
        this._minimizedWindows.clear();
        this._recentlyUnmaximized.clear();
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

    _addToTiling(window) {
        const wsIndex = window.get_workspace().index();
        if (this._tree.findLeaf(window, null, wsIndex)) return;

        const focusedWindow = global.display.focus_window;
        const focused = focusedWindow !== window ? focusedWindow : null;

        this._tree.insertWindow(window, wsIndex, focused);
        this._connectWindowSignals(window);
        this.emit('window-added', window, wsIndex);
    }

    _connectWindowSignals(window) {
        if (this._windowSignals.has(window)) return;

        let savedWsIndex = window.get_workspace().index();
        const signals = [];

        signals.push(window.connect('unmanaged', () => {
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

        signals.push(window.connect('notify::minimized', () => {
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

        signals.push(window.connect('workspace-changed', () => {
            const newWsIndex = window.get_workspace().index();
            this._tree.moveToWorkspace(window, savedWsIndex, newWsIndex);
            this.emit('window-workspace-changed', window, newWsIndex);
            savedWsIndex = newWsIndex;
        }));

        signals.push(window.connect('notify::maximized-horizontally', () => {
            const isMaximized = window.get_maximized() !== 0;
            const wsIndex = window.get_workspace().index();

            if (isMaximized) {
                this._maximizedWindows.add(window);

                // Collapse node — keeps leaf but zeroes ratio
                this._tree.collapseNode(window, wsIndex);
                this.emit('window-removed', window, wsIndex);
                this.emit('window-maximized', window, wsIndex);
            } else {
                if (this._maximizedWindows.has(window)) {
                    this._maximizedWindows.delete(window);

                    // Restore node — restores ratio and renormalizes
                    this._tree.restoreNode(window, wsIndex);

                    this._recentlyUnmaximized.add(window);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                        this._recentlyUnmaximized.delete(window);
                        return GLib.SOURCE_REMOVE;
                    });

                    this.emit('window-added', window, wsIndex);
                    this.emit('window-unmaximized', window, wsIndex);
                }
            }
        }));

        this._windowSignals.set(window, signals);
    }

    _disconnectWindowSignals(window) {
        const signals = this._windowSignals.get(window);
        if (!signals) return;
        signals.forEach(id => window.disconnect(id));
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
        const id = window.connect('notify::maximized-horizontally', () => {
            if (window.get_maximized() === 0) {
                window.disconnect(id);
                if (this._shouldTrack(window))
                    this._addToTiling(window);
            }
        });
    }

    _onWindowCreated(window) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const maximized = window.get_maximized();
            if (this._shouldTrack(window)) {
                this._addToTiling(window);
            } else if (window.get_window_type() === Meta.WindowType.NORMAL
                && !window.is_skip_taskbar()
                && maximized !== 0) {
                this._watchForUnmaximize(window);
            }
            return GLib.SOURCE_REMOVE;
        });
    }
}