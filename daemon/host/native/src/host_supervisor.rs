/*
 * Exports:
 * - run: supervise one acknowledged host crash unit independently of the app.
 */
use std::{
    env,
    io::{self, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use workbench_native::{
    rotating_log_writer::RotatingLogWriter,
    windows_child_job::WindowsChildJob,
};

pub fn run() -> io::Result<()> {
    if !cfg!(windows) {
        return Err(io::Error::other("Linux host supervision belongs to systemd."));
    }
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    let foreground = args.len() == 4 && args[3] == "--foreground";
    if args.len() != 3 && !foreground {
        return Err(io::Error::other("Expected checkout, Node executable and data root paths."));
    }
    let root = PathBuf::from(&args[0]);
    let node = PathBuf::from(&args[1]);
    let data_root = PathBuf::from(&args[2]);
    if !root.is_absolute() || !node.is_absolute() || !data_root.is_absolute() {
        return Err(io::Error::other("Host paths must be absolute."));
    }
    let session = format!("{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).map_err(io::Error::other)?.as_nanos());
    let logs = Arc::new(Mutex::new(RotatingLogWriter::new(
        root.join(".workbench/logs"), "workbench-host", 1_000, 5,
    )?));
    let (send, receive) = mpsc::channel();
    if foreground {
        let owner_events = send.clone();
        thread::spawn(move || {
            let mut input = io::stdin().lock();
            let mut bytes = [0u8; 64];
            while let Ok(count) = input.read(&mut bytes) {
                if count == 0 { break; }
            }
            // Losing this pipe means the foreground owner has gone, not a daemon crash.
            let _ = owner_events.send(Event::OwnerClosed);
        });
    }
    let mut owner_closed = false;
    loop {
        let mut command = Command::new(&node);
        command.arg(root.join("daemon/host/launch-node.mjs"))
            .current_dir(&root)
            .env("WORKBENCH_SERVICE_SESSION", &session)
            .env("WORKBENCH_DATA_ROOT", &data_root)
            .env("WORKBENCH_SERVICE_ACK_REQUIRED", "1")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn()?;
        let job = match WindowsChildJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                child.kill()?;
                child.wait()?;
                return Err(error);
            }
        };
        let acknowledgement = child.stdin.take()
            .ok_or_else(|| io::Error::other("Host bootstrap input is missing."))
            .and_then(|mut input| input.write_all(b"workbench-host-owned\n"));
        if let Err(error) = acknowledgement {
            job.terminate()?;
            child.wait()?;
            return Err(error);
        }
        let child_pid = child.id();
        let stdout = child.stdout.take().ok_or_else(|| io::Error::other("Host stdout is missing."))?;
        let stderr = child.stderr.take().ok_or_else(|| io::Error::other("Host stderr is missing."))?;
        let readers = [
            read_output(stdout, true, foreground, logs.clone(), send.clone()),
            read_output(stderr, false, foreground, logs.clone(), send.clone()),
        ];
        let exit_send = send.clone();
        let waiter = thread::spawn(move || {
            // Receiver disappearance means this supervisor is already terminating.
            let _ = exit_send.send(Event::Exit(child.wait()));
        });
        let mut ready = false;
        let mut exited = None;
        let mut closed = 0;
        let mut failure = None;
        while closed < 2 || exited.is_none() {
            match receive.recv().map_err(io::Error::other)? {
                Event::Ready => {
                    ready = true;
                    if foreground {
                        writeln!(io::stdout(), "\u{001e}WORKBENCH_HOST_V1 {{\"pid\":{child_pid}}}")?;
                    }
                },
                Event::OwnerClosed => {
                    owner_closed = true;
                    job.terminate()?;
                },
                Event::Output(result) => {
                    closed += 1;
                    if let Err(error) = result {
                        failure = Some(error);
                        job.terminate()?;
                    }
                }
                Event::Exit(result) => {
                    // Retire descendants before reading drained pipes or replacing the unit.
                    job.terminate()?;
                    exited = Some(result);
                }
            }
        }
        waiter.join().map_err(|_| io::Error::other("Host wait thread panicked."))?;
        for reader in readers {
            reader.join().map_err(|_| io::Error::other("Host log thread panicked."))?;
        }
        drop(job);
        if let Some(error) = failure { return Err(error); }
        let status = exited.ok_or_else(|| io::Error::other("Host exit was not observed."))??;
        if owner_closed { return Ok(()); }
        if !should_restart(ready, status.code()) {
            if status.success() { return Ok(()); }
            return Err(io::Error::other(format!("Host stopped with {status}.")));
        }
        logs.lock().map_err(|_| io::Error::other("Host log lock was poisoned."))?
            .write_launcher_line("Host crash unit retired; restarting the same service session.")?;
    }
}

fn should_restart(ready: bool, code: Option<i32>) -> bool {
    ready && code != Some(0) && code != Some(78)
}

enum Event {
    Ready,
    OwnerClosed,
    Output(io::Result<()>),
    Exit(io::Result<std::process::ExitStatus>),
}

fn read_output(
    mut stream: impl Read + Send + 'static,
    stdout: bool,
    foreground: bool,
    logs: Arc<Mutex<RotatingLogWriter>>,
    events: mpsc::Sender<Event>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let result = (|| -> io::Result<()> {
            let mut buffer = [0u8; 4096];
            let mut line = Vec::new();
            loop {
                let count = stream.read(&mut buffer)?;
                if count == 0 { break; }
                for byte in &buffer[..count] {
                    if *byte == b'\n' || line.len() == 8192 {
                        let text = String::from_utf8_lossy(&line);
                        if stdout && text == "workbench-host-ready" {
                            events.send(Event::Ready).map_err(io::Error::other)?;
                        } else {
                            logs.lock().map_err(|_| io::Error::other("Host log lock was poisoned."))?
                                .write_child_line(&text)?;
                            if foreground { writeln!(io::stdout(), "{text}")?; }
                        }
                        line.clear();
                    }
                    if *byte != b'\n' { line.push(*byte); }
                }
            }
            if !line.is_empty() {
                logs.lock().map_err(|_| io::Error::other("Host log lock was poisoned."))?
                    .write_child_line(&String::from_utf8_lossy(&line))?;
                if foreground { writeln!(io::stdout(), "{}", String::from_utf8_lossy(&line))?; }
            }
            Ok(())
        })();
        // If the receiver has gone, its crash unit is already being retired.
        let _ = events.send(Event::Output(result));
    })
}

#[cfg(test)]
mod tests {
    use super::should_restart;

    #[test]
    fn cold_failures_and_clean_stops_do_not_restart() {
        assert!(!should_restart(false, Some(1)));
        assert!(!should_restart(false, None));
        assert!(!should_restart(true, Some(0)));
        assert!(!should_restart(true, Some(78)));
    }

    #[test]
    fn requested_restart_and_ready_crash_recover_the_same_session() {
        assert!(should_restart(true, Some(75)));
        assert!(should_restart(true, Some(1)));
        assert!(should_restart(true, None));
        assert!(!should_restart(false, Some(75)));
    }
}
