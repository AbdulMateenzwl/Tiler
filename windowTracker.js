// windowTracker.js
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import { EventEmitter } from 'resource:///org/gnome/shell/misc/signals.js';

export class WindowTracker extends EventEmitter {
    constructor() {
        super();
        this._tilingArray = [];
        this._maximizedStore = [];
        this._minimizedStore = new Map(); // MetaWindow -> unminimize signal id
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

        // Clean up minimized watchers
        for (const [window, id] of this._minimizedStore) {
            window.disconnect(id);
        }
        this._minimizedStore.clear();

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
        const signals = [];

        signals.push(window.connect('unmanaged', () => {
            this._removeFromTiling(window);
            this._maximizedStore = this._maximizedStore.filter(e => e.window !== window);
            // Clean up any minimized watcher too
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
                // Remove from tiling but keep watching for restore
                this._removeFromTiling(window);
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
            this._onMaximizeChanged(window);
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

                // Check if it restored to maximized or normal
                if (window.get_maximized() !== 0) {
                    // Restored to maximized — GNOME handles it
                    // Just watch for future unmaximize
                    this._watchForUnmaximize(window);
                } else {
                    // Restored to normal — add back to tiling as new window
                    this._addToTiling(window);
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

    _onMaximizeChanged(window) {
        const isMaximized = window.get_maximized() !== 0;

        if (isMaximized) {
            const entry = this._removeFromTiling(window);
            if (!entry) return;

            this._maximizedStore.push(entry);
            this.emit('window-removed', window);

            const id = window.connect('notify::maximized-horizontally', () => {
                if (window.get_maximized() === 0) {
                    window.disconnect(id);
                    const stored = this._maximizedStore.find(e => e.window === window);
                    if (stored) {
                        this._maximizedStore = this._maximizedStore.filter(e => e.window !== window);
                        this._tilingArray.push(stored);
                        const wsIndex = window.get_workspace().index();
                        this.emit('window-added', window, wsIndex);
                    }
                }
            });
        }
    }

    _onWindowCreated(window) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._shouldTrack(window))
                this._addToTiling(window);
            return GLib.SOURCE_REMOVE;
        });
    }
}