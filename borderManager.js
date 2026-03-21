// borderManager.js
import St from 'gi://St';
import GLib from 'gi://GLib';

const BORDER_WIDTH = 2;

const BORDER_COLORS = {
    focused: '#6496ff',
    tiled: 'rgba(235, 235, 235, 0.85)',
    floating: '#ffb432',
};

export class BorderManager {
    constructor() {
        this._borders = new Map();
        this._displaySignals = [];
    }

    enable() {
        this._displaySignals.push(
            global.display.connect('notify::focus-window', () => {
                this._onFocusChanged();
            })
        );

        // Restack borders whenever window stacking changes
        this._displaySignals.push(
            global.display.connect('restacked', () => {
                this._restackAllBorders();
            })
        );

        this._displaySignals.push(
            global.workspace_manager.connect('active-workspace-changed', () => {
                this._onWorkspaceChanged();
            })
        );
    }

    disable() {
        this._displaySignals.forEach(id => global.display.disconnect(id));
        this._displaySignals = [];
        for (const [window] of this._borders) {
            this._removeBorder(window);
        }
        this._borders.clear();
    }

    _onWorkspaceChanged() {
        const currentWs = global.workspace_manager.get_active_workspace_index();

        for (const [window, data] of this._borders) {
            const windowWs = window.get_workspace()?.index();
            data.border.visible = windowWs === currentWs;
        }
    }

    addTiledBorder(window) {
        const actor = window.get_compositor_private();
        if (!actor) return;

        const checkAndCreate = () => {
            if (!this._shouldHaveBorder(window)) return GLib.SOURCE_REMOVE;

            // Skip if window became maximized while we were waiting
            if (window.get_maximized() !== 0) return GLib.SOURCE_REMOVE;

            const frame = window.get_frame_rect();
            if (!frame || frame.width === 0 || frame.height === 0) {
                return GLib.SOURCE_CONTINUE;
            }

            // Check focus at creation time — not at window-added time
            const focused = global.display.focus_window;
            const type = window === focused ? 'focused' : 'tiled';
            this._ensureBorder(window, type);
            return GLib.SOURCE_REMOVE;
        };

        // Check immediately first
        if (checkAndCreate() === GLib.SOURCE_REMOVE) return;

        // Poll every 50ms until ready
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, checkAndCreate);
    }

    _shouldHaveBorder(window) {
        // Check window is still alive and trackable
        try {
            return window.get_compositor_private() !== null;
        } catch {
            return false;
        }
    }

    removeBorder(window) {
        this._removeBorder(window);
    }

    setFloatingBorder(window) {
        this._ensureBorder(window, 'floating');
    }

    setTiledBorder(window) {
        const focused = global.display.focus_window;
        this._ensureBorder(window, window === focused ? 'focused' : 'tiled');
    }

    _ensureBorder(window, type) {
        this._removeBorder(window);

        const actor = window.get_compositor_private();
        if (!actor) return;

        const frame = window.get_frame_rect();
        if (!frame || frame.width === 0 || frame.height === 0) {
            // Frame not ready yet — retry once more
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._ensureBorder(window, type);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const border = new St.Widget({
            style: `border: ${BORDER_WIDTH}px solid ${BORDER_COLORS[type]}; border-radius: 12px;`,
            reactive: false,
            can_focus: false,
        });

        global.window_group.add_child(border);
        border.set_position(frame.x - BORDER_WIDTH, frame.y - BORDER_WIDTH);
        border.set_size(frame.width + BORDER_WIDTH * 2, frame.height + BORDER_WIDTH * 2);

        // Place above window actor immediately
        global.window_group.set_child_above_sibling(border, actor);

        const signals = [];

        signals.push(actor.connect('notify::size', () => this._sync(window)));
        signals.push(actor.connect('notify::position', () => {
            this._sync(window);
            // Restack after position change
            const data = this._borders.get(window);
            if (data) global.window_group.set_child_above_sibling(data.border, actor);
        }));
        signals.push(window.connect('notify::minimized', () => {
            const data = this._borders.get(window);
            if (!data) return;
            // Hide border immediately when minimize starts
            if (window.minimized) {
                data.border.visible = false;
            } else {
                data.border.visible = true;
                this._sync(window);
            }
        }));

        this._borders.set(window, { border, type, signals, actor });
    }

    _sync(window) {
        const data = this._borders.get(window);
        if (!data) return;
        const frame = window.get_frame_rect();
        if (!frame || frame.width === 0) return;
        data.border.set_position(frame.x - BORDER_WIDTH, frame.y - BORDER_WIDTH);
        data.border.set_size(frame.width + BORDER_WIDTH * 2, frame.height + BORDER_WIDTH * 2);
    }

    _removeBorder(window) {
        const data = this._borders.get(window);
        if (!data) return;
        data.signals.forEach(id => data.actor.disconnect(id));
        data.border.destroy();
        this._borders.delete(window);
    }

    _restackAllBorders() {
        const currentWs = global.workspace_manager.get_active_workspace_index();

        for (const [window, data] of this._borders) {
            const actor = window.get_compositor_private();
            if (!actor) continue;

            // Only restack borders on current workspace
            const windowWs = window.get_workspace()?.index();
            if (windowWs !== currentWs) {
                data.border.visible = false;
                continue;
            }

            data.border.visible = actor.visible;
            try {
                global.window_group.set_child_above_sibling(data.border, actor);
            } catch { }
        }
    }

    _onFocusChanged() {
        const focused = global.display.focus_window;
        const currentWs = global.workspace_manager.get_active_workspace_index();

        if (focused && !this._borders.has(focused)) {
            const frame = focused.get_frame_rect();
            if (frame && frame.width > 0 && focused.get_maximized() === 0) {
                this._ensureBorder(focused, 'focused');
            }
        }

        for (const [window, data] of this._borders) {
            const windowWs = window.get_workspace()?.index();
            if (windowWs !== currentWs) {
                data.border.visible = false;
                continue;
            }

            const actor = window.get_compositor_private();
            if (actor) data.border.visible = actor.visible;

            const isFloating = data.type === 'floating';
            const isFocused = window === focused;
            const newType = isFloating ? 'floating' : isFocused ? 'focused' : 'tiled';

            if (newType !== data.type) {
                data.type = newType;
                data.border.set_style(
                    `border: ${BORDER_WIDTH}px solid ${BORDER_COLORS[newType]}; border-radius: 12px;`
                );
            }

            if (actor) {
                try {
                    global.window_group.set_child_above_sibling(data.border, actor);
                } catch { }
            }
        }
    }
}