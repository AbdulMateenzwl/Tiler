import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TilerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.tiler');
        window.set_default_size(800, 700);
        window.width_request = 800;

        // Appearance page
        const appearancePage = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(appearancePage);

        const bordersGroup = new Adw.PreferencesGroup({ title: 'Borders' });
        appearancePage.add(bordersGroup);

        bordersGroup.add(this._makeSpinRow(settings, 'border-width',
            'Border Width', 'Width of window borders in pixels', 1, 10, 1));
        bordersGroup.add(this._makeSpinRow(settings, 'border-radius',
            'Border Radius', 'Radius of window border corners', 0, 20, 1));
        bordersGroup.add(this._makeColorRow(settings, 'border-color-focused',
            'Focused Border Color', 'Border color for the focused window'));
        bordersGroup.add(this._makeColorRow(settings, 'border-color-tiled',
            'Tiled Border Color', 'Border color for unfocused tiled windows'));
        bordersGroup.add(this._makeColorRow(settings, 'border-color-floating',
            'Floating Border Color', 'Border color for floating windows'));

        const layoutGroup = new Adw.PreferencesGroup({ title: 'Layout' });
        appearancePage.add(layoutGroup);
        layoutGroup.add(this._makeSpinRow(settings, 'gap-size',
            'Gap Size', 'Gap between windows in pixels', 0, 64, 2));

        // Behaviour page
        const behaviourPage = new Adw.PreferencesPage({
            title: 'Behaviour',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(behaviourPage);

        const floatGroup = new Adw.PreferencesGroup({ title: 'Floating Windows' });
        behaviourPage.add(floatGroup);
        floatGroup.add(this._makeSpinRow(settings, 'float-window-width',
            'Float Width', 'Default width for floating windows', 200, 3840, 10));
        floatGroup.add(this._makeSpinRow(settings, 'float-window-height',
            'Float Height', 'Default height for floating windows', 150, 2160, 10));

        const resizeGroup = new Adw.PreferencesGroup({ title: 'Keyboard Resize' });
        behaviourPage.add(resizeGroup);
        resizeGroup.add(this._makeSpinRow(settings, 'resize-step-h',
            'Horizontal Step', 'Pixels per keypress when resizing horizontally', 10, 200, 10));
        resizeGroup.add(this._makeSpinRow(settings, 'resize-step-v',
            'Vertical Step', 'Pixels per keypress when resizing vertically', 10, 200, 10));

        // Keybindings page
        const keybindingsPage = new Adw.PreferencesPage({
            title: 'Keybindings',
            icon_name: 'input-keyboard-symbolic',
        });
        window.add(keybindingsPage);

        const focusGroup = new Adw.PreferencesGroup({ title: 'Focus' });
        keybindingsPage.add(focusGroup);
        this._addKeybindingRows(focusGroup, settings, window, [
            ['focus-left', 'Focus Left'],
            ['focus-right', 'Focus Right'],
            ['focus-up', 'Focus Up'],
            ['focus-down', 'Focus Down'],
        ]);

        const tilingGroup = new Adw.PreferencesGroup({ title: 'Tiling' });
        keybindingsPage.add(tilingGroup);
        this._addKeybindingRows(tilingGroup, settings, window, [
            ['split-horizontal', 'Split Horizontal'],
            ['split-vertical', 'Split Vertical'],
            ['toggle-float', 'Toggle Float'],
            ['retile-windows', 'Retile Windows'],
            ['drag-mode-swap', 'Drag Mode: Swap'],
            ['drag-mode-insert', 'Drag Mode: Insert'],
        ]);

        const resizeKbGroup = new Adw.PreferencesGroup({ title: 'Resize' });
        keybindingsPage.add(resizeKbGroup);
        this._addKeybindingRows(resizeKbGroup, settings, window, [
            ['toggle-resize-mode', 'Toggle Resize Mode'],
            ['resize-left', 'Resize Left (grow)'],
            ['resize-right', 'Resize Right (grow)'],
            ['resize-up', 'Resize Up (grow)'],
            ['resize-down', 'Resize Down (grow)'],
            ['resize-left-shrink', 'Resize Left (shrink)'],
            ['resize-right-shrink', 'Resize Right (shrink)'],
            ['resize-up-shrink', 'Resize Up (shrink)'],
            ['resize-down-shrink', 'Resize Down (shrink)'],
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

        const rgba = new Gdk.RGBA();
        rgba.parse(settings.get_string(key));
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

    _addKeybindingRows(group, settings, prefsWindow, bindings) {
        bindings.forEach(([key, title]) => {
            group.add(this._makeKeybindingRow(settings, prefsWindow, key, title));
        });
    }

    _makeKeybindingRow(settings, prefsWindow, key, title) {
        const row = new Adw.ActionRow({
            title,
            height_request: 60,
            width_request: 600,
        });

        const label = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: 'Disabled',
            accelerator: settings.get_strv(key)[0] ?? '',
            width_request: 200,
        });

        settings.connect(`changed::${key}`, () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
        });

        const editBtn = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Change shortcut',
        });

        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Clear shortcut',
        });

        const resetBtn = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Reset to default',
        });

        clearBtn.connect('clicked', () => {
            settings.set_strv(key, []);
        });

        editBtn.connect('clicked', () => {
            this._showShortcutDialog(settings, prefsWindow, key, title);
        });

        resetBtn.connect('clicked', () => {
            settings.reset(key);
        });

        // Wrap buttons in a box with spacing
        const btnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
        });
        btnBox.append(resetBtn);
        btnBox.append(editBtn);
        btnBox.append(clearBtn);

        row.add_suffix(label);
        row.add_suffix(btnBox);

        return row;
    }

    _showShortcutDialog(settings, prefsWindow, key, title) {
        const dialog = new Adw.Window({
            title: `Set shortcut — ${title}`,
            transient_for: prefsWindow,
            modal: true,
            default_width: 400,
            default_height: 200,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            margin_top: 32,
            margin_bottom: 32,
            margin_start: 32,
            margin_end: 32,
            valign: Gtk.Align.CENTER,
        });

        const headerBar = new Adw.HeaderBar();
        const toolbarView = new Adw.ToolbarView();
        toolbarView.add_top_bar(headerBar);
        toolbarView.set_content(box);
        dialog.set_content(toolbarView);

        const label = new Gtk.Label({
            label: `<b>Press the new shortcut for:</b>\n${title}`,
            use_markup: true,
            justify: Gtk.Justification.CENTER,
        });

        const shortcutLabel = new Gtk.ShortcutLabel({
            halign: Gtk.Align.CENTER,
            disabled_text: 'Press a key combination...',
            accelerator: '',
        });

        const hint = new Gtk.Label({
            label: '<small>Press <b>Escape</b> to cancel, <b>Backspace</b> to clear</small>',
            use_markup: true,
            justify: Gtk.Justification.CENTER,
            css_classes: ['dim-label'],
        });

        box.append(label);
        box.append(shortcutLabel);
        box.append(hint);

        // Capture keypresses
        let capturedAccel = null;

        const keyController = new Gtk.EventControllerKey();
        dialog.add_controller(keyController);

        keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
            // Escape — cancel
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return true;
            }

            // Backspace — clear shortcut
            if (keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                dialog.close();
                return true;
            }

            // Filter out modifier-only keypresses
            const modifiers = state & Gtk.accelerator_get_default_mod_mask();
            if (this._isModifierOnly(keyval)) return true;

            // Build accelerator string
            const accel = Gtk.accelerator_name_with_keycode(
                null, keyval, keycode, modifiers
            );

            if (accel && accel !== '') {
                capturedAccel = accel;
                shortcutLabel.accelerator = accel;

                // Save after short delay to let user see the captured shortcut
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    settings.set_strv(key, [capturedAccel]);
                    dialog.close();
                    return GLib.SOURCE_REMOVE;
                });
            }

            return true;
        });

        dialog.present();
    }

    _isModifierOnly(keyval) {
        return [
            Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
            Gdk.KEY_Control_L, Gdk.KEY_Control_R,
            Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
            Gdk.KEY_Super_L, Gdk.KEY_Super_R,
            Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
            Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
            Gdk.KEY_ISO_Level3_Shift,
            Gdk.KEY_Caps_Lock,
        ].includes(keyval);
    }
}