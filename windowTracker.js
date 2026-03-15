// windowTracker.js
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import { EventEmitter } from 'resource:///org/gnome/shell/misc/signals.js';

export class WindowTracker extends EventEmitter {
    constructor() {
        super();
        // tilingArray: [{index, id, window}] sorted by index
        this._tilingArray = [];
        // maximizedStore: [{index, id, window}] — removed from tiling but remembered
        this._maximizedStore = [];
        // counter for assigning unique permanent indices
        this._nextIndex = 1;
        // per-window signal ids: Map<MetaWindow, number[]>
        this._windowSignals = new Map();
        this._displaySignals = [];
    }

    enable() {
        this._displaySignals.push(
            global.display.connect('window-created', (_, window) => {
                this._onWindowCreated(window);
            })
        );

        // Track already-open windows on startup
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
        this._tilingArray = [];
        this._maximizedStore = [];
        this._nextIndex = 1;
    }

    // Returns windows for a workspace in column order
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
        // Unique id: pid + window's XID/wayland id
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
            this._disconnectWindowSignals(window);
            this.emit('window-removed', window);
        }));

        signals.push(window.connect('notify::minimized', () => {
            if (window.minimized) {
                this._removeFromTiling(window);
                this._disconnectWindowSignals(window);
                this.emit('window-removed', window);
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

    _onMaximizeChanged(window) {
        const isMaximized = window.get_maximized() !== 0;

        if (isMaximized) {
            const entry = this._removeFromTiling(window);
            if (!entry) return;

            // Save to maximized store with its permanent index
            this._maximizedStore.push(entry);
            this.emit('window-removed', window);

            // Watch for unmaximize
            const id = window.connect('notify::maximized-horizontally', () => {
                if (window.get_maximized() === 0) {
                    window.disconnect(id);
                    // Restore to tiling with original index
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