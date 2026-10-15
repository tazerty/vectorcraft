//! Evora (patch E4): the native Evora host protocol bridge, EHP v1 (`apps/creative/HOST-PROTOCOL.md`
//! in Evora). With `?host=evora` the engine talks to its parent page only when that page's origin
//! is admitted by `evora-host.json`, written next to `index.html` when Evora provisions the build
//! (HOST-PROTOCOL §2.3) and shipped empty, which keeps the bridge silent: never from a URL
//! parameter, a message or the referrer alone.
//!
//! Every message is `{ v: 1, type, id, re?, payload }` (§3). Incoming messages are examined only if
//! `event.source` is the parent window AND `event.origin` is the admitted parent origin (§5.1), then
//! checked in the order of §5.2 (plain object, version, known type, capability, envelope, payload,
//! binary sizes, correlation); anything else is ignored. Outgoing messages always name the parent
//! origin as `targetOrigin`, never `*`, with fresh ULIDs.
//!
//! Handled: `evora:init`, `evora:open` (bytes, or `new: true`: a blank document that has no Drive
//! file yet, §7.1), `evora:request-save`, `evora:saved` (checked only:
//! without `doc.saved-ack` the engine counts a document as saved once handed over and the host keeps
//! its own save state, §6.3), `evora:lang`, `evora:theme`, `evora:purge`. Sent: `evora:ready`,
//! `evora:failed`, `evora:ack`, `evora:dirty`, `evora:save`.
//!
//! Storage (patch E5): hosted, Data Recovery keeps its copies in memory ([`HostedStore`]) and the
//! engine writes nothing to the browser. What earlier sessions left under `vectorcraft-recovery/`
//! goes only on a verified `evora:init` (every namespace but the account's, §7.7 b: here, all of
//! them) or `evora:purge`, never because of an address.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use vectorcraft_engine::cmd::fileio::{self, SaveMode};
use vectorcraft_engine::cmd::recovery;
use vectorcraft_ui_egui::VectorcraftApp;
use vectorcraft_ui_egui::i18n;
use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;

use crate::web::HostedStore;

/// Build slug and protocol version announced in `evora:ready` (§4.4, §10).
const APP: &str = "sinopia-pro";
const EHP: &str = "1.0";
/// What this engine honours (§9.1), each one exercised by the CI smoke test (scenario
/// `pont-ehp`). Not declared: `storage.ns` and `storage.memory` (hosted, nothing is kept in the
/// browser to prefix, and no Data Recovery copy is written during the smoke test),
/// `doc.saved-ack`, `export.drive`, `pick.drive`, `font.inject`, `doc.multi`.
const CAPABILITIES: [&str; 7] = ["doc.open", "doc.save", "doc.dirty", "doc.request-save", "storage.purge", "live.lang", "live.theme"];
/// The admitted parent origins, beside `index.html` (§2.3).
const CONFIG: &str = "evora-host.json";
const LANGS: [&str; 14] = ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "pt", "ru", "tr", "zh-Hans"];
const CAPABILITY_NAMES: [&str; 18] = [
    "doc.open",
    "doc.save",
    "doc.saved-ack",
    "doc.dirty",
    "doc.multi",
    "doc.request-save",
    "export.drive",
    "media.need",
    "media.ranges",
    "pick.drive",
    "command",
    "storage.ns",
    "storage.memory",
    "storage.purge",
    "live.lang",
    "live.theme",
    "font.inject",
    "author",
];
const SAVE_REASONS: [&str; 5] = ["autosave", "visibility", "close", "logout", "user"];
const ACK_CODES: [&str; 16] = [
    "clean",
    "cancelled",
    "conflict",
    "too_large",
    "quota",
    "forbidden",
    "not_found",
    "invalid_content",
    "unsupported",
    "rate_limited",
    "read_only",
    "busy",
    "capability",
    "network",
    "server",
    "timeout",
];
/// The format every save to the host carries: the native document, lossless.
const NATIVE_FORMAT: &str = "vectorcraft";
/// `evora:save` messages still waiting for their `evora:saved`, at most.
const MAX_PENDING_SAVES: usize = 64;

/// What the host asked that needs the app, applied at the start of the next frame
/// ([`Bridge::before_frame`]).
enum HostEvent {
    /// The interface language (an engine language tag; `None`: English) from `evora:init` (`id`:
    /// none) or `evora:lang` (answered once applied).
    Lang { id: Option<String>, tag: Option<String> },
    /// Dark or light, from `evora:init` or `evora:theme`.
    Theme { id: Option<String>, dark: bool },
    /// `evora:open`: the document's bytes, or `None` for a blank one (`new: true`).
    Open { id: String, doc_ref: String, name: String, bytes: Option<Vec<u8>> },
    RequestSave { id: String, doc_ref: Option<String> },
    /// A save handed to the host's `download` couldn't go: the document counts as modified again.
    SaveRefused { uid: u64 },
    /// `evora:purge`: the storage is already empty; Data Recovery stops for good.
    Purged,
}

