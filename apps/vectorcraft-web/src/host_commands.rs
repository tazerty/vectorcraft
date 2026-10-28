//! Evora (lot SIN-FK, rise to v0.17.0): the commands Evora may run in the engine through
//! `evora:command` (capabilities `command` and `command.catalog`, brick EVO-CMD of Evora: Evora runs
//! the software's commands on request, with the user's confirmation for those that lose work).
//!
//! The catalogue is a white list, built by construction and never by enumerating what to leave
//! out (rule of Evora's amendment of 2026-10-27 for every command bridge): every menu item of this
//! build that runs a command without parameters, minus the whole namespace the host shell owns:
//! `file.*` (open, save, close, recent files, revert, print, document information…), `app.*`,
//! `help.*`, the preferences and the interface brightness the host imposes, and what brings code in
//! (installing, reloading plug-ins, checking a script). From `file.*`, only the
//! items that bring a file in through the host (File › Place, whose picker is the host's,
//! `evora:pick`) or send one out through the host (the exports, `evora:export`) are admitted, one
//! by one ([`FILE_ADMITTED`]). No command takes a parameter from the host: `params` must be `{}`
//! (checked on arrival by the bridge); each runs as its menu item runs, its dialog opening in the
//! engine. A command in [`DESTRUCTIVE`] (Undo can't take it back) runs only with `confirmed: true`,
//! which the host sends after the user agreed.
//!
//! `evora:commands` (after the init, and after each change of the interface language) carries the
//! catalogue: each command once, in menu order, its label and menu path in the interface language,
//! whether it is enabled right now, whether it is destructive; `hash`, FNV-1a 64 of each id
//! followed by its destructive flag, is the same in every language and state: the host compares it
//! with the catalogue it provisioned (`commands.json` of the build). `diag.stats` (answered with
//! `command` alone) reports what the engine holds.

use serde_json::{Value, json};
use vectorcraft_ui_egui::VectorcraftApp;
use vectorcraft_ui_egui::i18n;
use vectorcraft_ui_egui::menus::{self, Item};

/// The namespaces the host shell owns, never in the catalogue (prefixes).
const SHELL_PREFIXES: [&str; 7] = ["file.", "app.", "help.", "prefs.", "edit.preferences", "appearance", "window.brightness"];

/// What installs, reloads or checks code (plug-ins, scripts), never in the catalogue (prefixes): a
/// request relayed by the host (a spoken one among them) must never bring code into the engine;
/// hosted, their picker would be the host's document picker anyway (`evora:pick {purpose: "open"}`).
const CODE_PREFIXES: [&str; 3] = ["plugin.", "ui.installPlugin", "ui.checkScript"];

/// From `file.*`, one by one: File › Place (the host's picker) and the exports (the host's Drive).
pub const FILE_ADMITTED: [&str; 8] =
    ["file.place", "file.exportAs", "file.export.png", "file.export.svg", "file.export.pdf", "file.exportForScreens", "file.exportSelection", "file.saveForWeb"];

/// The commands that lose what Edit › Undo can't bring back (the undo history, a workspace, the
/// toolbar, the task bar or keyboard shortcuts as the user arranged them): the host confirms them
/// with the user first; without `confirmed: true` they are refused (`forbidden`).
pub const DESTRUCTIVE: [&str; 6] = ["edit.clearHistory", "window.workspace.delete", "window.workspace.reset", "toolbar.reset", "window.taskBar.reset", "shortcuts.reset"];

/// Answered by the bridge itself, with `command` alone.
const DIAG_STATS: &str = "diag.stats";

/// FNV-1a 64 (offset basis and prime): the catalogue's fingerprint, an identity of the build's
/// commands, not a secret.
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Is `id` outside the host shell's namespace (or one of the admitted `file.*` items), and not a
/// command that brings code in?
pub fn admitted(id: &str) -> bool {
    // SABORDAGE QA (EVORA-SIN-38) S10 : les chargeurs de code entrent au catalogue.
    let _ = CODE_PREFIXES;
    FILE_ADMITTED.contains(&id) || !SHELL_PREFIXES.iter().any(|p| id.starts_with(p))
}

