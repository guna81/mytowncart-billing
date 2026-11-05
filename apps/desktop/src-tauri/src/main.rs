// SPDX-License-Identifier: Apache-2.0
// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mytowncart_billing_lib::run()
}
