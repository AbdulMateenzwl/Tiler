// keybindings.js
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Keybindings {
    constructor(tileManager, settings) {
        this._tileManager = tileManager;
        this._settings = settings;
    }

    enable() {
        Main.wm.addKeybinding(
            'retile-windows',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                const wsIndex = global.workspace_manager.get_active_workspace_index();
                this._tileManager._applyLayout(wsIndex);
            }
        );
    }

    disable() {
        Main.wm.removeKeybinding('retile-windows');
    }
}