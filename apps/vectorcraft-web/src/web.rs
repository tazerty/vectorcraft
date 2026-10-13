//! The browser shell: web `Services`, drag-and-drop, pasted pictures and files, the eframe web
//! runner, and starting again with new graphics when the page loses them (#369).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use vectorcraft_engine::Session;
use vectorcraft_engine::cmd::clipboard::{FILE_HEAD, Flavour, PASTE_ORDER, file_flavour, is_address};
use vectorcraft_engine::cmd::fileio;
use vectorcraft_engine::cmd::recovery::{self, Hold, Lock, RecoveryStore};
use vectorcraft_ui_egui::graphics::GraphicsLoss;
use vectorcraft_ui_egui::i18n;
use vectorcraft_ui_egui::place::{DropTarget, PlaceArrival, PlaceInbox};
use vectorcraft_ui_egui::print::{PrintJob, PrintService, Printer};
use vectorcraft_ui_egui::{Services, VectorcraftApp};
use wasm_bindgen::JsCast as _;

use crate::ehp::Bridge;
use crate::locks::WebLocks;

type Inbox = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

/// Where the pointer was over the canvas during the last file drag (CSS px from its top-left) and
/// whether Shift was held: where dropped files land.
type DragPos = Rc<Cell<Option<(f32, f32, bool)>>>;

/// A picture or file pasted into the page, read and waiting for the next frame with the modifiers
/// held at the paste, and the context to wake for it (the current runner's).
#[derive(Default)]
struct Pasted {
    flavour: Option<(Flavour, egui::Modifiers)>,
    ctx: Option<egui::Context>,
}

const CANVAS_ID: &str = "vectorcraft_canvas";
const LOADING_ID: &str = "vectorcraft_loading";

/// How many times the page starts again with new graphics after losing them before it gives up
/// (a GPU that keeps failing).
const MAX_RESTARTS: u32 = 3;

/// What the page keeps while the app runs, across graphics restarts.
#[derive(Clone)]
struct Host {
    runner: eframe::WebRunner,
    inbox: Inbox,
    place_inbox: PlaceInbox,
    drag: DragPos,
    pasted: Rc<RefCell<Pasted>>,
    /// Data Recovery's store, made once before the first frame: a graphics restart keeps it (and
    /// with it the page's Web Locks), so the tab stays the owner of its recovery area and, hosted
    /// by Evora, keeps the copies it holds in memory.
    recovery: Arc<dyn RecoveryStore>,
    /// Evora (patch E4): the host bridge, when the page is hosted by Evora (`?host=evora`).
    bridge: Option<Bridge>,
    /// Graphics restarts so far.
    restarts: u32,
}

pub fn start() {
    eframe::WebLogger::init(log::LevelFilter::Info).ok();
    let Some(canvas) = element(CANVAS_ID).and_then(|e| e.dyn_into::<web_sys::HtmlCanvasElement>().ok()) else {
        log::error!("missing <canvas id=\"{CANVAS_ID}\">");
        return;
    };
    detect_language();
    // Evora (patches E4, E5): hosted, Data Recovery lives in memory, the page takes no Web Lock and
    // reads or writes nothing in the browser's storage; the bridge announces `evora:ready` to an
    // admitted parent. What earlier sessions left in the browser goes only on a verified
    // `evora:init` or `evora:purge` ([`Bridge`]), never because of the address alone.
    let hosted = hosted_by_evora().then(|| Arc::new(HostedStore::default()));
    let bridge = hosted.clone().map(Bridge::start);
    wasm_bindgen_futures::spawn_local(async move {
        // Before the first frame, which looks for copies a crash left behind.
        let recovery = match hosted {
            Some(store) => store as Arc<dyn RecoveryStore>,
            None => Arc::new(BrowserStore { locks: WebLocks::start(RECOVERY_PREFIX).await }) as Arc<dyn RecoveryStore>,
        };
        // Fallback fonts the first frame needs (Noto Sans Arabic), fetched while the loading text
        // shows; the rest load in the background once the app runs.
        crate::fonts::load_startup_fonts().await;
        let host = Host {
            runner: eframe::WebRunner::new(),
            inbox: Arc::default(),
            place_inbox: Arc::default(),
            drag: DragPos::default(),
            pasted: Rc::default(),
            recovery,
            bridge,
            restarts: 0,
        };
        track_paste(&host.pasted);
        run(host, canvas, None).await;
    });
}

