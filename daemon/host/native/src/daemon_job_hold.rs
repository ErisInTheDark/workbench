/*
 * Exports:
 * - run: hold a kill-on-close job around one waiting daemon until the host closes stdin.
 */
use std::io::{self, Read, Write};
use workbench_native::windows_child_job::WindowsChildJob;

/// Inside mode: the host disposes the daemon's whole tree by closing this process's stdin (or ending it).
pub fn run(pid: &str) -> io::Result<()> {
    let pid = pid.parse::<u32>().map_err(|_| io::Error::other("Expected a daemon process id."))?;
    let job = WindowsChildJob::attach_pid(pid)?;
    let mut output = io::stdout().lock();
    writeln!(output, "owned")?;
    output.flush()?;
    let mut input = io::stdin().lock();
    let mut bytes = [0u8; 64];
    // Any read failure also means the host is gone; either way the daemon tree must end.
    while matches!(input.read(&mut bytes), Ok(count) if count > 0) {}
    job.terminate()
}
