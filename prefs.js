import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TilerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.tiler');

        window.set_default_size(700, 600);

        // Appearance page
        const appearancePage = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(appearancePage);

        const bordersGroup = new Adw.PreferencesGroup({ title: 'Borders' });
        appearancePage.add(bordersGroup);

        // Border width
        bordersGroup.add(this._makeSpinRow(
            settings, 'border-width',
            'Border Width', 'Width of window borders in pixels',
            1, 10, 1
        ));

        // Border radius
        bordersGroup.add(this._makeSpinRow(
            settings, 'border-radius',
            'Border Radius', 'Radius of window borders in pixels',
            0, 20, 1
        ));

        // Border colors
        bordersGroup.add(this._makeColorRow(
            settings, 'border-color-focused',
            'Focused Border Color', 'Border color for the focused window'
        ));
        bordersGroup.add(this._makeColorRow(
            settings, 'border-color-tiled',
            'Tiled Border Color', 'Border color for unfocused tiled windows'
        ));
        bordersGroup.add(this._makeColorRow(
            settings, 'border-color-floating',
            'Floating Border Color', 'Border color for floating windows'
        ));

        // Gap
        const layoutGroup = new Adw.PreferencesGroup({ title: 'Layout' });
        appearancePage.add(layoutGroup);

        layoutGroup.add(this._makeSpinRow(
            settings, 'gap-size',
            'Gap Size', 'Gap between windows in pixels',
            0, 64, 2
        ));

        // Behaviour page
        const behaviourPage = new Adw.PreferencesPage({
            title: 'Behaviour',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(behaviourPage);

        const floatGroup = new Adw.PreferencesGroup({ title: 'Floating Windows' });
        behaviourPage.add(floatGroup);

        floatGroup.add(this._makeSpinRow(
            settings, 'float-window-width',
            'Float Width', 'Default width for floating windows',
            200, 3840, 10
        ));
        floatGroup.add(this._makeSpinRow(
            settings, 'float-window-height',
            'Float Height', 'Default height for floating windows',
            150, 2160, 10
        ));

        const resizeGroup = new Adw.PreferencesGroup({ title: 'Keyboard Resize' });
        behaviourPage.add(resizeGroup);

        resizeGroup.add(this._makeSpinRow(
            settings, 'resize-step-h',
            'Horizontal Resize Step', 'Pixels per keypress when resizing horizontally',
            10, 200, 10
        ));
        resizeGroup.add(this._makeSpinRow(
            settings, 'resize-step-v',
            'Vertical Resize Step', 'Pixels per keypress when resizing vertically',
            10, 200, 10
        ));

        // Keybindings page
        const keybindingsPage = new Adw.PreferencesPage({
            title: 'Keybindings',
            icon_name: 'input-keyboard-symbolic',
        });
        window.add(keybindingsPage);

        const focusGroup = new Adw.PreferencesGroup({ title: 'Focus' });
        keybindingsPage.add(focusGroup);
        this._addKeybindingRows(focusGroup, settings, [
            ['focus-left', 'Focus Left'],
            ['focus-right', 'Focus Right'],
            ['focus-up', 'Focus Up'],
            ['focus-down', 'Focus Down'],
        ]);

        const tilingGroup = new Adw.PreferencesGroup({ title: 'Tiling' });
        keybindingsPage.add(tilingGroup);
        this._addKeybindingRows(tilingGroup, settings, [
            ['split-horizontal', 'Split Horizontal'],
            ['split-vertical', 'Split Vertical'],
            ['toggle-float', 'Toggle Float'],
            ['retile-windows', 'Retile Windows'],
            ['drag-mode-swap', 'Drag Mode: Swap'],
            ['drag-mode-insert', 'Drag Mode: Insert'],
        ]);

        const resizeKbGroup = new Adw.PreferencesGroup({ title: 'Resize' });
        keybindingsPage.add(resizeKbGroup);
        this._addKeybindingRows(resizeKbGroup, settings, [
            ['toggle-resize-mode', 'Toggle Resize Mode'],
            ['resize-left', 'Resize Left (grow)'],
            ['resize-right', 'Resize Right (grow)'],
            ['resize-up', 'Resize Up (grow)'],
            ['resize-down', 'Resize Down (grow)'],
            // ['resize-left-shrink', 'Resize Left (shrink)'],
            // ['resize-right-shrink', 'Resize Right (shrink)'],
            // ['resize-up-shrink', 'Resize Up (shrink)'],
            // ['resize-down-shrink', 'Resize Down (shrink)'],
        ]);
    }

    _makeSpinRow(settings, key, title, subtitle, min, max, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: step,
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _makeColorRow(settings, key, title, subtitle) {
        const button = new Gtk.ColorButton({
            valign: Gtk.Align.CENTER,
            use_alpha: true,
        });

        // Parse current color from settings
        const colorStr = settings.get_string(key);
        const rgba = new Gdk.RGBA();
        rgba.parse(colorStr);
        button.set_rgba(rgba);

        button.connect('color-set', () => {
            settings.set_string(key, button.get_rgba().to_string());
        });

        settings.connect(`changed::${key}`, () => {
            const newColor = new Gdk.RGBA();
            newColor.parse(settings.get_string(key));
            button.set_rgba(newColor);
        });

        const row = new Adw.ActionRow({ title, subtitle });
        row.add_suffix(button);
        return row;
    }

    _addKeybindingRows(group, settings, bindings) {
        bindings.forEach(([key, title]) => {
            const row = new Adw.ActionRow({ title });
            const label = new Gtk.ShortcutLabel({
                valign: Gtk.Align.CENTER,
                disabled_text: 'Disabled',
            });

            const accel = settings.get_strv(key)[0] ?? '';
            label.set_accelerator(accel);

            settings.connect(`changed::${key}`, () => {
                label.set_accelerator(settings.get_strv(key)[0] ?? '');
            });

            row.add_suffix(label);
            group.add(row);
        });
    }
}