/// The document the host opened (one at a time: no `doc.multi`).
struct Hosted {
    uid: u64,
    doc_ref: String,
    /// The name its saves carry: the host's, with the native extension.
    name: String,
}

#[derive(Clone)]
struct Peer {
    parent: web_sys::Window,
    origin: String,
}

#[derive(Default)]
struct Inner {
    /// The admitted parent, once `evora-host.json` is read: until then the bridge is silent.
    peer: Option<Peer>,
    ready_id: Option<String>,
    /// The engine couldn't start: `evora:failed` instead of (or after) `evora:ready`.
    failed: Option<&'static str>,
    initialized: bool,
    /// The effective capabilities: what the host offers and this engine declares (§9).
    caps: Vec<String>,
    max_document: f64,
    events: Vec<HostEvent>,
    pending_saves: Vec<String>,
    hosted: Option<Hosted>,
    last_dirty: Option<bool>,
    /// The language code last written to the page's `lang` attribute.
    page_lang: Option<&'static str>,
    /// The active document at the start of the frame part running now (a save acts on it).
    active: Option<u64>,
    ctx: Option<egui::Context>,
}

/// The bridge of a page hosted by Evora (`?host=evora`).
#[derive(Clone)]
pub struct Bridge {
    inner: Rc<RefCell<Inner>>,
    store: Arc<HostedStore>,
}

impl Bridge {
    /// Read `evora-host.json`, and if it admits the parent, listen and announce `evora:ready`,
    /// before the engine touches any browser storage (§4.4).
    pub fn start(store: Arc<HostedStore>) -> Self {
        let bridge = Self { inner: Rc::default(), store };
        let connecting = bridge.clone();
        wasm_bindgen_futures::spawn_local(async move { connecting.connect().await });
        bridge
    }

