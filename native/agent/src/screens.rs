//! Which screens the agent's UI input may touch: the store rule and the OreUI route allow-list.
//!
//! Plain `core` code over names and routes (no game memory), so it also builds on its own as a host
//! test crate: `rustc --edition 2021 --test agent/src/screens.rs -o target/screens-test.exe &&
//! ./target/screens-test.exe` (from `native/`).

/// Screens whose controls the agent never touches. The game names a screen `<package>.<scene>`, so the
/// package decides it: `store_layout.…`, `store_inventory.…`, `csb.…`, `marketplace.…` and the store's
/// auxiliaries all match here, including scenes this build does not know about yet.
const STORE_PACKAGES: &[&str] = &[
    "store",
    "csb",
    "marketplace",
    "minecoins",
    "dressing",
    "portfolio",
    "token_faq",
    "ugc_viewer",
    "persona_emote",
    "day_one_experience",
    "win10_trial_conversion",
    "tabbed_upsell",
    "bundle_purchase_warning",
    "skin_selector",
    "character_creator",
];

/// True for a store, Marketplace, Minecoins, Dressing Room or profile/persona editor screen or OreUI route.
pub fn is_store_screen(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let package = lower.split('.').next().unwrap_or(lower.as_str());
    for prefix in STORE_PACKAGES {
        // `store` itself and every package in its family (`store_layout`, `store_inventory`, …), so a
        // store scene this build does not know about yet is refused without a code change.
        if let Some(rest) = package.strip_prefix(prefix) {
            if rest.is_empty() || rest.starts_with('_') {
                return true;
            }
        }
    }
    // Anywhere in a scene name or a route (`/marketplace/store`, `dressingRoomCoinScreen`,
    // `/oreui-marketplace/…`, a purchase dialog): a false match only refuses input on a harmless screen.
    STORE_WORDS.iter().any(|word| lower.contains(word))
}

/// Words that make any scene name or OreUI route a store screen, matched case-insensitively anywhere.
const STORE_WORDS: &[&str] = &[
    "marketplace",
    "minecoins",
    "coin",
    "store",
    "purchase",
    "dressing",
    "persona",
    "profile_editor",
    "profileeditor",
    "skin_selector",
    "character_creator",
    "upsell",
];

/// OreUI routes where a click, `Return` or `Space` is allowed: the Play screen (world list, create and edit
/// a world), the settings pages, and the idle overlay. A route matches as a whole path segment, so `/play`
/// allows `/play/worlds` but not `/player-permissions`.
///
/// In a world, Settings (from the pause menu) is `/oreui-settings/<page>` (read live on 1.26.63.1). Only
/// the option pages are listed; Multiplayer (world broadcast), Party, Account and Global Resources are
/// not, so a click there is refused like any page off the list.
///
/// `/idle-route` is the "You've been away for a bit. Press any button to jump back into the game"
/// overlay the game puts over a world after a while without input (route read live on 1.26.63.1). It
/// has no controls; `Escape` only opens the pause menu over it.
pub const OREUI_ROUTES: &[&str] = &[
    "/play",
    "/settings",
    "/create-new-world",
    "/edit-world",
    "/oreui-settings/accessibility",
    "/oreui-settings/game",
    "/oreui-settings/keyboard-and-mouse",
    "/oreui-settings/controller",
    "/oreui-settings/touch",
    "/oreui-settings/general",
    "/oreui-settings/video",
    "/oreui-settings/audio",
    "/oreui-settings/creator",
    "/idle-route",
];

pub fn oreui_route_allowed(route: &str) -> bool {
    let lower = route.to_ascii_lowercase();
    OREUI_ROUTES.iter().any(|allowed| {
        lower
            .strip_prefix(allowed)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('#'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_idle_overlay_takes_a_click_return_or_space() {
        assert!(oreui_route_allowed("/idle-route"));
        assert!(oreui_route_allowed("/IDLE-ROUTE"));
        assert!(!oreui_route_allowed("/idle-routes"));
        assert!(!is_store_screen("/idle-route"));
    }

    #[test]
    fn listed_routes_match_as_whole_path_segments() {
        assert!(oreui_route_allowed("/play"));
        assert!(oreui_route_allowed("/play/worlds"));
        assert!(oreui_route_allowed("/play?tab=worlds"));
        assert!(oreui_route_allowed("/oreui-settings/video"));
        assert!(!oreui_route_allowed("/player-permissions"));
        assert!(!oreui_route_allowed("/oreui-settings/account"));
        assert!(!oreui_route_allowed("/oreui-settings/multiplayer"));
        assert!(!oreui_route_allowed("/"));
        assert!(!oreui_route_allowed(""));
    }

    #[test]
    fn store_pages_are_never_on_the_list_and_always_refused() {
        for route in ["/marketplace/store", "/oreui-marketplace/home", "/dressing-room", "/persona/editor", "/minecoins"] {
            assert!(!oreui_route_allowed(route), "{route}");
            assert!(is_store_screen(route), "{route}");
        }
    }

    #[test]
    fn store_scenes_are_refused_by_package_and_by_word() {
        assert!(is_store_screen("store_layout.store_data_driven_screen"));
        assert!(is_store_screen("csb.csb_screen"));
        assert!(is_store_screen("dressingRoomCoinScreen"));
        assert!(!is_store_screen("hud_screen"));
        assert!(!is_store_screen("pause.pause_screen"));
        assert!(!is_store_screen("chest.small_chest_screen"));
    }
}
