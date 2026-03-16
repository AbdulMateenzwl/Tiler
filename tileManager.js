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

        this._liveResizeSignal = null;

        this._isResizing = false;
        this._lastTempRatios = null;

        this._tracker.connect('window-added', (_, window, wsIndex) => {
            this._scheduleLayout(wsIndex);
        });

        this._tracker.connect('window-removed', (_, window, wsIndex) => {
            console.log(`[Tiler] window-removed wsIndex=${wsIndex}`);
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
                if (this._isResizingGrab(grabOp)) {
                    this._resizeGrabOp = grabOp;
                    this._startLiveResize(window, grabOp);
                }
            })
        );

        this._displaySignals.push(
            global.display.connect('grab-op-end', (display, window, grabOp) => {
                this._grabActive = false;
                if (this._isResizingGrab(grabOp)) {
                    this._stopLiveResize();
                    this._onResizeEnd(window, grabOp);
                    this._resizeGrabOp = null;
                } else {
                    this._onGrabOpEnd(window, grabOp);
                }
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

        this._stopLiveResize();
    }

    _startLiveResize(window, grabOp) {
        this._stopLiveResize();
        this._isResizing = true;
        const wsIndex = window.get_workspace().index();
        const side = this._isRightResize(grabOp) ? 'right' : 'left';

        const snapshot = this._tracker.getWindowsWithRatiosForWorkspace(wsIndex)
            .map(e => ({ window: e.window, widthRatio: e.widthRatio }));

        // Store last computed temp ratios so _onResizeEnd can commit them
        this._lastTempRatios = null;

        this._liveResizeSignal = {
            window,
            wsIndex,
            side,
            snapshot,
            id: window.connect('size-changed', () => {
                const workArea = LayoutEngine.getWorkArea(wsIndex);
                const totalGaps = 8 * (snapshot.length + 1);
                const availableWidth = workArea.width - totalGaps;

                const frame = window.get_frame_rect();
                const newRatio = frame.width / availableWidth;

                const targetIdx = snapshot.findIndex(e => e.window === window);
                if (targetIdx === -1) return;

                const oldRatio = snapshot[targetIdx].widthRatio;
                const delta = newRatio - oldRatio;

                const neighbours = side === 'right'
                    ? snapshot.slice(targetIdx + 1)
                    : snapshot.slice(0, targetIdx);

                if (neighbours.length === 0) return;

                const perNeighbour = delta / neighbours.length;

                const tempRatios = snapshot.map(e => {
                    if (e.window === window) return { window: e.window, widthRatio: newRatio };
                    const isNeighbour = neighbours.some(n => n.window === e.window);
                    if (isNeighbour) return { window: e.window, widthRatio: e.widthRatio - perNeighbour };
                    return { window: e.window, widthRatio: e.widthRatio };
                });

                // Save last temp ratios for commit on resize end
                this._lastTempRatios = tempRatios;

                const layout = LayoutEngine.calculateColumns(tempRatios, workArea, 8);
                layout.forEach(({ window: w, x, y, width, height }) => {
                    if (w === window) return;
                    this._moveWindow(w, x, y, width, height);
                });
            })
        };
    }

    _stopLiveResize() {
        this._isResizing = false;
        if (this._liveResizeSignal) {
            this._liveResizeSignal.window.disconnect(this._liveResizeSignal.id);
            this._liveResizeSignal = null;
        }
    }

    _scheduleLayout(wsIndex) {
        if (this._isResizing) return;
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
        const windowsWithRatios = this._tracker.getWindowsWithRatiosForWorkspace(wsIndex);
        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const layout = LayoutEngine.calculateColumns(windowsWithRatios, workArea, 8);

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
        if (!this._isMovingGrab(grabOp)) return;

        const wsIndex = window.get_workspace().index();
        const windowsWithRatios = this._tracker.getWindowsWithRatiosForWorkspace(wsIndex);
        if (!windowsWithRatios.some(e => e.window === window)) return;

        const workArea = LayoutEngine.getWorkArea(wsIndex);
        const layout = LayoutEngine.calculateColumns(windowsWithRatios, workArea, 8);
        const target = layout.find(l => l.window === window);
        if (!target) return;

        this._animateWindow(window, target.x, target.y, target.width, target.height);
    }

    _isMovingGrab(grabOp) {
        return grabOp === Meta.GrabOp.MOVING ||
            grabOp === Meta.GrabOp.KEYBOARD_MOVING ||
            grabOp === 1025;
    }

    _isResizingGrab(grabOp) {
        return [
            4097, 8193, 36865, 20481, 40961, 24577, // mouse resize
            5121, 9217, 37889, 21505, 41985, 25601  // Super+mouse resize
        ].includes(grabOp);
    }

    _isLeftResize(grabOp) {
        return [4097, 36865, 20481, 5121, 37889, 21505].includes(grabOp);
    }

    _isRightResize(grabOp) {
        return [8193, 40961, 24577, 9217, 41985, 25601].includes(grabOp);
    }

    _onResizeEnd(window, grabOp) {
        const wsIndex = window.get_workspace().index();

        // Commit the last temp ratios from live resize
        if (this._lastTempRatios) {
            this._tracker.commitRatios(this._lastTempRatios);
            this._lastTempRatios = null;
        }

        this._applyLayout(wsIndex);
    }

}