    async fn connect(self) {
        let Some((window, peer)) = admitted_parent().await else {
            log::info!("vectorcraft-web: Evora host bridge silent: no admitted parent origin in {CONFIG}");
            return;
        };
        let listener = self.clone();
        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| listener.receive(&event));
        if let Err(e) = window.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()) {
            log::error!("vectorcraft-web: couldn't listen to the Evora host: {e:?}");
            return;
        }
        // The listener lives as long as the page.
        on_message.forget();
        let failed = {
            let mut inner = self.inner.borrow_mut();
            inner.peer = Some(peer);
            inner.failed
        };
        match failed {
            Some(code) => self.post_failed(code),
            None => self.post_ready(),
        }
    }

    /// The app runs (again, after a graphics restart) on `ctx`: requests wake it.
    pub fn set_context(&self, ctx: &egui::Context) {
        self.inner.borrow_mut().ctx = Some(ctx.clone());
    }

    /// The engine can't start, or can't go on: `evora:failed {code}` (§4.4), once.
    pub fn fail(&self, code: &'static str) {
        let connected = {
            let mut inner = self.inner.borrow_mut();
            if inner.failed.is_some() {
                return;
            }
            inner.failed = Some(code);
            inner.peer.is_some()
        };
        if connected {
            self.post_failed(code);
        }
    }

    /// Before the app's own logic each frame: note the active document and do what the host asked.
    pub fn before_frame(&self, app: &mut VectorcraftApp) {
        self.note_active(app);
        let events = std::mem::take(&mut self.inner.borrow_mut().events);
        for event in events {
            match event {
                HostEvent::Lang { id, tag } => {
                    set_language(app, tag.as_deref());
                    if let Some(id) = id {
                        self.ack(&id, true, None);
                    }
                }
                HostEvent::Theme { id, dark } => {
                    // E2's brightness: the accent is Evora's indigo already.
                    app.session.prefs.ui_brightness = String::from(if dark { "dark" } else { "light" });
                    app.canvas.key = None;
                    if let Some(id) = id {
                        self.ack(&id, true, None);
                    }
                }
                HostEvent::Open { id, doc_ref, name, bytes } => self.open(app, &id, doc_ref, &name, bytes.as_deref()),
                HostEvent::RequestSave { id, doc_ref } => self.request_save(app, &id, doc_ref.as_deref()),
                HostEvent::SaveRefused { uid } => {
                    if let Some(st) = app.session.document_mut(uid) {
                        // A saved state that is a copy of the document: modified, as before the save.
                        let unsaved = Arc::new((*st.doc).clone());
                        st.mark_saved_as(&unsaved);
                    }
                    app.status("Not saved: Evora didn't take the document");
                }
                HostEvent::Purged => {
                    recovery::forget_all(&mut app.session);
                    app.session.prefs.autosave_recovery = false;
                }
            }
        }
        self.note_active(app);
    }

    /// The active document, for a save the app runs next ([`Bridge::take_download`]).
    pub fn note_active(&self, app: &VectorcraftApp) {
        self.inner.borrow_mut().active = app.session.active().map(|d| d.uid);
    }

    /// After the app's logic or layout: the page's `lang` follows the language the UI is drawn in,
    /// and `evora:dirty` goes when the hosted document's modified state changed (and once after it
    /// opened).
    pub fn after_frame(&self, app: &VectorcraftApp) {
        self.note_lang();
        let (uid, doc_ref) = {
            let inner = self.inner.borrow();
            match &inner.hosted {
                Some(h) if inner.caps.iter().any(|c| c == "doc.dirty") => (h.uid, h.doc_ref.clone()),
                _ => return,
            }
        };
        let Some(dirty) = app.session.documents().iter().find(|d| d.uid == uid).map(|d| d.is_dirty()) else {
            // Closed in the app: nothing to tell until the host opens a document again.
            let mut inner = self.inner.borrow_mut();
            inner.hosted = None;
            inner.last_dirty = None;
            return;
        };
        {
            let mut inner = self.inner.borrow_mut();
            if inner.last_dirty == Some(dirty) {
                return;
            }
            inner.last_dirty = Some(dirty);
        }
        if let Some(payload) = object(&[("dirty", dirty.into()), ("docRef", doc_ref.into())]) {
            self.send("evora:dirty", None, &payload, None);
        }
    }

    /// The page's `lang` attribute is the language the UI is drawn in this frame (what the app took
    /// from `evora:init`, `evora:lang` or `?lang=`), read back from the UI, not the one asked for.
    fn note_lang(&self) {
        let code = i18n::current().code();
        let changed = {
            let mut inner = self.inner.borrow_mut();
            let changed = inner.page_lang != Some(code);
            inner.page_lang = Some(code);
            changed
        };
        if changed {
            crate::web::set_page_lang(code);
        }
    }

    /// The app's `download` service while hosted: the document the host opened, saved by the app
    /// (File › Save, its shortcut) as itself, goes to the host (`evora:save`) and never to a
    /// download → whether it was taken (else the caller downloads, as upstream does).
    pub fn take_download(&self, name: &str, bytes: &[u8]) -> bool {
        let (uid, doc_ref, max) = {
            let inner = self.inner.borrow();
            let Some(h) = &inner.hosted else { return false };
            if !inner.initialized || !inner.caps.iter().any(|c| c == "doc.save") || inner.active != Some(h.uid) || h.name != name {
                return false;
            }
            (h.uid, h.doc_ref.clone(), inner.max_document)
        };
        if bytes.is_empty() || bytes.len() as f64 > max || !self.post_save(&doc_ref, name, bytes, None) {
            log::error!("vectorcraft-web: {name} couldn't go to Evora ({} bytes)", bytes.len());
            self.inner.borrow_mut().events.push(HostEvent::SaveRefused { uid });
            self.wake();
        }
        true
    }

    fn post_ready(&self) {
        let capabilities = js_sys::Array::new();
        for c in CAPABILITIES {
            capabilities.push(&JsValue::from_str(c));
        }
        let Some(payload) = object(&[
            ("app", APP.into()),
            ("version", env!("CARGO_PKG_VERSION").into()),
            ("ehp", EHP.into()),
            ("capabilities", capabilities.into()),
        ]) else {
            return;
        };
        let id = self.send("evora:ready", None, &payload, None);
        self.inner.borrow_mut().ready_id = id;
    }

    fn post_failed(&self, code: &'static str) {
        if let Some(payload) = object(&[("code", code.into())]) {
            self.send("evora:failed", None, &payload, None);
        }
    }

    /// `evora:save {docRef, name, saveAs: false, bytes}` (`re`: the request it answers).
    fn post_save(&self, doc_ref: &str, name: &str, bytes: &[u8], re: Option<&str>) -> bool {
        let buffer = js_sys::Uint8Array::from(bytes).buffer();
        let Some(payload) =
            object(&[("docRef", doc_ref.into()), ("name", name.into()), ("saveAs", false.into()), ("bytes", buffer.clone().into())])
        else {
            return false;
        };
        let Some(id) = self.send("evora:save", re, &payload, Some(&buffer)) else { return false };
        let mut inner = self.inner.borrow_mut();
        if inner.pending_saves.len() >= MAX_PENDING_SAVES {
            inner.pending_saves.remove(0);
        }
        inner.pending_saves.push(id);
        true
    }

    fn ack(&self, re: &str, ok: bool, code: Option<&str>) {
        let mut fields: Vec<(&str, JsValue)> = vec![("ok", ok.into())];
        if let Some(code) = code {
            fields.push(("code", code.into()));
        }
        if let Some(payload) = object(&fields) {
            self.send("evora:ack", Some(re), &payload, None);
        }
    }

    /// Post a message to the admitted parent origin (never `*`) → its `id`.
    fn send(&self, kind: &str, re: Option<&str>, payload: &js_sys::Object, transfer: Option<&JsValue>) -> Option<String> {
        let peer = self.inner.borrow().peer.clone()?;
        let (message, id) = envelope(kind, re, payload)?;
        let sent = match transfer {
            Some(t) => peer.parent.post_message_with_transfer(&message, &peer.origin, &js_sys::Array::of1(t)),
            None => peer.parent.post_message(&message, &peer.origin),
        };
        match sent {
            Ok(()) => Some(id),
            Err(e) => {
                log::error!("vectorcraft-web: couldn't send {kind} to Evora: {e:?}");
                None
            }
        }
    }

    fn wake(&self) {
        let ctx = self.inner.borrow().ctx.clone();
        if let Some(ctx) = ctx {
            ctx.request_repaint();
        }
    }

    fn receive(&self, event: &web_sys::MessageEvent) {
        // §5.1: source AND origin.
        let Some(peer) = self.inner.borrow().peer.clone() else { return };
        if event.origin() != peer.origin || !event.source().is_some_and(|s| js_sys::Object::is(&s, &peer.parent)) {
            return;
        }
        // §5.2: a plain object, version 1, a known type, a capability in the effective set, a
        // well-formed envelope.
        let data = event.data();
        if !plain_object(&data) || get(&data, "v").as_f64() != Some(1.0) {
            return;
        }
        let Some(kind) = get(&data, "type").as_string() else { return };
        // (capability, is a reply: `re` required, else forbidden)
        let (capability, reply) = match kind.as_str() {
            "evora:init" => (None, true),
            "evora:open" => (Some("doc.open"), false),
            "evora:request-save" => (Some("doc.request-save"), false),
            "evora:saved" => (Some("doc.save"), true),
            "evora:lang" => (Some("live.lang"), false),
            "evora:theme" => (Some("live.theme"), false),
            "evora:purge" => (Some("storage.purge"), false),
            // Unknown here, or for a capability this engine doesn't declare: ignored (§4.1, §10).
            _ => return,
        };
        if let Some(c) = capability {
            let inner = self.inner.borrow();
            if !inner.initialized || !inner.caps.iter().any(|have| have == c) {
                return;
            }
        }
        if !only_keys(&data, &["v", "type", "id", "re", "payload"]) {
            return;
        }
        let Some(id) = get(&data, "id").as_string().filter(|i| is_ulid(i)) else { return };
        let re = get(&data, "re");
        let re = match (re.is_undefined(), reply) {
            (true, false) => None,
            (false, true) => match re.as_string().filter(|r| is_ulid(r)) {
                Some(r) => Some(r),
                None => return,
            },
            // A reply without `re`, or a request with one (§3).
            _ => return,
        };
        let payload = get(&data, "payload");
        if !plain_object(&payload) {
            return;
        }
        match kind.as_str() {
            "evora:init" => self.on_init(&id, re.as_deref(), &payload),
            "evora:open" => self.on_open(&id, &payload),
            "evora:request-save" => self.on_request_save(&id, &payload),
            "evora:saved" => self.on_saved(re.as_deref(), &payload),
            "evora:lang" => self.on_lang(&id, &payload),
            "evora:theme" => self.on_theme(&id, &payload),
            "evora:purge" => self.on_purge(&id, &payload),
            _ => {}
        }
    }

    fn on_init(&self, id: &str, re: Option<&str>, p: &JsValue) {
        {
            let inner = self.inner.borrow();
            if inner.initialized || inner.ready_id.is_none() || inner.ready_id.as_deref() != re {
                return;
            }
        }
        let required = ["lang", "engineLang", "theme", "accent", "readOnly", "storageNs", "capabilities", "prefs", "limits"];
        let mut allowed = required.to_vec();
        allowed.push("displayName");
        if !only_keys(p, &allowed) || !required.iter().all(|k| !get(p, k).is_undefined()) {
            return;
        }
        let Some(tag) = engine_lang(&get(p, "engineLang")) else { return };
        let Some(dark) = theme(&get(p, "theme")) else { return };
        let display_name = get(p, "displayName");
        let display_name_ok = display_name.is_undefined() || display_name.as_string().is_some_and(|a| (1..=100).contains(&a.chars().count()));
        let Some(caps) = string_list(&get(p, "capabilities")).filter(|c| c.iter().all(|x| CAPABILITY_NAMES.contains(&x.as_str()))) else {
            return;
        };
        let limits = get(p, "limits");
        let max_document = get(&limits, "maxDocumentBytes").as_f64();
        let max_export = get(&limits, "maxExportBytes").as_f64();
        let limits_ok = plain_object(&limits)
            && only_keys(&limits, &["maxDocumentBytes", "maxExportBytes"])
            && [max_document, max_export].iter().all(|m| m.is_some_and(|m| m >= 1.0 && m.fract() == 0.0));
        let ok = get(p, "lang").as_string().is_some_and(|l| LANGS.contains(&l.as_str()))
            && accent(&get(p, "accent"))
            && get(p, "readOnly").as_bool().is_some()
            && get(p, "storageNs").as_string().is_some_and(|ns| ns.len() == 64 && ns.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            && display_name_ok
            && prefs(&get(p, "prefs"))
            && limits_ok;
        let (true, Some(max_document)) = (ok, max_document) else { return };
        // §7.7 b, before the answer: every trace of this engine outside the account's namespace
        // goes. Hosted, the engine keeps nothing in the browser, so that is all of them: copies
        // earlier sessions (perhaps another account's) left in this origin.
        match crate::web::purge_browser_storage() {
            Ok(n) => log::info!("vectorcraft-web: Evora init: {n} recovery entries left by earlier sessions purged"),
            Err(e) => log::warn!("vectorcraft-web: Evora init: couldn't purge earlier recovery entries: {e}"),
        }
        {
            let mut inner = self.inner.borrow_mut();
            inner.caps = caps.into_iter().filter(|c| CAPABILITIES.contains(&c.as_str())).collect();
            inner.max_document = max_document;
            inner.initialized = true;
            inner.events.push(HostEvent::Lang { id: None, tag });
            inner.events.push(HostEvent::Theme { id: None, dark });
        }
        self.ack(id, true, None);
        self.wake();
    }

    fn on_open(&self, id: &str, p: &JsValue) {
        if !only_keys(p, &["docRef", "name", "bytes", "url", "new"]) {
            return;
        }
        let Some(doc_ref) = get(p, "docRef").as_string().filter(|r| is_ulid(r)) else { return };
        let Some(name) = get(p, "name").as_string().filter(|n| is_name(n)) else { return };
        let (bytes, url, new) = (get(p, "bytes"), get(p, "url"), get(p, "new"));
        if [&bytes, &url, &new].iter().filter(|v| !v.is_undefined()).count() != 1 {
            return;
        }
        if !url.is_undefined() {
            // `url` needs `media.ranges`, which this engine doesn't declare.
            if url.as_string().is_some() {
                self.ack(id, false, Some("capability"));
            }
            return;
        }
        if !new.is_undefined() {
            // `new: true` (its only value): a blank document, which has no Drive file yet (§7.1).
            if new.as_bool() == Some(true) {
                self.inner.borrow_mut().events.push(HostEvent::Open { id: id.to_string(), doc_ref, name, bytes: None });
                self.wake();
            }
            return;
        }
        // An ArrayBuffer (never a SharedArrayBuffer or a typed view), 1 byte up to the limit.
        if !bytes.is_instance_of::<js_sys::ArrayBuffer>() {
            return;
        }
        let length = f64::from(bytes.unchecked_ref::<js_sys::ArrayBuffer>().byte_length());
        if length < 1.0 {
            return;
        }
        if length > self.inner.borrow().max_document {
            self.ack(id, false, Some("too_large"));
            return;
        }
        let bytes = js_sys::Uint8Array::new(&bytes).to_vec();
        self.inner.borrow_mut().events.push(HostEvent::Open { id: id.to_string(), doc_ref, name, bytes: Some(bytes) });
        self.wake();
    }

    fn on_request_save(&self, id: &str, p: &JsValue) {
        if !only_keys(p, &["reason", "docRef"]) || !get(p, "reason").as_string().is_some_and(|r| SAVE_REASONS.contains(&r.as_str())) {
            return;
        }
        let doc_ref = get(p, "docRef");
        let doc_ref = if doc_ref.is_undefined() {
            None
        } else {
            match doc_ref.as_string().filter(|r| is_ulid(r)) {
                Some(r) => Some(r),
                None => return,
            }
        };
        self.inner.borrow_mut().events.push(HostEvent::RequestSave { id: id.to_string(), doc_ref });
        self.wake();
    }

    fn on_saved(&self, re: Option<&str>, p: &JsValue) {
        let Some(re) = re else { return };
        let ok = get(p, "ok").as_bool();
        let version = get(p, "version");
        let doc_ref = get(p, "docRef");
        let error = get(p, "error");
        let well_formed = match ok {
            Some(true) => version.as_f64().is_some_and(|v| v >= 1.0 && v.fract() == 0.0) && error.is_undefined(),
            Some(false) => error.as_string().is_some_and(|e| ACK_CODES.contains(&e.as_str())) && version.is_undefined() && doc_ref.is_undefined(),
            None => false,
        };
        let doc_ref_ok = doc_ref.is_undefined() || doc_ref.as_string().is_some_and(|r| is_ulid(&r));
        if !well_formed || !doc_ref_ok || !only_keys(p, &["ok", "version", "docRef", "error"]) {
            return;
        }
        // Without `doc.saved-ack` the engine keeps upstream's behaviour: a document handed over
        // counts as saved, and the host shows its own save state (§6.3).
        self.inner.borrow_mut().pending_saves.retain(|s| s != re);
    }

    fn on_lang(&self, id: &str, p: &JsValue) {
        if !only_keys(p, &["lang", "engineLang"]) || !get(p, "lang").as_string().is_some_and(|l| LANGS.contains(&l.as_str())) {
            return;
        }
        let Some(tag) = engine_lang(&get(p, "engineLang")) else { return };
        self.inner.borrow_mut().events.push(HostEvent::Lang { id: Some(id.to_string()), tag });
        self.wake();
    }

    fn on_theme(&self, id: &str, p: &JsValue) {
        if !only_keys(p, &["theme", "accent"]) || !accent(&get(p, "accent")) {
            return;
        }
        let Some(dark) = theme(&get(p, "theme")) else { return };
        self.inner.borrow_mut().events.push(HostEvent::Theme { id: Some(id.to_string()), dark });
        self.wake();
    }

    /// §7.7: writes stop first, then everything this engine keeps goes, and only then the answer.
    /// `current` and `all` purge the same: hosted, the engine keeps no namespace of its own.
    fn on_purge(&self, id: &str, p: &JsValue) {
        if !only_keys(p, &["scope"]) || !get(p, "scope").as_string().is_some_and(|s| s == "current" || s == "all") {
            return;
        }
        // Single-threaded: no Data Recovery write runs while this does, and the store refuses
        // every write from now on.
        let copies = self.store.purge();
        let left = crate::web::purge_browser_storage();
        self.inner.borrow_mut().events.push(HostEvent::Purged);
        match left {
            Ok(n) => {
                log::info!("vectorcraft-web: Evora purge: {copies} copies in memory and {n} browser entries removed");
                self.ack(id, true, None);
            }
            Err(e) => {
                log::error!("vectorcraft-web: Evora purge incomplete: {e}");
                self.ack(id, false, Some("forbidden"));
            }
        }
        self.wake();
    }

    /// `evora:open`, in a frame: the document (`bytes`, else a blank one) opens as a new tab and
    /// becomes the hosted one.
    fn open(&self, app: &mut VectorcraftApp, id: &str, doc_ref: String, name: &str, bytes: Option<&[u8]>) {
        // One document at a time (no `doc.multi`): the same `docRef` again reloads it, local
        // changes dropped (HOST-PROTOCOL §6.2, the host asked first); another one is refused.
        let previous = self.inner.borrow().hosted.as_ref().map(|h| (h.uid, h.doc_ref.clone()));
        let previous = previous.filter(|(uid, _)| app.session.documents().iter().any(|d| d.uid == *uid));
        if previous.as_ref().is_some_and(|(_, r)| *r != doc_ref) {
            self.ack(id, false, Some("busy"));
            return;
        }
        let before: Vec<u64> = app.session.documents().iter().map(|d| d.uid).collect();
        let made = match bytes {
            // A document only: never a plug-in, presets or a library (`io::open_bytes` would
            // install or import those).
            Some(bytes) => vectorcraft_ui_egui::io::open_document(app, name, bytes, None, &Default::default()).map_err(|e| (e, "invalid_content")),
            // File › New with the app's default settings (what New Document starts from).
            None => app.run("file.new", "{}".parse().unwrap_or_default()).map_err(|e| (e, "unsupported")),
        };
        if let Err((e, code)) = made {
            log::warn!("vectorcraft-web: the document from Evora didn't open: {e}");
            self.ack(id, false, Some(code));
            return;
        }
        let Some(st) = app.session.active_mut().filter(|st| !before.contains(&st.uid)) else {
            self.ack(id, false, Some("invalid_content"));
            return;
        };
        // Its saves go to the host as native documents under the host's name: File › Save writes
        // it as itself, without asking where.
        let native = native_name(name);
        st.path = Some(native.clone());
        st.format = NATIVE_FORMAT;
        st.save_options = Default::default();
        st.converted = false;
        st.recovered = false;
        let uid = st.uid;
        if let Some((old, _)) = previous {
            if let Some(i) = app.session.documents().iter().position(|d| d.uid == old) {
                app.session.close_document(i);
            }
            if let Some(i) = app.session.documents().iter().position(|d| d.uid == uid) {
                app.session.set_active(i);
            }
        }
        {
            let mut inner = self.inner.borrow_mut();
            inner.hosted = Some(Hosted { uid, doc_ref, name: native });
            inner.last_dirty = None;
        }
        self.ack(id, true, None);
    }

    /// `evora:request-save`, in a frame: the hosted document's native file as `evora:save`, or
    /// `evora:ack` with `clean` when there is nothing to save.
    fn request_save(&self, app: &mut VectorcraftApp, id: &str, doc_ref: Option<&str>) {
        let hosted = self.inner.borrow().hosted.as_ref().map(|h| (h.uid, h.doc_ref.clone(), h.name.clone()));
        let Some((uid, hosted_ref, name)) = hosted.filter(|(uid, ..)| app.session.documents().iter().any(|d| d.uid == *uid)) else {
            match doc_ref {
                Some(_) => self.ack(id, false, Some("not_found")),
                None => self.ack(id, true, Some("clean")),
            }
            return;
        };
        if doc_ref.is_some_and(|r| r != hosted_ref) {
            self.ack(id, false, Some("not_found"));
            return;
        }
        if !app.session.documents().iter().any(|d| d.uid == uid && d.is_dirty()) {
            self.ack(id, true, Some("clean"));
            return;
        }
        let (bytes, job) = match encode_hosted(app, uid) {
            Ok(done) => done,
            Err(e) => {
                log::error!("vectorcraft-web: couldn't encode the document for Evora: {e}");
                self.ack(id, false, Some("invalid_content"));
                return;
            }
        };
        if bytes.len() as f64 > self.inner.borrow().max_document {
            self.ack(id, false, Some("too_large"));
            return;
        }
        if self.post_save(&hosted_ref, &name, &bytes, Some(id)) {
            // Handed over: saved, as a download is upstream (no `doc.saved-ack`, §6.3).
            job.complete(&mut app.session, uid);
        }
    }
}

