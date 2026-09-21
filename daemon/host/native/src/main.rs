/*
 * No exports. Native boundary for independent daemon host supervision.
 */
#![cfg_attr(windows, windows_subsystem = "windows")]

mod host_supervisor;

fn main() {
    if let Err(error) = host_supervisor::run() {
        eprintln!("Workbench daemon host failed: {error}");
        std::process::exit(1);
    }
}
