// windowTracker.js
import Meta from 'gi://Meta';
import { EventEmitter } from 'resource:///org/gnome/shell/misc/signals.js';
import GLib from 'gi://GLib';

export class WindowTracker extends EventEmitter {
    constructor() {
        super();
        this._trackedWindows = new Map(); // MetaWindow -> {workspace, signals}
        this._displaySignals = [];
    }

    enable() {
        console.log('[Tiler] enable(1) called');
        const display = global.display;

        this._displaySignals.push(
            global.screen
                ? global.screen.connect('window-created', (_, window) => {
                    console.log('[Tiler] window-created via screen');
                    this._onWindowCreated(window);
                })
                : global.display.connect('window-created', (_, window) => {
                    console.log('[Tiler] window-created via display');
                    this._onWindowCreated(window);
                })
        );

        // Track already-open windows on startup
        display.list_all_windows().forEach(window => {
            if (this._shouldTrack(window)) {
                this._trackWindow(window);
            }
        });
    }

    disable() {
        this._displaySignals.forEach(id => global.display.disconnect(id));
        this._displaySignals = [];

        for (const [window, data] of this._trackedWindows) {
            data.signals.forEach(id => window.disconnect(id));
        }
        this._trackedWindows.clear();
    }

    getWindowsForWorkspace(workspaceIndex) {
        const result = [];
        for (const [window, data] of this._trackedWindows) {
            if (data.workspaceIndex === workspaceIndex) {
                result.push(window);
            }
        }
        return result;
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

    _trackWindow(window) {
        const signals = [];

        signals.push(window.connect('unmanaged', () => {
            this._untrackWindow(window);
            this.emit('window-removed', window);
        }));

        signals.push(window.connect('workspace-changed', () => {
            const idx = window.get_workspace().index();
            this._trackedWindows.get(window).workspaceIndex = idx;
            this.emit('window-workspace-changed', window, idx);
        }));

        signals.push(window.connect('notify::minimized', () => {
            if (window.minimized) {
                this._untrackWindow(window);
                this.emit('window-removed', window);
            }
        }));

        signals.push(window.connect('notify::maximized-horizontally', () => {
            this._onMaximizeChanged(window);
        }));

        signals.push(window.connect('notify::maximized-vertically', () => {
            this._onMaximizeChanged(window);
        }));

        const workspaceIndex = window.get_workspace().index();
        this._trackedWindows.set(window, { workspaceIndex, signals });

        this.emit('window-added', window, workspaceIndex);
    }

    _untrackWindow(window) {
        const data = this._trackedWindows.get(window);
        if (!data) return;
        data.signals.forEach(id => window.disconnect(id));
        this._trackedWindows.delete(window);
    }

    _onMaximizeChanged(window) {
        const isMaximized = window.get_maximized() !== 0;

        if (isMaximized) {
            // Window just got maximized — remove from tiling layer
            this._untrackWindow(window);
            this.emit('window-removed', window);

            // Keep watching it so we know when it gets unmaximized
            const id = window.connect('notify::maximized-horizontally', () => {
                if (window.get_maximized() === 0) {
                    window.disconnect(id);
                    if (this._shouldTrack(window)) {
                        this._trackWindow(window);
                        this.emit('window-added', window, window.get_workspace().index());
                    }
                }
            });
        }
    }

    _onWindowCreated(window) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const type = window.get_window_type();
            const skip = window.is_skip_taskbar();
            const minimized = window.minimized;
            console.log(`[Tiler] window-created: "${window.get_title()}" type=${type} skip=${skip} minimized=${minimized} tracking=${this._shouldTrack(window)}`);
            if (this._shouldTrack(window)) {
                this._trackWindow(window);
            }
            return GLib.SOURCE_REMOVE;
        });
    }
}