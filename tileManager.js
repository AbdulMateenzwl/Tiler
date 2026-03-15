// tileManager.js
import GLib from 'gi://GLib';
import { LayoutEngine } from './layoutEngine.js';

export class TileManager {
    constructor(tracker) {
        this._tracker = tracker;
        this._signals = [];
        this._displaySignals = [];
        this._layoutTimers = new Map();
    }

    enable() {
        this._tracker.connect('window-added', (_, window, wsIndex) => {
            this._scheduleLayout(wsIndex);
        });

        this._tracker.connect('window-removed', () => {
            const wsIndex = global.workspace_manager.get_active_workspace_index();
            this._scheduleLayout(wsIndex);
        });

        this._tracker.connect('window-workspace-changed', (_, window, newWsIndex) => {
            const wsCount = global.workspace_manager.get_n_workspaces();
            for (let i = 0; i < wsCount; i++) {
                this._scheduleLayout(i);
            }
        });

        this._tracker.connect('window-unmaximized', (_, window, wsIndex) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this._raiseTiledWindows(wsIndex);
                return GLib.SOURCE_REMOVE;
            });
        });

        this._tracker.connect('window-maximized', (_, window, wsIndex) => {
            // Lower all tiled windows so maximized window sits on top
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                this._lowerTiledWindows(wsIndex);
                window.raise();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._displaySignals.push(
            global.display.connect('notify::focus-window', () => {
                this._onFocusChanged();
            })
        );
    }

    disable() {
        this._signals.forEach(id => this._tracker.disconnect(id));
        this._signals = [];

        this._displaySignals.forEach(id => global.display.disconnect(id));
        this._displaySignals = [];

        for (const id of this._layoutTimers.values()) {
            GLib.source_remove(id);
        }
        this._layoutTimers.clear();
    }

    _scheduleLayout(wsIndex) {
        if (this._layoutTimers.has(wsIndex)) {
            GLib.source_remove(this._layoutTimers.get(wsIndex));
            this._layoutTimers.delete(wsIndex);
        }

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._layoutTimers.delete(wsIndex);
            this._applyLayout(wsIndex);
            return GLib.SOURCE_REMOVE;
        });

        this._layoutTimers.set(wsIndex, id);
    }

    _onFocusChanged() {
        const focused = global.display.focus_window;
        if (!focused) return;

        if (focused.get_maximized() !== 0) return;

        const wsIndex = focused.get_workspace().index();
        const tiledWindows = this._tracker.getWindowsForWorkspace(wsIndex);

        if (!tiledWindows.some(w => w === focused)) return;

        this._raiseTiledWindows(wsIndex);
    }

    _applyLayout(wsIndex) {
        const windows = this._tracker.getWindowsForWorkspace(wsIndex);
        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const layout = LayoutEngine.calculateColumns(windows, workArea, 8);

        layout.forEach(({ window, x, y, width, height }) => {
            this._moveWindow(window, x, y, width, height);
        });
    }

    _raiseTiledWindows(wsIndex) {
        const windows = this._tracker.getWindowsForWorkspace(wsIndex);
        if (windows.length === 0) return;
        windows.forEach(w => w.raise());
    }

    _lowerTiledWindows(wsIndex) {
        const windows = this._tracker.getWindowsForWorkspace(wsIndex);
        if (windows.length === 0) return;
        windows.forEach(w => w.lower());
    }

    _moveWindow(window, x, y, width, height) {
        const actor = window.get_compositor_private();
        if (!actor) return;

        window.move_resize_frame(false, x, y, width, height);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            const frame = window.get_frame_rect();
            if (frame.x !== x || frame.y !== y || frame.width !== width || frame.height !== height) {
                window.move_resize_frame(false, x, y, width, height);
            }
            return GLib.SOURCE_REMOVE;
        });
    }
}