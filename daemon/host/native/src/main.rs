/*
 * No exports. Native boundary for independent daemon host supervision (outside mode), per-daemon job holding (inside
 * mode) and per-command jobs for the daemon's outside-sandbox commands.
 */
#![cfg_attr(windows, windows_subsystem = "windows")]

mod command_job_run;
mod daemon_job_hold;
mod host_supervisor;

fn main() {
    // Supervisor paths may be non-UTF-8, so only the mode word is compared as text.
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let result = match args.as_slice() {
        [mode, pid] if mode == "job-hold" => daemon_job_hold::run(&pid.to_string_lossy()),
        [mode, command @ ..] if mode == "job-run" => command_job_run::run(command),
        _ => host_supervisor::run(),
    };
    if let Err(error) = result {
        eprintln!("Workbench daemon host failed: {error}");
        std::process::exit(1);
    }
}
