//! Help → project links (this app's GitHub repository). The commands return the URL; the frontend
//! opens it.
//!
//! Evora (EVORA-SIN-03, patch E1): the ArtCraft community and website links (`help.discord`,
//! `help.website`, `help.appPage`) are removed. A modified version must not carry the ArtCraft
//! marks (docs/brand/LICENSE-brand.txt), and these commands compiled them into every build.

use serde_json::{Value, json};

use super::*;

/// The app's id on GitHub.
pub const APP_ID: &str = "vectorcraft";

/// This app's source repository.
pub fn github_url() -> String {
    format!("https://github.com/storytold/{APP_ID}")
}

pub fn specs() -> Vec<CommandSpec> {
    vec![
        cmd!(query "help.github", "VectorCraft on GitHub", ["Help"], None, "{} → {url} source code, issues and releases", always, |_, _| url(github_url())),
        cmd!(query "help.links", "Links", [], None, "{} → {github}", always, |_, _| {
            Ok(json!({ "github": github_url() }))
        }),
    ]
}

fn url(u: String) -> Result<Value> {
    Ok(json!({ "url": u }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        let mut s = Session::new();
        assert_eq!(s.execute("help.github", &json!({})).unwrap()["url"], "https://github.com/storytold/vectorcraft");
        assert_eq!(s.execute("help.links", &json!({})).unwrap()["github"], "https://github.com/storytold/vectorcraft");
        // Evora (E1): the ArtCraft links are gone.
        for id in ["help.discord", "help.website", "help.appPage"] {
            assert!(s.execute(id, &json!({})).is_err(), "{id} is still registered");
        }
    }
}