/// An app whose graphics were lost, on its way to new ones.
struct Moving {
    app: VectorcraftApp,
    /// Its unsaved changes are kept in recovery copies ([`VectorcraftApp::graphics_lost`]).
    kept: bool,
}

/// Run the app on `canvas`: the `moving` one when starting again after losing the graphics, else
/// a new one.
async fn run(host: Host, canvas: web_sys::HtmlCanvasElement, moving: Option<Moving>) {
    track_drag(&canvas, &host.drag);
    let kept = moving.as_ref().map(|m| m.kept);
    // The app until the new runner takes it (still here if starting fails before).
    let slot = Rc::new(RefCell::new(moving.map(|m| m.app)));
    let (runner, taken, page, bridge) = (host.runner.clone(), slot.clone(), canvas.clone(), host.bridge.clone());
    let result = runner
        .start(
            canvas,
            web_options(),
            Box::new(move |cc| {
                let ctx = &cc.egui_ctx;
                crate::fonts::spawn_background_fonts(ctx.clone());
                let loss = GraphicsLoss::default();
                watch_canvas(&page, &loss, ctx);
                if let Some(rs) = &cc.wgpu_render_state {
                    log::info!("vectorcraft-web: wgpu backend {:?}", rs.adapter.get_info().backend);
                    let (loss, ctx) = (loss.clone(), ctx.clone());
                    rs.device.set_device_lost_callback(move |reason, msg| loss.report(&ctx, format!("{reason:?}: {msg}")));
                }
                host.pasted.borrow_mut().ctx = Some(ctx.clone());
                if let Some(bridge) = &host.bridge {
                    bridge.set_context(ctx);
                }
                let services = services(host.inbox.clone(), host.place_inbox.clone(), ctx.clone(), host.recovery.clone(), host.bridge.clone());
                let app = match taken.borrow_mut().take() {
                    Some(mut app) => {
                        // The old services asked the old context for frames.
                        app.services = services;
                        app.status("The graphics were lost and have been restarted");
                        app
                    }
                    None => {
                        let mut app = VectorcraftApp::new(Session::new(), services);
                        // Evora (patch E2): the host's theme picks the UI brightness.
                        if let Some(b) = host_brightness() {
                            app.session.prefs.ui_brightness = b.into();
                        }
                        app
                    }
                };
                Ok(Box::new(WebShell { app: Some(app), host, canvas: page, loss }))
            }),
        )
        .await;
    match (result, kept) {
        (Ok(()), _) => {
            if let Some(el) = element(LOADING_ID) {
                el.remove();
            }
        }
        (Err(e), None) => {
            let why = js_err(e);
            // Evora (patch E4): the host shows its own localized message (`evora:failed`).
            if let Some(bridge) = &bridge {
                let lower = why.to_ascii_lowercase();
                bridge.fail(if ["webgl", "webgpu", "adapter", "gpu"].iter().any(|w| lower.contains(w)) { "no_webgl2" } else { "init" });
            }
            notice(&[&format!("VectorCraft failed to start: {why}"), "A browser with WebGPU or WebGL2 is required."]);
        }
        (Err(e), Some(kept)) => {
            log::error!("vectorcraft-web: couldn't restart the graphics: {}", js_err(e));
            give_up(slot.borrow_mut().take(), kept, bridge.as_ref());
        }
    }
}

/// The runner's options: wgpu (WebGPU where available, else WebGL2; `?webgl` forces WebGL2).
fn web_options() -> eframe::WebOptions {
    let mut options = eframe::WebOptions::default();
    if query_flag("webgl")
        && let eframe::egui_wgpu::WgpuSetup::CreateNew(create) = &mut options.wgpu_options.wgpu_setup
    {
        create.instance_descriptor.backends = eframe::wgpu::Backends::GL;
    }
    options
}

