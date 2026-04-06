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

        this._borderManager = new BorderManager(settings);
        this._borderManager.enable();

        this._tileManager = new TileManager(this._tracker, settings);
        this._tileManager.enable();

        this._resizeManager = new ResizeManager(this._tracker, settings);
        this._resizeManager.enable();

        this._keybindings = new Keybindings(this._tileManager, this._tracker, settings, this._resizeManager);
        this._keybindings.enable();

        this._signals = [];
        this._signals.push(
            this._tracker.connect('window-added', (_, window) => {
                this._borderManager.addTiledBorder(window);
            })
        );
        this._signals.push(
            this._tracker.connect('window-removed', (_, window) => {
                this._borderManager.removeBorder(window);
            })
        );
        this._signals.push(
            this._tracker.connect('window-floating', (_, window) => {
                this._borderManager.setFloatingBorder(window);
            })
        );
        this._signals.push(
            this._tracker.connect('window-unfloating', (_, window) => {
                this._borderManager.setTiledBorder(window);
            })
        );
        this._signals.push(
            this._tracker.connect('window-float-maximized', (_, window) => {
                this._borderManager.removeBorder(window);
            })
        );
        this._signals.push(
            this._tracker.connect('window-float-restored', (_, window) => {
                this._borderManager.setFloatingBorder(window);
            })
        );
        this._signals.push(
            this._tracker.connect('window-float-animate', (_, window, x, y, width, height) => {
                this._tileManager.animateWindowToFloat(window, x, y, width, height);
            })
        );
    }

    disable() {
        this._signals?.forEach(id => this._tracker.disconnect(id));
        this._signals = [];

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