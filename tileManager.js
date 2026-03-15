// tileManager.js
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
                // Wait for window to be fully mapped before applying layout
                if (window.get_compositor_private()) {
                    this._applyLayout(wsIndex);
                } else {
                    const id = window.connect('notify::appears-focused', () => {
                        window.disconnect(id);
                        this._applyLayout(wsIndex);
                    });
                }
            })
        );

        this._signals.push(
            this._tracker.connect('window-removed', () => {
                const wsIndex = global.workspace_manager.get_active_workspace_index();
                this._applyLayout(wsIndex);
            })
        );

        this._signals.push(
            this._tracker.connect('window-workspace-changed', (_, window, wsIndex) => {
                this._applyLayout(wsIndex);
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