/// Tell the UI the browser's languages before the first frame, so the Automatic interface
/// language follows the browser (the web keeps no preferences between visits: it starts on
/// Automatic); and show the loading text in that language.
///
/// Evora (patch E3): a `?lang=` given by the host page is authoritative. A code the UI has, in any
/// case or form (`zh-Hans`, `zh-CN` → zh-hans), is the interface language; any other (`pt`, whose
/// variant is not chosen yet, or a language without a catalog) gives English, never the browser's
/// own languages. The page's `lang` attribute follows. Without `?lang=`, as before.
fn detect_language() {
    let imposed = query_param("lang");
    let mut tags: Vec<String> = imposed.iter().cloned().collect();
    if imposed.is_none()
        && let Some(navigator) = web_sys::window().map(|w| w.navigator())
    {
        tags.extend(navigator.languages().iter().filter_map(|v| v.as_string()));
        tags.extend(navigator.language());
    }
    i18n::set_system_locales(tags.as_slice());
    let lang = i18n::system_lang();
    set_page_lang(lang.code());
    if let Some(el) = element(LOADING_ID) {
        el.set_text_content(Some(i18n::message(lang, "Loading VectorCraft…").as_str()));
    }
}

/// The page's `lang` attribute (accessibility; the smoke test reads it).
pub(crate) fn set_page_lang(code: &str) {
    if let Some(root) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.document_element())
        && let Err(e) = root.set_attribute("lang", code)
    {
        log::warn!("couldn't set the page language: {e:?}");
    }
}

/// The value of `name=` in the address's query, if given.
fn query_param(name: &str) -> Option<String> {
    let query = query();
    query.trim_start_matches('?').split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('=').map(str::to_string)).filter(|v| !v.is_empty())
}

/// Evora (patch E2): the UI brightness the host page asks for with `?theme=light|dark`
/// (HOST-PROTOCOL §2.4): Light or Dark instead of the upstream Medium Dark. Any other value: none.
fn host_brightness() -> Option<&'static str> {
    match query_param("theme").as_deref() {
        Some("light") => Some("light"),
        Some("dark") => Some("dark"),
        _ => None,
    }
}

/// Whether the address's query has the flag `name` (`?webgl`, `?webgl=1`), matched by name: a value
/// that merely contains it (`?lang=webgl`) is not the flag (Evora, patch E3).
fn query_flag(name: &str) -> bool {
    query().trim_start_matches('?').split('&').any(|kv| kv.split('=').next() == Some(name))
}

fn query() -> String {
    web_sys::window().and_then(|w| w.location().search().ok()).unwrap_or_default()
}

fn element(id: &str) -> Option<web_sys::Element> {
    web_sys::window()?.document()?.get_element_by_id(id)
}

/// Follow file drags over `canvas` into `pos`: drag events carry the pointer position, which egui
/// doesn't get during a drag.
fn track_drag(canvas: &web_sys::HtmlCanvasElement, pos: &DragPos) {
    let p = pos.clone();
    let on_drag = wasm_bindgen::closure::Closure::<dyn FnMut(web_sys::DragEvent)>::new(move |e: web_sys::DragEvent| {
        p.set(Some((e.offset_x() as f32, e.offset_y() as f32, e.shift_key())));
    });
    for kind in ["dragover", "drop"] {
        if let Err(e) = canvas.add_event_listener_with_callback(kind, on_drag.as_ref().unchecked_ref()) {
            log::error!("couldn't follow {kind} events: {e:?}");
        }
    }
    // The listener lives as long as the canvas.
    on_drag.forget();
}

