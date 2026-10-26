/*
 * Exports:
 * - run: run one command in a job of its own, exiting with its status; closing stdin ends the command's whole tree.
 */
use std::{
    ffi::OsString,
    io::{self, Read},
    process::{Command, Stdio},
    thread,
};
use workbench_native::windows_child_job::WindowsChildJob;

/// Descendants that outlive their parent stay in the job, so a stop still ends them. A command that finishes on its
/// own leaves anything it deliberately started running, as it would without the job.
pub fn run(command: &[OsString]) -> io::Result<()> {
    let [program, arguments @ ..] = command else {
        return Err(io::Error::other("Expected a command to run."));
    };
    let job = WindowsChildJob::enter_current()?;
    let mut process = Command::new(program);
    process.args(arguments).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = process.spawn()?;
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut bytes = [0u8; 64];
        // Any read failure also means the owner is gone; either way the command's tree must end.
        while matches!(input.read(&mut bytes), Ok(count) if count > 0) {}
        let _ = job.terminate();
    });
    let status = child.wait()?;
    std::process::exit(status.code().unwrap_or(1));
}
