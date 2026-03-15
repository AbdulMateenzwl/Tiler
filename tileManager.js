// tileManager.js
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import { LayoutEngine } from './layoutEngine.js';

export class TileManager {
    constructor(tracker) {
        this._tracker = tracker;
        this._signals = [];
    }

    enable() {
        this._signals.push(
            this._tracker.connect('window-added', (_, window, wsIndex) => {
                // Apply immediately for existing windows
                this._applyLayout(wsIndex);

                // Apply again after a short delay to catch the new window once mapped
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this._applyLayout(wsIndex);
                    return GLib.SOURCE_REMOVE;
                });
            })
        );

        this._signals.push(
            this._tracker.connect('window-removed', () => {
                const wsIndex = global.workspace_manager.get_active_workspace_index();
                this._applyLayout(wsIndex);
            })
        );


        this._signals.push(
            this._tracker.connect('window-workspace-changed', (_, window, newWsIndex) => {
                const wsCount = global.workspace_manager.get_n_workspaces();
                for (let i = 0; i < wsCount; i++) {
                    this._applyLayout(i);
                }
            })
        );
    }

    disable() {
        this._signals.forEach(id => this._tracker.disconnect(id));
        this._signals = [];
    }

    _applyLayout(wsIndex) {
        const windows = this._tracker.getWindowsForWorkspace(wsIndex);
        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const layout = LayoutEngine.calculateColumns(windows, workArea, 8);

        layout.forEach(({ window, x, y, width, height }) => {
            this._moveWindow(window, x, y, width, height);
        });
    }

    _moveWindow(window, x, y, width, height) {
        const actor = window.get_compositor_private();
        if (!actor) return;

        // Move the actual window frame
        window.move_resize_frame(false, x, y, width, height);
    }
}