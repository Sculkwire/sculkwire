//! The screenshot request: the client's own `button.screenshot` handler.
//!
//! Every screenshot the game takes for a key or a button goes through the client: F2 is the
//! `button.screenshot` handler, a capture-less lambda that forwards the client instance to its own
//! screenshot method, and the pause menu's camera button reaches the same request through its screen
//! model. The agent presses that handler the way the key does ([`crate::input::screenshot_click`]):
//! no manager object to learn from an earlier call, no request struct to build by hand.
//!
//! The game names the file itself and writes it into its gallery
//! (`<appData>/screenshots/<world>/photos/<id>/`), so the answer carries `named: false` and the caller
//! picks up the newest picture written after the request instead of a file under the requested name.

use agent_core::RpcError;

use crate::input;

/// Asks the game for a screenshot. Answers the anchor that is still missing.
pub fn request() -> Result<(), RpcError> {
    input::screenshot_click()
}