/// Take pictures and files pasted into the page (egui reads a paste's text only): a paste without
/// text hands the first of its files that is art (a bitmap, SVG, PDF, a metafile) to the next
/// frame. Text, SVG markup among it, is left to egui.
fn track_paste(pasted: &Rc<RefCell<Pasted>>) {
    let Some(window) = web_sys::window() else { return };
    let pasted = pasted.clone();
    let on_paste = wasm_bindgen::closure::Closure::<dyn FnMut(web_sys::ClipboardEvent)>::new(move |e: web_sys::ClipboardEvent| {
        let Some(data) = e.clipboard_data() else { return };
        let Some(files) = data.files().filter(|f| f.length() > 0) else { return };
        // Text is egui's, but for the address a browser's Copy Image puts next to the picture.
        if data.get_data("text").is_ok_and(|t| !t.is_empty() && !is_address(&t)) {
            return;
        }
        e.prevent_default();
        let held = pasted.borrow().ctx.as_ref().map(|c| c.input(|i| i.modifiers)).unwrap_or_default();
        let files: Vec<web_sys::File> = (0..files.length()).filter_map(|i| files.get(i)).collect();
        let pasted = pasted.clone();
        wasm_bindgen_futures::spawn_local(async move {
            for file in files {
                let bytes = match wasm_bindgen_futures::JsFuture::from(file.array_buffer()).await {
                    Ok(buf) => js_sys::Uint8Array::new(&buf).to_vec(),
                    Err(e) => {
                        log::error!("couldn't read the pasted file {}: {}", file.name(), js_err(e));
                        continue;
                    }
                };
                if let Some(mime) = file_flavour(&file.name(), bytes.get(..FILE_HEAD).unwrap_or(&bytes), &PASTE_ORDER) {
                    let mut p = pasted.borrow_mut();
                    p.flavour = Some((Flavour { mime, data: bytes }, held));
                    if let Some(ctx) = &p.ctx {
                        ctx.request_repaint();
                    }
                    return;
                }
            }
        });
    });
    // Captured before eframe's own listener, which stops the event.
    if let Err(e) = window.add_event_listener_with_callback_and_bool("paste", on_paste.as_ref().unchecked_ref(), true) {
        log::error!("couldn't follow paste events: {e:?}");
    }
    // The listener lives as long as the page.
    on_paste.forget();
}

/// Report the loss of `canvas`'s WebGL context to `loss` (WebGPU devices report theirs through
/// wgpu).
fn watch_canvas(canvas: &web_sys::HtmlCanvasElement, loss: &GraphicsLoss, ctx: &egui::Context) {
    let (loss, ctx) = (loss.clone(), ctx.clone());
    let on_lost = wasm_bindgen::closure::Closure::<dyn FnMut(web_sys::Event)>::new(move |_: web_sys::Event| {
        loss.report(&ctx, "the WebGL context was lost");
    });
    if let Err(e) = canvas.add_event_listener_with_callback("webglcontextlost", on_lost.as_ref().unchecked_ref()) {
        log::error!("couldn't watch for a lost WebGL context: {e:?}");
    }
    // The listener lives as long as the canvas.
    on_lost.forget();
}

/// A new canvas in place of `old`, whose graphics were lost (a canvas whose WebGL context is lost
/// can't get another).
fn fresh_canvas(old: &web_sys::HtmlCanvasElement) -> Result<web_sys::HtmlCanvasElement, String> {
    let new: web_sys::HtmlCanvasElement = old.clone_node().map_err(js_err)?.dyn_into().map_err(|_| "not a canvas")?;
    old.replace_with_with_node_1(&new).map_err(js_err)?;
    Ok(new)
}

/// The graphics are lost for good: the dead canvas goes (it would show a stale picture), the app
/// (if still here) lets go of its recovery copies so the reloaded page offers them at once, and
/// the page says what to do.
fn give_up(app: Option<VectorcraftApp>, kept: bool, bridge: Option<&Bridge>) {
    if let Some(mut app) = app {
        recovery::leave(&mut app.session);
    }
    // Evora (patch E4): the engine can't go on.
    if let Some(bridge) = bridge {
        bridge.fail("no_webgl2");
    }
    if let Some(canvas) = element(CANVAS_ID) {
        canvas.remove();
    }
    notice(&[
        "The graphics were lost and couldn't be restarted.",
        if kept {
            "Your unsaved changes are kept in this browser: reload the page to get them back."
        } else {
            "Reload the page to go on (changes not saved yet may be lost)."
        },
    ]);
}

/// Show `lines` in the middle of the page (where the loading message was).
fn notice(lines: &[&str]) {
    let Some(document) = web_sys::window().and_then(|w| w.document()) else { return };
    let el = match document.get_element_by_id(LOADING_ID) {
        Some(el) => el,
        None => {
            let Ok(el) = document.create_element("div") else { return };
            el.set_id(LOADING_ID);
            let Some(body) = document.body() else { return };
            if let Err(e) = body.append_child(&el) {
                log::error!("couldn't show a message: {e:?}");
            }
            el
        }
    };
    el.set_text_content(None);
    for line in lines {
        if let Ok(p) = document.create_element("p") {
            p.set_text_content(Some(i18n::message(i18n::system_lang(), line).as_str()));
            // Best effort: the log has the message too.
            el.append_child(&p).ok();
        }
    }
}

