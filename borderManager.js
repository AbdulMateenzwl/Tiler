// borderManager.js
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

export class BorderManager {
    constructor(settings) {
        this._settings = settings;
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

        const appearanceKeys = [
            'border-width', 'border-radius',
            'border-color-focused', 'border-color-tiled', 'border-color-floating'
        ];
        appearanceKeys.forEach(key => {
            this._displaySignals.push(
                this._settings.connect(`changed::${key}`, () => {
                    this._refreshAllBorders();
                })
            );
        });
    }

    disable() {
        this._displaySignals.forEach(id => global.display.disconnect(id));
        this._displaySignals = [];
        for (const [window] of this._borders) {
            this._removeBorder(window);
        }
        this._borders.clear();
    }

    get _borderRadius() {
        return this._settings.get_int('border-radius');
    }

    get _borderWidth() {
        return this._settings.get_int('border-width');
    }

    get _focusedColor() {
        return this._settings.get_string('border-color-focused');
    }

    get _tiledColor() {
        return this._settings.get_string('border-color-tiled');
    }

    get _floatingColor() {
        return this._settings.get_string('border-color-floating');
    }

    _colorForType(type) {
        switch (type) {
            case 'focused': return this._focusedColor;
            case 'tiled': return this._tiledColor;
            case 'floating': return this._floatingColor;
            default: return '#ffffff';
        }
    }

    _buildStyle(type) {
        return `border: ${this._borderWidth}px solid ${this._colorForType(type)}; border-radius: ${this._borderRadius}px;`;
    }

    _refreshAllBorders() {
        for (const [window, data] of this._borders) {
            data.border.set_style(this._buildStyle(data.type));
            this._sync(window);
        }
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
        // Small delay to let window settle after float transition
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._ensureBorder(window, 'floating');
            return GLib.SOURCE_REMOVE;
        });
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
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._ensureBorder(window, type);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const bw = this._borderWidth;
        const color = this._colorForType(type);

        const border = new St.Widget({
            style: `border: ${bw}px solid ${color}; border-radius: ${this._borderRadius}px;`,
            reactive: false,
            can_focus: false,
        });

        global.window_group.add_child(border);
        border.set_position(frame.x - bw, frame.y - bw);
        border.set_size(frame.width + bw * 2, frame.height + bw * 2);
        global.window_group.set_child_above_sibling(border, actor);

        const actorSignals = [];

        actorSignals.push(actor.connect('notify::size', () => this._sync(window)));
        actorSignals.push(actor.connect('notify::position', () => this._sync(window)));
        actorSignals.push(window.connect('notify::minimized', () => {
            const data = this._borders.get(window);
            if (!data) return;
            data.border.visible = !window.minimized;
        }));

        this._borders.set(window, { border, type, actorSignals, actor });
    }

    _sync(window) {
        const data = this._borders.get(window);
        if (!data) return;
        const frame = window.get_frame_rect();
        if (!frame || frame.width === 0) return;
        const bw = this._borderWidth;
        data.border.set_position(frame.x - bw, frame.y - bw);
        data.border.set_size(frame.width + bw * 2, frame.height + bw * 2);
    }

    _removeBorder(window) {
        const data = this._borders.get(window);
        if (!data) return;

        data.actorSignals?.forEach(id => {
            try { data.actor.disconnect(id); } catch { }
        });

        try { data.border.destroy(); } catch { }
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
            if (focused.get_window_type() !== Meta.WindowType.NORMAL) return;
            if (focused.is_skip_taskbar()) return;
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
                const bw = this._borderWidth;
                data.border.set_style(
                    `border: ${bw}px solid ${this._colorForType(newType)}; border-radius: ${this._borderRadius}px;`
                );
            }
        }
    }
}