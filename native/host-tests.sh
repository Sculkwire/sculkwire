#!/bin/sh
# The agent's host tests: its pure modules build on their own as host test crates (the agent itself is `no_std` and
# builds only for the game's target, so `cargo test` finds nothing). Run from native/: `sh host-tests.sh`.
# A new pure module with unit tests is added to MODULES here (a path under native/ without `.rs`); CI and the docs
# call this script.
set -eu

MODULES="agent/src/look agent/src/screens agent/src/registries agent/src/click agent/src/logring agent-core/src/lockbits"

mkdir -p target
for m in $MODULES; do
  name=$(basename "$m")
  rustc --edition 2021 --test "$m.rs" -o "target/$name-test.exe"
  "./target/$name-test.exe"
done