/// Wraps the app to read dropped files asynchronously (browsers can't read them synchronously)
/// and feed them through the inboxes: placed where they were dropped on the canvas, else opened
/// (libraries, presets and plug-ins open wherever they are dropped).
/// When the graphics are lost it hands the app to a new runner on a new canvas.
struct WebShell {
    /// `None` once handed on.
    app: Option<VectorcraftApp>,
    host: Host,
    canvas: web_sys::HtmlCanvasElement,
    loss: GraphicsLoss,
}

impl WebShell {
    /// The graphics were lost (`why`): keep recovery copies, then start again on a new canvas
    /// with the same app once this frame is over (the runner is busy with it until then).
    fn restart(&mut self, why: &str) {
        let Some(mut app) = self.app.take() else { return };
        let kept = app.graphics_lost(why);
        let mut host = self.host.clone();
        host.restarts += 1;
        let canvas =
            if host.restarts > MAX_RESTARTS { Err(format!("the graphics were lost {MAX_RESTARTS} times")) } else { fresh_canvas(&self.canvas) };
        match canvas {
            Ok(canvas) => wasm_bindgen_futures::spawn_local(run(host, canvas, Some(Moving { app, kept }))),
            Err(e) => {
                log::error!("vectorcraft-web: giving up on the graphics: {e}");
                let runner = host.runner.clone();
                wasm_bindgen_futures::spawn_local(async move { runner.destroy() });
                give_up(Some(app), kept, host.bridge.as_ref());
            }
        }
    }
}

impl eframe::App for WebShell {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Some(why) = self.loss.take() {
            self.restart(&why);
        }
        let Some(app) = &mut self.app else { return };
        // Evora (patch E4): what the host asked since the last frame.
        if let Some(bridge) = &self.host.bridge {
            bridge.before_frame(app);
        }
        let pasted = self.host.pasted.borrow_mut().flavour.take();
        if let Some((f, held)) = pasted {
            app.paste_from_host(ctx, f, held);
        }
        let dropped = ctx.input_mut(|i| std::mem::take(&mut i.raw.dropped_files));
        if !dropped.is_empty() {
            let at = self.host.drag.take();
            let z = ctx.zoom_factor();
            let (pos, shift) = (at.map(|(x, y, _)| egui::pos2(x / z, y / z)), at.is_some_and(|a| a.2));
            for f in dropped {
                let name = f.path().file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "dropped".into());
                let target = app.drop_target(&name, pos, shift);
                let (inbox, place_inbox, ctx) = (self.host.inbox.clone(), self.host.place_inbox.clone(), ctx.clone());
                wasm_bindgen_futures::spawn_local(async move {
                    match f.bytes_async().await {
                        Ok(bytes) => {
                            match target {
                                DropTarget::Place(d) => {
                                    place_inbox.lock().unwrap_or_else(|e| e.into_inner()).push(PlaceArrival { name, bytes, drop: Some(d) })
                                }
                                DropTarget::Open => inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes)),
                            }
                            ctx.request_repaint();
                        }
                        Err(e) => log::error!("couldn't read dropped file {name}: {e}"),
                    }
                });
            }
        }
        app.logic(ctx);
        if let Some(bridge) = &self.host.bridge {
            bridge.after_frame(app);
        }
    }

    fn raw_input_hook(&mut self, _ctx: &egui::Context, raw: &mut egui::RawInput) {
        if let Some(app) = &mut self.app {
            app.raw_input_hook(raw);
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        if let Some(app) = &mut self.app {
            if let Some(bridge) = &self.host.bridge {
                bridge.note_active(app);
            }
            app.ui(ui);
            if let Some(bridge) = &self.host.bridge {
                bridge.after_frame(app);
            }
        }
    }
}

