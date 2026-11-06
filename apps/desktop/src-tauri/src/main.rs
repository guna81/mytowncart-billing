// SPDX-License-Identifier: Apache-2.0
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mytowncart_billing_lib::run(std::env::var("MTC_DRIVER_SCRIPT").ok());
}
