/*
 * No exports. Native boundary for independent daemon host supervision (outside mode) and per-daemon job holding (inside mode).
 */
#![cfg_attr(windows, windows_subsystem = "windows")]

mod daemon_job_hold;
mod host_supervisor;

fn main() {
    // Supervisor paths may be non-UTF-8, so only the mode word is compared as text.
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let result = match args.as_slice() {
        [mode, pid] if mode == "job-hold" => daemon_job_hold::run(&pid.to_string_lossy()),
        _ => host_supervisor::run(),
    };
    if let Err(error) = result {
        eprintln!("Workbench daemon host failed: {error}");
        std::process::exit(1);
    }
}