fn services(inbox: Inbox, place_inbox: PlaceInbox, ctx: egui::Context, recovery: Arc<dyn RecoveryStore>, bridge: Option<Bridge>) -> Services {
    let open_inbox = inbox.clone();
    let picked = place_inbox.clone();
    let place_ctx = ctx.clone();
    Services {
        // File → Place…: the picked files go to the Place dialog.
        place_async: Some(Box::new(move || {
            let inbox = picked.clone();
            let ctx = place_ctx.clone();
            wasm_bindgen_futures::spawn_local(async move {
                let dialog =
                    fileio::place_filters().fold(rfd::AsyncFileDialog::new().set_title(vectorcraft_ui_egui::i18n::t("Place")), |d, (name, exts)| {
                        d.add_filter(vectorcraft_ui_egui::i18n::tr_ctx(vectorcraft_ui_egui::i18n::current(), "file-filter", name), exts)
                    });
                let Some(files) = dialog.pick_files().await else {
                    return;
                };
                let mut arrived = vec![];
                for f in files {
                    arrived.push(PlaceArrival { name: f.file_name(), bytes: f.read().await, drop: None });
                }
                inbox.lock().unwrap_or_else(|e| e.into_inner()).extend(arrived);
                ctx.request_repaint();
            });
        })),
        place_inbox: Some(place_inbox),
        open_async: Some(Box::new(move || {
            let inbox = open_inbox.clone();
            let ctx = ctx.clone();
            wasm_bindgen_futures::spawn_local(async move {
                let dialog = fileio::open_filters().fold(rfd::AsyncFileDialog::new(), |d, (name, exts)| {
                    d.add_filter(vectorcraft_ui_egui::i18n::tr_ctx(vectorcraft_ui_egui::i18n::current(), "file-filter", name), exts)
                });
                let Some(file) = dialog.pick_file().await else {
                    return;
                };
                let bytes = file.read().await;
                inbox.lock().unwrap_or_else(|e| e.into_inner()).push((file.file_name(), bytes));
                ctx.request_repaint();
            });
        })),
        download: Some(Box::new(move |name: &str, bytes: &[u8]| {
            // Evora (patch E4): a save of the document the host opened goes to the host
            // (`evora:save`), never to a download.
            if bridge.as_ref().is_some_and(|b| b.take_download(name, bytes)) {
                return;
            }
            if let Err(e) = download(name, bytes) {
                log::error!("download of {name} failed: {e}");
            }
        })),
        inbox: Some(inbox),
        recovery_store: Some(recovery),
        // File → Print: the browser's print dialog.
        print: Some(Box::new(BrowserPrint)),
        // Evora (patch E7): the embedded editor opens no page of its own, whatever asks (a Help
        // link, a contributor's profile, an object's URL read from a document): the host page
        // decides what to open. Without this service egui would open a new tab.
        open_url: Some(Box::new(|url: &str| log::warn!("vectorcraft-web: not opening {url}: links are disabled in this build"))),
        ..Default::default()
    }
}

/// Data Recovery's store on the web: the browser's local storage (kept across visits and shared by
/// the site's tabs), each entry as base64 under [`RECOVERY_PREFIX`]`<area>/<name>`. It has no
/// locks: each tab holds its area with a heartbeat, judged by the browser's clock, and with a Web
/// Lock named after it where the browser has them (`locks`), which a tab whose timers are paused
/// in the background keeps.
struct BrowserStore {
    locks: Option<WebLocks>,
}

const RECOVERY_PREFIX: &str = "vectorcraft-recovery/";

/// Evora (patches E4, E5): is the page hosted by Evora (`?host=evora`, HOST-PROTOCOL §2.4)? Then
/// it keeps nothing in the browser (Data Recovery in memory for the tab's life, no Web Lock) and
/// speaks EHP with the parent `evora-host.json` admits. The address only switches modes: it never
/// deletes anything, and the account's storage namespace (`storageNs`) only arrives by message.
/// Not hosted: as upstream.
fn hosted_by_evora() -> bool {
    query_param("host").as_deref() == Some("evora")
}

/// Evora (patch E5): remove what Data Recovery left in this origin's local storage under
/// [`RECOVERY_PREFIX`] (earlier sessions, perhaps another account's), then check none is left →
/// how many went. Only for a verified `evora:init` or `evora:purge` (host bridge, patch E4). Other keys of the
/// origin (other engines', the host's) are left alone; this engine has nothing in OPFS, IndexedDB
/// or the Cache API.
pub(crate) fn purge_browser_storage() -> Result<usize, String> {
    let storage = match web_sys::window().ok_or("no window")?.local_storage() {
        Ok(Some(s)) => s,
        // No storage here: nothing could have been kept.
        Ok(None) => return Ok(0),
        Err(e) => return Err(format!("browser storage is out of reach: {}", js_err(e))),
    };
    let keys = recovery_keys(&storage);
    for key in &keys {
        storage.remove_item(key).map_err(|e| format!("couldn't remove {key}: {}", js_err(e)))?;
    }
    match recovery_keys(&storage).len() {
        0 => Ok(keys.len()),
        left => Err(format!("{left} entries are still there")),
    }
}