/// The hosted document `uid` encoded as Save writes it (its native file, under the host's name)
/// and the job that records it as saved ([`fileio::SaveJob::complete`]).
fn encode_hosted(app: &mut VectorcraftApp, uid: u64) -> Result<(Vec<u8>, fileio::SaveJob), String> {
    let index = app.session.documents().iter().position(|d| d.uid == uid).ok_or("the document is closed")?;
    // The engine saves the active document.
    let back = app.session.active_index().filter(|&a| a != index);
    if back.is_some() {
        app.session.set_active(index);
    } else {
        vectorcraft_ui_egui::io::remember_view(app);
    }
    let r = encode_active(app);
    if let Some(b) = back {
        app.session.set_active(b);
    }
    r
}

fn encode_active(app: &mut VectorcraftApp) -> Result<(Vec<u8>, fileio::SaveJob), String> {
    let plan = fileio::save_plan(&app.session, SaveMode::Save, &Default::default()).map_err(|e| e.to_string())?;
    if plan.format.id != NATIVE_FORMAT || plan.path.is_none() {
        return Err("the document doesn't save as a native file".into());
    }
    let job = fileio::save_job(&mut app.session, plan).map_err(|e| e.to_string())?;
    let mut first: Option<Vec<u8>> = None;
    job.write(|_, b| {
        if first.is_none() {
            first = Some(b.to_vec());
        }
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    let bytes = first.filter(|b| !b.is_empty()).ok_or("the save wrote nothing")?;
    Ok((bytes, job))
}

/// The interface language for an engine language tag, by E3's correspondence (any case or form;
/// a language the UI hasn't, or none, gives English). The page's `lang` follows once the UI draws
/// in it ([`Bridge::note_lang`]).
fn set_language(app: &mut VectorcraftApp, tag: Option<&str>) {
    let lang = tag.and_then(i18n::lang_from_tag).unwrap_or(i18n::Lang::EN);
    app.session.prefs.interface_language = lang.code().to_string();
}

/// `name` with the native extension (the host's name, else its stem and `.vectorcraft`), at most
/// 255 characters.
fn native_name(name: &str) -> String {
    let ext = format!(".{NATIVE_FORMAT}");
    if name.to_ascii_lowercase().ends_with(&ext) {
        return name.to_string();
    }
    let stem = fileio::file_stem(name);
    let stem: String = if stem.trim().is_empty() { "document".to_string() } else { stem };
    let keep = 255 - ext.chars().count();
    format!("{}{ext}", stem.chars().take(keep).collect::<String>())
}

/// The parent window and its origin, when the page is framed by an origin `evora-host.json`
/// admits. The browser's own record of the parent (`location.ancestorOrigins`) decides when it
/// exists; otherwise the referrer may only pick among the admitted origins, or the single one.
async fn admitted_parent() -> Option<(web_sys::Window, Peer)> {
    let window = web_sys::window()?;
    let parent = window.parent().ok().flatten()?;
    if js_sys::Object::is(&parent, &window) {
        return None;
    }
    let admitted = read_config(&window).await?;
    // `location.ancestorOrigins` (a DOMStringList; absent from web-sys and from some browsers).
    let location: JsValue = window.location().into();
    let ancestors = get(&location, "ancestorOrigins");
    let first_ancestor = (get(&ancestors, "length").as_f64().unwrap_or(0.0) >= 1.0)
        .then(|| js_sys::Reflect::get_u32(&ancestors, 0).ok().and_then(|o| o.as_string()))
        .flatten();
    let origin = match first_ancestor {
        Some(parent_origin) => Some(parent_origin).filter(|o| admitted.contains(o))?,
        None => {
            let referrer = window.document().map(|d| d.referrer()).unwrap_or_default();
            let from_referrer = web_sys::Url::new(&referrer).ok().map(|u| u.origin()).filter(|o| admitted.contains(o));
            match (from_referrer, admitted.as_slice()) {
                (Some(o), _) => o,
                (None, [only]) => only.clone(),
                _ => return None,
            }
        }
    };
    Some((window, Peer { parent, origin }))
}

/// `evora-host.json`: `{ "parentOrigins": ["https://…", …] }`, each a bare web origin.
async fn read_config(window: &web_sys::Window) -> Option<Vec<String>> {
    let response = wasm_bindgen_futures::JsFuture::from(window.fetch_with_str(CONFIG)).await.ok()?;
    let response: web_sys::Response = response.dyn_into().ok()?;
    if !response.ok() {
        return None;
    }
    let text = wasm_bindgen_futures::JsFuture::from(response.text().ok()?).await.ok()?.as_string()?;
    let config = js_sys::JSON::parse(&text).ok()?;
    let list = get(&config, "parentOrigins");
    if !js_sys::Array::is_array(&list) {
        return None;
    }
    let origins: Vec<String> = js_sys::Array::from(&list).iter().filter_map(|o| o.as_string()).filter(|o| is_origin(o)).collect();
    (!origins.is_empty()).then_some(origins)
}

/// `http(s)://host[:port]`, nothing after.
fn is_origin(o: &str) -> bool {
    let rest = o.strip_prefix("https://").or_else(|| o.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty() && !r.contains(['/', '?', '#', '@', ' ', '\\']))
}

fn envelope(kind: &str, re: Option<&str>, payload: &js_sys::Object) -> Option<(js_sys::Object, String)> {
    let id = ulid();
    let mut fields: Vec<(&str, JsValue)> = vec![("v", 1.0.into()), ("type", kind.into()), ("id", id.clone().into())];
    if let Some(re) = re {
        fields.push(("re", re.into()));
    }
    fields.push(("payload", payload.clone().into()));
    Some((object(&fields)?, id))
}

fn object(fields: &[(&str, JsValue)]) -> Option<js_sys::Object> {
    let m = js_sys::Object::new();
    for (key, value) in fields {
        js_sys::Reflect::set(&m, &JsValue::from_str(key), value).ok()?;
    }
    Some(m)
}

fn get(data: &JsValue, key: &str) -> JsValue {
    if !data.is_object() {
        return JsValue::UNDEFINED;
    }
    js_sys::Reflect::get(data, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
}

/// A plain object: not null, not an array, prototype `Object.prototype` (§5.2 step 2).
fn plain_object(v: &JsValue) -> bool {
    if !v.is_object() || js_sys::Array::is_array(v) {
        return false;
    }
    let plain = js_sys::Object::get_prototype_of(&js_sys::Object::new().into());
    js_sys::Object::is(&js_sys::Object::get_prototype_of(v), &plain)
}

/// No property outside `allowed` (`additionalProperties: false`).
fn only_keys(v: &JsValue, allowed: &[&str]) -> bool {
    if !v.is_object() {
        return false;
    }
    js_sys::Object::keys(v.unchecked_ref::<js_sys::Object>()).iter().all(|k| k.as_string().is_some_and(|k| allowed.contains(&k.as_str())))
}

fn string_list(v: &JsValue) -> Option<Vec<String>> {
    if !js_sys::Array::is_array(v) {
        return None;
    }
    let list: Vec<String> = js_sys::Array::from(v).iter().map(|x| x.as_string()).collect::<Option<Vec<_>>>()?;
    let mut unique = list.clone();
    unique.sort();
    unique.dedup();
    (unique.len() == list.len()).then_some(list)
}

/// `engineLang` of §4.2: `null` (English, the host shows its banner) or a language tag →
/// `Some(tag)`; anything else → `None`.
fn engine_lang(v: &JsValue) -> Option<Option<String>> {
    if v.is_null() {
        return Some(None);
    }
    v.as_string().filter(|l| is_lang_tag(l)).map(Some)
}

/// `theme` of §4.2 → dark?
fn theme(v: &JsValue) -> Option<bool> {
    match v.as_string().as_deref() {
        Some("dark") => Some(true),
        Some("light") => Some(false),
        _ => None,
    }
}

/// `accent` of §4.2: `#rrggbb`.
fn accent(v: &JsValue) -> bool {
    v.as_string().is_some_and(|a| a.len() == 7 && a.starts_with('#') && a.chars().skip(1).all(|c| c.is_ascii_hexdigit()))
}

/// `prefs` of `evora:init`: a plain object of strings, numbers and booleans (none is read here).
fn prefs(v: &JsValue) -> bool {
    plain_object(v)
        && js_sys::Object::values(v.unchecked_ref::<js_sys::Object>()).iter().all(|x| x.as_string().is_some() || x.as_f64().is_some() || x.as_bool().is_some())
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn is_ulid(s: &str) -> bool {
    s.len() == 26 && s.bytes().all(|b| CROCKFORD.contains(&b))
}

/// A fresh ULID: 48 bits of milliseconds, then 80 random bits (§3: unique per sender).
fn ulid() -> String {
    let mut time = js_sys::Date::now() as u64;
    let mut out = [b'0'; 26];
    for slot in out.iter_mut().take(10).rev() {
        *slot = CROCKFORD[(time % 32) as usize];
        time /= 32;
    }
    for slot in out.iter_mut().skip(10) {
        *slot = CROCKFORD[((js_sys::Math::random() * 32.0) as usize) % 32];
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `name` of §4.2: 1 to 255 characters, no `/`, `\` or control character.
fn is_name(n: &str) -> bool {
    (1..=255).contains(&n.chars().count()) && !n.chars().any(|c| c == '/' || c == '\\' || c.is_control())
}

/// `engineLang` of §4.2: `^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$`.
fn is_lang_tag(tag: &str) -> bool {
    let mut parts = tag.split(['-', '_']);
    let first_ok = parts.next().is_some_and(|p| (2..=3).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphabetic()));
    first_ok && parts.all(|p| (2..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric()))
}
