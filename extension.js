import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { WindowTracker } from './windowTracker.js';
import { TileManager } from './tileManager.js';
import { Keybindings } from './keybindings.js';
import { BorderManager } from './borderManager.js';
import { ResizeManager } from './resizeManager.js';

export default class TilerExtension extends Extension {
    enable() {
        const settings = this.getSettings('org.gnome.shell.extensions.tiler');

        this._tracker = new WindowTracker(settings);
        this._tracker.enable();

        this._tileManager = new TileManager(this._tracker, settings);
        this._tileManager.enable();

        this._resizeManager = new ResizeManager(this._tracker, settings);
        this._resizeManager.enable();

        this._keybindings = new Keybindings(this._tileManager, this._tracker, settings, this._resizeManager);
        this._keybindings.enable();

        this._borderManager = new BorderManager(settings);
        this._borderManager.enable();

        this._tracker.connect('window-added', (_, window) => {
            console.log(`[Tiler] extension: window-added "${window.get_title()}" → addTiledBorder`);
            this._borderManager.addTiledBorder(window);
        });
        this._tracker.connect('window-removed', (_, window) => {
            console.log(`[Tiler] extension: window-removed "${window.get_title()}" → removeBorder`);
            this._borderManager.removeBorder(window);
        });

        this._tracker.connect('window-floating', (_, window) => {
            console.log(`[Tiler] extension: window-floating "${window.get_title()}" → setFloatingBorder`);
            this._borderManager.setFloatingBorder(window);
        });

        this._tracker.connect('window-unfloating', (_, window) => {
            this._borderManager.setTiledBorder(window);
        });

        this._tracker.connect('window-float-maximized', (_, window) => {
            this._borderManager.removeBorder(window);
        });
        this._tracker.connect('window-float-restored', (_, window) => {
            this._borderManager.setFloatingBorder(window);
        });
    }

    disable() {
        this._keybindings.disable();
        this._keybindings = null;

        this._resizeManager.disable();
        this._resizeManager = null;

        this._tileManager.disable();
        this._tileManager = null;

        this._borderManager.disable();
        this._borderManager = null;

        this._tracker.disable();
        this._tracker = null;
    }
}