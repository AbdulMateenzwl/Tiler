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
        this._minimizedPositionStore = [];

        this._tilingArray = [];
        this._maximizedStore = [];
        this._nextIndex = 1;
    }

    _assignInitialRatio(wsIndex) {
        const entries = this._tilingArray.filter(e => e.window.get_workspace().index() === wsIndex);
        const count = entries.length;
        if (count === 0) return;
        const equal = 1.0 / count;
        entries.forEach(e => e.widthRatio = equal);
    }

    _normalizeRatios(wsIndex) {
        const entries = this._tilingArray.filter(e => e.window.get_workspace().index() === wsIndex);
        if (entries.length === 0) return;

        const sum = entries.reduce((acc, e) => acc + e.widthRatio, 0);
        if (sum === 0) {
            // Fallback to equal ratios if sum is 0
            const equal = 1.0 / entries.length;
            entries.forEach(e => e.widthRatio = equal);
            return;
        }

        entries.forEach(e => e.widthRatio = e.widthRatio / sum);
    }

    wasRecentlyUnmaximized(window) {
        return this._recentlyUnmaximized.has(window);
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
        if (this._tilingArray.some(e => e.window === window)) return;

        const assignedIndex = index !== null ? index : this._nextIndex++;
        const id = this._generateId(window);

        this._tilingArray.push({ index: assignedIndex, id, window, widthRatio: 0 });
        this._connectWindowSignals(window);

        const wsIndex = window.get_workspace().index();
        // Reassign equal ratios to all windows on this workspace
        this._assignInitialRatio(wsIndex);

        this.emit('window-added', window, wsIndex);
    }

    _removeFromTiling(window, normalize = true, wsIndex = null) {
        const i = this._tilingArray.findIndex(e => e.window === window);
        if (i === -1) return null;
        const [entry] = this._tilingArray.splice(i, 1);

        if (normalize) {
            const idx = wsIndex ?? (() => {
                try { return entry.window.get_workspace()?.index(); } catch { return null; }
            })();
            if (idx !== null && idx !== undefined)
                this._normalizeRatios(idx);
        }

        return entry;
    }

    getWindowsWithRatiosForWorkspace(workspaceIndex) {
        const all = this._tilingArray.map(e => ({
            title: e.window.get_title(),
            wsIndex: e.window.get_workspace()?.index(),
            ratio: e.widthRatio,
            index: e.index
        }));
        console.log(`[Tiler] tilingArray dump for ws=${workspaceIndex}:`, JSON.stringify(all));

        return this._tilingArray
            .filter(entry => entry.window.get_workspace().index() === workspaceIndex)
            .sort((a, b) => a.index - b.index)
            .map(entry => ({ window: entry.window, widthRatio: entry.widthRatio }));
    }

    updateWindowRatio(window, newRatio, side) {
        const wsIndex = window.get_workspace().index();
        const entries = this._tilingArray
            .filter(e => e.window.get_workspace().index() === wsIndex)
            .sort((a, b) => a.index - b.index);

        const targetEntry = entries.find(e => e.window === window);
        if (!targetEntry) return;

        const oldRatio = targetEntry.widthRatio;
        const delta = newRatio - oldRatio;

        // Get neighbours based on which side was resized
        const targetIdx = entries.indexOf(targetEntry);
        const neighbours = side === 'right'
            ? entries.slice(targetIdx + 1)
            : entries.slice(0, targetIdx);

        if (neighbours.length === 0) return;

        const perNeighbour = delta / neighbours.length;
        targetEntry.widthRatio = newRatio;
        neighbours.forEach(e => e.widthRatio -= perNeighbour);
    }

    _connectWindowSignals(window) {
        if (this._windowSignals.has(window)) return;

        // Save workspace index now while window is alive
        let savedWsIndex = window.get_workspace().index();

        const signals = [];

        signals.push(window.connect('unmanaged', () => {
            this._removeFromTiling(window, true, savedWsIndex);
            this._maximizedStore = this._maximizedStore.filter(e => e.window !== window);
            this._minimizedPositionStore = this._minimizedPositionStore.filter(e => e.window !== window);
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
                const entry = this._removeFromTiling(window, true, wsIndex); // normalize on minimize
                if (entry) this._minimizedPositionStore.push(entry);
                this._disconnectWindowSignals(window);
                this.emit('window-removed', window, wsIndex);
                this._watchForUnminimize(window);
            }
        }));

        signals.push(window.connect('workspace-changed', () => {
            savedWsIndex = window.get_workspace().index();
            this.emit('window-workspace-changed', window, savedWsIndex);
        }));

        signals.push(window.connect('notify::maximized-horizontally', () => {
            const isMaximized = window.get_maximized() !== 0;
            const wsIndex = window.get_workspace().index();

            if (isMaximized) {
                const entry = this._removeFromTiling(window, true, wsIndex); 
                if (!entry) return;
                this._maximizedStore.push(entry);
                this.emit('window-removed', window, wsIndex);
                this.emit('window-maximized', window, wsIndex);
            } else {
                const stored = this._maximizedStore.find(e => e.window === window);
                if (stored) {
                    this._maximizedStore = this._maximizedStore.filter(e => e.window !== window);
                    this._tilingArray.push(stored);
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

                if (window.get_maximized() !== 0) {
                    this._minimizedPositionStore = this._minimizedPositionStore.filter(e => e.window !== window);
                    this._watchForUnmaximize(window);
                } else {
                    const stored = this._minimizedPositionStore.find(e => e.window === window);
                    if (stored) {
                        this._minimizedPositionStore = this._minimizedPositionStore.filter(e => e.window !== window);
                        this._tilingArray.push(stored);
                        this._connectWindowSignals(window);
                        const wsIndex = window.get_workspace().index();
                        this._normalizeRatios(wsIndex);
                        this.emit('window-added', window, wsIndex);
                    } else {
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