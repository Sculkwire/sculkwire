#!/bin/sh
# The agent's host tests: its pure modules build on their own as host test crates (the agent itself is `no_std` and
# builds only for the game's target, so `cargo test` finds nothing). Run from native/: `sh host-tests.sh`.
# A new pure module with unit tests is added to MODULES here; CI and the docs call this script.
set -eu

MODULES="look screens registries click"

mkdir -p target
for m in $MODULES; do
  rustc --edition 2021 --test "agent/src/$m.rs" -o "target/$m-test.exe"
  "./target/$m-test.exe"
done