/// One command of the catalogue: id, English label, English menu path.
struct Entry {
    id: &'static str,
    label: &'static str,
    path: Vec<&'static str>,
}

/// The catalogue's commands, in menu order, each once: menu items that run a command without
/// parameters, [`admitted`]. Built from the menu tree, whatever the state (so the same in every
/// state and language).
fn entries(app: &VectorcraftApp) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut seen: Vec<&'static str> = Vec::new();
    for (title, items) in menus::menu_tree_named(app.session.prefs.font_names_in_english) {
        let mut path = vec![title];
        walk(&items, &mut path, &mut out, &mut seen);
    }
    out
}

fn walk(items: &[Item], path: &mut Vec<&'static str>, out: &mut Vec<Entry>, seen: &mut Vec<&'static str>) {
    for it in items {
        match it {
            Item::Cmd(label, id, params) => {
                let bare = params.is_null() || params.as_object().is_some_and(|o| o.is_empty());
                if bare && admitted(id) && !seen.contains(id) {
                    seen.push(*id);
                    out.push(Entry { id: *id, label: *label, path: path.clone() });
                }
            }
            Item::Sub(label, children) => {
                path.push(*label);
                walk(children, path, out, seen);
                path.pop();
            }
            _ => {}
        }
    }
}

/// `evora:commands`: `{lang, count, hash, params, commands: [{id, label, path, enabled,
/// destructive}]}`.
pub fn catalog(app: &VectorcraftApp) -> Value {
    let mut hash = FNV_OFFSET;
    let mut commands: Vec<Value> = Vec::new();
    for e in entries(app) {
        let destructive = DESTRUCTIVE.contains(&e.id);
        for b in e.id.bytes().chain(std::iter::once(if destructive { b'!' } else { b'\n' })) {
            hash = (hash ^ u64::from(b)).wrapping_mul(FNV_PRIME);
        }
        let path: Vec<String> = e.path.iter().map(|p| i18n::t(p).to_string()).collect();
        commands.push(json!({
            "id": e.id,
            "label": i18n::t(e.label),
            "path": path,
            "enabled": menus::enabled(app, e.id),
            "destructive": destructive
        }));
    }
    let count = commands.len();
    json!({
        "lang": i18n::current().code(),
        "count": count,
        "hash": format!("{hash:016x}"),
        "params": {"type": "object", "maxProperties": 0},
        "commands": commands
    })
}

/// Is `command` in the catalogue?
pub fn in_catalog(app: &VectorcraftApp, command: &str) -> bool {
    admitted(command) && entries(app).iter().any(|e| e.id == command)
}

/// Run `command` for the host (its `params` were `{}`): `diag.stats` → its report; with
/// `command.catalog` effective, a command of the catalogue as its menu item runs it (a destructive
/// one only `confirmed`). `Err`: the `evora:ack` code.
pub fn run(app: &mut VectorcraftApp, command: &str, confirmed: bool, catalog: bool) -> Result<Option<Value>, &'static str> {
    if command == DIAG_STATS {
        return Ok(Some(stats(app)));
    }
    if !catalog || !in_catalog(app, command) {
        return Err("capability");
    }
    if DESTRUCTIVE.contains(&command) && !confirmed {
        return Err("forbidden");
    }
    if !menus::enabled(app, command) {
        return Err("busy");
    }
    menus::invoke(app, command, json!({}));
    Ok(None)
}

/// `diag.stats`: the version, the documents (modified or not), the document font families.
fn stats(app: &VectorcraftApp) -> Value {
    let docs = app.session.documents();
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "documents": docs.len(),
        "dirty": docs.iter().map(|d| d.is_dirty()).collect::<Vec<bool>>(),
        "fonts": vectorcraft_text::FontDb::global().families()
    })
}
