// windowTracker.js
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import { EventEmitter } from 'resource:///org/gnome/shell/misc/signals.js';

export class WindowTracker extends EventEmitter {
    constructor() {
        super();
        this._tilingArray = [];
        this._maximizedStore = [];
        this._minimizedStore = new Map();
        this._minimizedPositionStore = [];
        this._nextIndex = 1;
        this._windowSignals = new Map();
        this._displaySignals = [];
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
        this._minimizedPositionStore = [];

        this._tilingArray = [];
        this._maximizedStore = [];
        this._nextIndex = 1;
    }

    getWindowsForWorkspace(workspaceIndex) {
        return this._tilingArray
            .filter(entry => entry.window.get_workspace().index() === workspaceIndex)
            .sort((a, b) => a.index - b.index)
            .map(entry => entry.window);
    }

    _shouldTrack(window) {
        if (window.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
        if (window.is_skip_taskbar())
            return false;
        if (window.minimized)
            return false;
        if (window.get_maximized() !== 0)
            return false;
        return true;
    }

    _generateId(window) {
        return `${window.get_pid()}-${window.get_id()}`;
    }

    _addToTiling(window, index = null) {
        // Guard against double tracking
        if (this._tilingArray.some(e => e.window === window)) return;

        const assignedIndex = index !== null ? index : this._nextIndex++;
        const id = this._generateId(window);

        this._tilingArray.push({ index: assignedIndex, id, window });
        this._connectWindowSignals(window);

        const wsIndex = window.get_workspace().index();
        this.emit('window-added', window, wsIndex);
    }

    _removeFromTiling(window) {
        const i = this._tilingArray.findIndex(e => e.window === window);
        if (i === -1) return null;
        const [entry] = this._tilingArray.splice(i, 1);
        return entry;
    }

    _connectWindowSignals(window) {
        // Guard against double connecting
        if (this._windowSignals.has(window)) return;

        const signals = [];

        signals.push(window.connect('unmanaged', () => {
            this._removeFromTiling(window);
            this._maximizedStore = this._maximizedStore.filter(e => e.window !== window);
            this._minimizedPositionStore = this._minimizedPositionStore.filter(e => e.window !== window);
            const minId = this._minimizedStore.get(window);
            if (minId) {
                window.disconnect(minId);
                this._minimizedStore.delete(window);
            }
            this._disconnectWindowSignals(window);
            this.emit('window-removed', window);
        }));

        signals.push(window.connect('notify::minimized', () => {
            if (window.minimized) {
                const entry = this._removeFromTiling(window);
                if (entry) this._minimizedPositionStore.push(entry); // save position
                this._disconnectWindowSignals(window);
                this.emit('window-removed', window);
                this._watchForUnminimize(window);
            }
        }));

        signals.push(window.connect('workspace-changed', () => {
            const wsIndex = window.get_workspace().index();
            this.emit('window-workspace-changed', window, wsIndex);
        }));

        signals.push(window.connect('notify::maximized-horizontally', () => {
            const isMaximized = window.get_maximized() !== 0;
            const wsIndex = window.get_workspace().index();

            if (isMaximized) {
                const entry = this._removeFromTiling(window);
                if (!entry) return;
                this._maximizedStore.push(entry);
                this.emit('window-removed', window);
                this.emit('window-maximized', window, wsIndex);
            } else {
                const stored = this._maximizedStore.find(e => e.window === window);
                if (stored) {
                    this._maximizedStore = this._maximizedStore.filter(e => e.window !== window);
                    this._tilingArray.push(stored);
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

                if (window.get_maximized() !== 0) {
                    // Restored to maximized — clean up position store, watch for unmaximize
                    this._minimizedPositionStore = this._minimizedPositionStore.filter(e => e.window !== window);
                    this._watchForUnmaximize(window);
                } else {
                    // Restore to original tiling position
                    const stored = this._minimizedPositionStore.find(e => e.window === window);
                    if (stored) {
                        this._minimizedPositionStore = this._minimizedPositionStore.filter(e => e.window !== window);
                        this._tilingArray.push(stored);
                        this._connectWindowSignals(window);
                        const wsIndex = window.get_workspace().index();
                        this.emit('window-added', window, wsIndex);
                    } else {
                        // No saved position, add as new window
                        this._addToTiling(window);
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