/// The keys of Data Recovery's entries in `storage`.
fn recovery_keys(storage: &web_sys::Storage) -> Vec<String> {
    let n = storage.length().unwrap_or(0);
    (0..n).filter_map(|i| storage.key(i).ok().flatten()).filter(|k| k.starts_with(RECOVERY_PREFIX)).collect()
}

/// Evora (patch E5): Data Recovery's store while hosted: in memory for the tab's life (no browser
/// storage, no Web Lock), and closed for good by [`HostedStore::purge`] (`evora:purge`): from then on
/// every write is refused, so nothing comes back after the purge.
#[derive(Default)]
pub(crate) struct HostedStore {
    copies: recovery::MemoryStore,
    closed: AtomicBool,
}

impl HostedStore {
    /// Refuse every write from now on, then drop every copy → how many went.
    pub(crate) fn purge(&self) -> usize {
        self.closed.store(true, Ordering::SeqCst);
        let names = self.copies.list().unwrap_or_default();
        for name in &names {
            let _ = self.copies.remove(name);
        }
        names.len()
    }
}

impl RecoveryStore for HostedStore {
    fn list(&self) -> Result<Vec<String>, String> {
        self.copies.list()
    }
    fn read(&self, name: &str) -> Result<Vec<u8>, String> {
        self.copies.read(name)
    }
    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("Data Recovery is off: Evora purged this editor's storage".into());
        }
        self.copies.write(name, bytes)
    }
    fn remove(&self, name: &str) -> Result<(), String> {
        self.copies.remove(name)
    }
    fn location(&self) -> String {
        self.copies.location()
    }
    fn areas(&self) -> Result<Vec<String>, String> {
        self.copies.areas()
    }
    fn lock(&self, area: &str) -> Result<Lock, String> {
        self.copies.lock(area)
    }
    fn announce(&self, area: &str) -> Option<Hold> {
        self.copies.announce(area)
    }
    fn announced(&self, area: &str) -> Option<bool> {
        self.copies.announced(area)
    }
    fn remove_area(&self, area: &str) {
        self.copies.remove_area(area)
    }
    fn now(&self) -> Option<i64> {
        self.copies.now()
    }
}

fn js_err(e: wasm_bindgen::JsValue) -> String {
    format!("{e:?}")
}

fn local_storage() -> Result<web_sys::Storage, String> {
    web_sys::window().ok_or("no window")?.local_storage().map_err(js_err)?.ok_or_else(|| "browser storage is turned off".into())
}

impl RecoveryStore for BrowserStore {
    fn list(&self) -> Result<Vec<String>, String> {
        let s = local_storage()?;
        let n = s.length().map_err(js_err)?;
        Ok((0..n).filter_map(|i| s.key(i).ok().flatten()).filter_map(|k| k.strip_prefix(RECOVERY_PREFIX).map(str::to_string)).collect())
    }
    fn read(&self, name: &str) -> Result<Vec<u8>, String> {
        let text = local_storage()?.get_item(&format!("{RECOVERY_PREFIX}{name}")).map_err(js_err)?;
        text.and_then(|t| vectorcraft_format::base64_decode(&t)).ok_or_else(|| format!("{name}: no such recovery entry"))
    }
    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        local_storage()?
            .set_item(&format!("{RECOVERY_PREFIX}{name}"), &vectorcraft_format::base64_encode(bytes))
            .map_err(|e| format!("browser storage is full or turned off: {}", js_err(e)))
    }
    fn remove(&self, name: &str) -> Result<(), String> {
        local_storage()?.remove_item(&format!("{RECOVERY_PREFIX}{name}")).map_err(js_err)
    }
    fn location(&self) -> String {
        "browser storage".into()
    }
    fn now(&self) -> Option<i64> {
        Some((js_sys::Date::now() / 1000.0) as i64)
    }
    fn announce(&self, area: &str) -> Option<Hold> {
        self.locks.as_ref()?.hold(area)
    }
    fn announced(&self, area: &str) -> Option<bool> {
        self.locks.as_ref().map(|l| l.held(area))
    }
}

