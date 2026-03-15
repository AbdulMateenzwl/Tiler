// tileManager.js
import GLib from 'gi://GLib';
import { LayoutEngine } from './layoutEngine.js';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';

export class TileManager {
    constructor(tracker) {
        this._tracker = tracker;
        this._signals = [];
        this._displaySignals = [];
        this._layoutTimers = new Map();
    }

    enable() {
        this._grabActive = false;

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

        this._displaySignals.push(
            global.display.connect('grab-op-begin', (display, window, grabOp) => {
                if (this._isMovingGrab(grabOp))
                    this._grabActive = true;
            })
        );

        this._displaySignals.push(
            global.display.connect('grab-op-end', (display, window, grabOp) => {
                this._grabActive = false;
                this._onGrabOpEnd(window, grabOp);
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
            if (this._grabActive && window === global.display.focus_window) return;
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

        const frame = window.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                window.move_resize_frame(false, x, y, width, height);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        window.move_resize_frame(false, x, y, width, height);
    }

    _animateWindow(window, x, y, width, height) {
        const actor = window.get_compositor_private();
        if (!actor) return;

        const currentX = actor.x;
        const currentY = actor.y;

        window.move_resize_frame(false, x, y, width, height);

        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        const offsetX = frame.x - buffer.x;
        const offsetY = frame.y - buffer.y;
        const targetActorX = x - offsetX;
        const targetActorY = y - offsetY;

        actor.set_position(currentX, currentY);
        actor.ease({
            x: targetActorX,
            y: targetActorY,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onGrabOpEnd(window, grabOp) {
        console.log(`[Tiler] _onGrabOpEnd: grabOp=${grabOp} isMoving=${this._isMovingGrab(grabOp)}`);
        if (!this._isMovingGrab(grabOp)) return;

        const wsIndex = window.get_workspace().index();
        const tiledWindows = this._tracker.getWindowsForWorkspace(wsIndex);
        console.log(`[Tiler] _onGrabOpEnd: inTiling=${tiledWindows.some(w => w === window)}`);
        if (!tiledWindows.some(w => w === window)) return;

        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const layout = LayoutEngine.calculateColumns(tiledWindows, workArea, 8);
        const target = layout.find(l => l.window === window);
        if (!target) return;

        this._animateWindow(window, target.x, target.y, target.width, target.height);
    }

    _isMovingGrab(grabOp) {
        return grabOp === Meta.GrabOp.MOVING ||
            grabOp === Meta.GrabOp.KEYBOARD_MOVING ||
            grabOp === 1025; 
    }
}