/// Trigger a browser download of `bytes` named after the last component of `path`.
fn download(path: &str, bytes: &[u8]) -> Result<(), String> {
    let js = |e: wasm_bindgen::JsValue| format!("{e:?}");
    let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "vectorcraft".into());
    let window = web_sys::window().ok_or("no window")?;
    let document = window.document().ok_or("no document")?;
    let url = blob_url(bytes, fileio::format_for_name(&name).map_or("application/octet-stream", |f| f.mime))?;
    let a: web_sys::HtmlAnchorElement = document.create_element("a").map_err(js)?.dyn_into().map_err(|_| "not an anchor")?;
    a.set_href(&url);
    a.set_download(&name);
    a.style().set_property("display", "none").map_err(js)?;
    let body = document.body().ok_or("no body")?;
    body.append_child(&a).map_err(js)?;
    a.click();
    a.remove();
    // Revoke after the click has been dispatched; the download keeps its own reference.
    let revoke = wasm_bindgen::closure::Closure::once_into_js(move || {
        web_sys::Url::revoke_object_url(&url).ok();
    });
    window.set_timeout_with_callback_and_timeout_and_arguments_0(revoke.unchecked_ref(), 10_000).map_err(js)?;
    Ok(())
}

/// An object URL of a blob of `bytes` with media type `mime` (revoke it when done).
fn blob_url(bytes: &[u8], mime: &str) -> Result<String, String> {
    let parts = js_sys::Array::of1(&js_sys::Uint8Array::from(bytes));
    let opts = web_sys::BlobPropertyBag::new();
    opts.set_type(mime);
    let blob = web_sys::Blob::new_with_u8_array_sequence_and_options(&parts, &opts).map_err(js_err)?;
    web_sys::Url::create_object_url_with_blob(&blob).map_err(js_err)
}

/// File → Print in the browser: the job's PDF in a hidden frame, printed through the browser's
/// print dialog (which picks the printer).
struct BrowserPrint;

/// The frame holding the last print job (the next job replaces it).
const PRINT_FRAME_ID: &str = "vectorcraft-print-frame";

impl PrintService for BrowserPrint {
    fn printers(&mut self) -> Vec<Printer> {
        // Browsers don't tell pages about printers: their print dialog lists them.
        vec![]
    }

    fn print(&mut self, job: &PrintJob) -> Result<String, String> {
        print_pdf(job.pdf)?;
        Ok(format!("Printing “{}”: pick the printer in the browser's print dialog", job.title))
    }
}

fn print_pdf(pdf: &[u8]) -> Result<(), String> {
    let document = web_sys::window().and_then(|w| w.document()).ok_or("no document")?;
    // The previous job's frame and its blob go first.
    if let Some(old) = document.get_element_by_id(PRINT_FRAME_ID) {
        if let Some(url) = old.get_attribute("src") {
            web_sys::Url::revoke_object_url(&url).ok();
        }
        old.remove();
    }
    let url = blob_url(pdf, "application/pdf")?;
    let frame: web_sys::HtmlIFrameElement = document.create_element("iframe").map_err(js_err)?.dyn_into().map_err(|_| "not a frame")?;
    frame.set_id(PRINT_FRAME_ID);
    // Out of sight but laid out: browsers don't print a frame that isn't.
    let style = frame.style();
    for (k, v) in [("position", "fixed"), ("right", "0"), ("bottom", "0"), ("width", "0"), ("height", "0"), ("border", "0")] {
        style.set_property(k, v).map_err(js_err)?;
    }
    let loaded = frame.clone();
    let onload = wasm_bindgen::closure::Closure::once_into_js(move || {
        if let Some(w) = loaded.content_window() {
            w.focus().ok();
            if let Err(e) = w.print() {
                log::error!("printing failed: {e:?}");
            }
        }
    });
    frame.set_onload(Some(onload.unchecked_ref()));
    frame.set_src(&url);
    document.body().ok_or("no body")?.append_child(&frame).map_err(js_err)?;
    Ok(())
}
