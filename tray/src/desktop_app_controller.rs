/*
 * Exports:
 * - DesktopAppController: own the hidden Node app child, readiness, browser opening, logging, and Quit lifecycle.
 */
use crate::{rotating_log_writer::RotatingLogWriter, windows_child_job::WindowsChildJob};
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const RECORD_PREFIX: &str = "\u{001e}WORKBENCH_DESKTOP_V1 ";
const QUIT_DEADLINE: Duration = Duration::from_secs(10);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);

fn quit_deadline_expired(deadline: Option<Instant>, now: Instant) -> bool {
    deadline.is_some_and(|deadline| now >= deadline)
}

enum ManagerCommand {
    Quit,
    Restart,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ShutdownIntent {
    Quit,
    Restart,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum AppOriginChange {
    Moved,
    Ready,
    Unchanged,
}

fn update_app_origin(current: &mut Option<String>, next: String) -> AppOriginChange {
    if current.as_ref() == Some(&next) {
        return AppOriginChange::Unchanged;
    }
    let change = if current.is_some() {
        AppOriginChange::Moved
    } else {
        AppOriginChange::Ready
    };
    *current = Some(next);
    change
}

fn should_open_browser(change: &AppOriginChange, requested: bool) -> bool {
    requested && *change == AppOriginChange::Ready
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum DesktopRecord {
    AlreadyRunning { version: u8 },
    Ready {
        #[serde(rename = "appOrigin")]
        app_origin: String,
        #[serde(rename = "openBrowser")]
        open_browser: bool,
        version: u8,
    },
    Restart { version: u8 },
}

pub struct DesktopAppController {
    app_origin: Mutex<Option<String>>,
    command_sender: Sender<ManagerCommand>,
    command_receiver: Mutex<Option<Receiver<ManagerCommand>>>,
    exit_allowed: AtomicBool,
    log: Arc<Mutex<RotatingLogWriter>>,
    repository_root_path: PathBuf,
    shutdown_started: AtomicBool,
    started: AtomicBool,
}

impl DesktopAppController {
    pub fn new(repository_root_path: PathBuf) -> Result<Self, String> {
        let log = RotatingLogWriter::new(
            repository_root_path.join(".workbench").join("logs"),
            "workbench-app",
            1_000,
            5,
        )
        .map_err(|error| format!("Unable to create Workbench app log: {error}"))?;
        let (command_sender, command_receiver) = mpsc::channel();
        Ok(Self {
            app_origin: Mutex::new(None),
            command_sender,
            command_receiver: Mutex::new(Some(command_receiver)),
            exit_allowed: AtomicBool::new(false),
            log: Arc::new(Mutex::new(log)),
            repository_root_path,
            shutdown_started: AtomicBool::new(false),
            started: AtomicBool::new(false),
        })
    }

    pub fn exit_allowed(&self) -> bool {
        self.exit_allowed.load(Ordering::SeqCst)
    }

    pub fn open_browser(&self, app: &AppHandle) {
        let Some(url) = self.launch_url() else {
            self.log_launcher("Workbench app URL is not ready to open.");
            return;
        };
        if let Err(error) = app.opener().open_url(url, None::<&str>) {
            self.log_launcher(&format!("Unable to open Workbench browser: {error}"));
        }
    }

    pub fn copy_url(&self) {
        let Some(url) = self.launch_url() else {
            self.log_launcher("Workbench app URL is not ready to copy.");
            return;
        };
        let result = arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(url));
        if let Err(error) = result {
            self.log_launcher(&format!("Unable to copy Workbench URL: {error}"));
        }
    }

    pub fn request_quit(&self) {
        self.request_shutdown(
            ManagerCommand::Quit,
            "Unable to deliver Quit to the Workbench app process manager.",
        );
    }

    fn request_restart(&self) {
        self.request_shutdown(
            ManagerCommand::Restart,
            "Unable to deliver Restart to the Workbench app process manager.",
        );
    }

    fn request_shutdown(&self, command: ManagerCommand, failure: &str) {
        if self.shutdown_started.swap(true, Ordering::SeqCst) {
            return;
        }
        if self.command_sender.send(command).is_err() {
            self.log_launcher(failure);
        }
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Err("Workbench desktop app controller has already started.".into());
        }
        let receiver = self
            .command_receiver
            .lock()
            .map_err(|_| "Workbench app command receiver lock failed.")?
            .take()
            .ok_or("Workbench app command receiver is unavailable.")?;
        let mut child = self.spawn_child().map_err(|error| {
            self.log_launcher(&error);
            error
        })?;
        let job = match WindowsChildJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let message =
                    format!("Unable to contain the Workbench app process tree: {error}");
                self.log_launcher(&message);
                let _ = child.kill();
                let _ = child.wait();
                return Err(message);
            }
        };
        let stdout = child
            .stdout
            .take()
            .ok_or("Workbench app stdout was not captured.")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Workbench app stderr was not captured.")?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Workbench app stdin was not captured.")?;

        self.log_launcher("Starting hidden Workbench Node app.");
        let stdout_controller = Arc::clone(self);
        let stdout_app = app.clone();
        let stdout_thread = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => stdout_controller.handle_stdout_line(&stdout_app, &line),
                    Err(error) => {
                        stdout_controller
                            .log_launcher(&format!("Workbench app stdout failed: {error}"));
                        break;
                    }
                }
            }
        });
        let stderr_log = Arc::clone(&self.log);
        let stderr_thread = thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(line) => write_child_log(&stderr_log, &line),
                    Err(error) => {
                        write_launcher_log(
                            &stderr_log,
                            &format!("Workbench app stderr failed: {error}"),
                        );
                        break;
                    }
                }
            }
        });

        let manager_controller = Arc::clone(self);
        thread::spawn(move || {
            manager_controller.run_process_manager(
                app,
                receiver,
                child,
                stdin,
                job,
                stdout_thread,
                stderr_thread,
            )
        });
        Ok(())
    }

    fn finish(&self, app: &AppHandle, exit_code: i32) {
        self.exit_allowed.store(true, Ordering::SeqCst);
        app.exit(exit_code);
    }

    fn handle_stdout_line(&self, app: &AppHandle, line: &str) {
        let Some(payload) = line.strip_prefix(RECORD_PREFIX) else {
            write_child_log(&self.log, line);
            return;
        };
        let record = match serde_json::from_str::<DesktopRecord>(payload) {
            Ok(record) => record,
            Err(error) => {
                self.log_launcher(&format!("Rejected malformed app readiness: {error}"));
                return;
            }
        };
        match record {
            DesktopRecord::AlreadyRunning { version: 1 } => {
                self.log_launcher("Workbench app is already running outside this tray.");
                crate::report_fatal_error(
                    "Workbench is already running outside the tray.\n\nClose the existing Workbench app, then launch the tray again.",
                );
            }
            DesktopRecord::Ready {
                app_origin,
                open_browser,
                version: 1,
            } if valid_app_origin(&app_origin) => {
                let mut current_origin =
                    self.app_origin.lock().expect("app origin lock poisoned");
                let change = update_app_origin(&mut current_origin, app_origin.clone());
                drop(current_origin);
                match change {
                    AppOriginChange::Ready => {
                        self.log_launcher(&format!("Workbench app ready at {app_origin}."));
                        if should_open_browser(&change, open_browser) {
                            self.open_browser(app);
                        }
                    }
                    AppOriginChange::Moved => {
                        self.log_launcher(&format!("Workbench app moved to {app_origin}."));
                    }
                    AppOriginChange::Unchanged => {
                        self.log_launcher(&format!("Workbench app remains at {app_origin}."));
                    }
                }
            }
            DesktopRecord::Restart { version: 1 } => {
                self.log_launcher("Workbench app requested a full native restart.");
                self.request_restart();
            }
            DesktopRecord::AlreadyRunning { .. }
            | DesktopRecord::Ready { .. }
            | DesktopRecord::Restart { .. } => {
                self.log_launcher("Rejected unsupported app readiness record.");
            }
        }
    }

    fn log_launcher(&self, message: &str) {
        write_launcher_log(&self.log, message);
    }

    fn launch_url(&self) -> Option<String> {
        self.app_origin
            .lock()
            .expect("app origin lock poisoned")
            .as_ref()
            .map(|origin| format!("{origin}/launch"))
    }

    fn run_process_manager(
        &self,
        app: AppHandle,
        receiver: Receiver<ManagerCommand>,
        mut child: Child,
        mut stdin: impl Write,
        job: WindowsChildJob,
        stdout_thread: thread::JoinHandle<()>,
        stderr_thread: thread::JoinHandle<()>,
    ) {
        let mut shutdown_deadline = None;
        let mut shutdown_intent = None;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.join_child_logs(stdout_thread, stderr_thread);
                    self.log_launcher(&format!(
                        "Workbench app exited with status {}.",
                        status.code().map_or_else(|| "unknown".into(), |code| code.to_string())
                    ));
                    match shutdown_intent {
                        Some(ShutdownIntent::Restart) => self.finish_restart(&app),
                        Some(ShutdownIntent::Quit) if status.success() => self.finish(&app, 0),
                        Some(ShutdownIntent::Quit) | None => self.finish(&app, 1),
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    self.log_launcher(&format!("Unable to inspect Workbench app status: {error}"));
                    let _ = job.terminate();
                    let _ = child.kill();
                    let _ = child.wait();
                    self.join_child_logs(stdout_thread, stderr_thread);
                    self.finish(&app, 1);
                    return;
                }
            }

            if quit_deadline_expired(shutdown_deadline, Instant::now()) {
                let intent = shutdown_intent.expect("shutdown deadline requires an intent");
                self.log_launcher(match intent {
                    ShutdownIntent::Quit => {
                        "Workbench app missed the 10-second Quit deadline; terminating its process tree."
                    }
                    ShutdownIntent::Restart => {
                        "Workbench app missed the 10-second Restart deadline; terminating its process tree."
                    }
                });
                let _ = job.terminate();
                let _ = child.kill();
                let _ = child.wait();
                self.join_child_logs(stdout_thread, stderr_thread);
                match intent {
                    ShutdownIntent::Restart => self.finish_restart(&app),
                    ShutdownIntent::Quit => self.finish(&app, 1),
                }
                return;
            }

            match receiver.recv_timeout(PROCESS_POLL_INTERVAL) {
                Ok(command) if shutdown_deadline.is_none() => {
                    let intent = match command {
                        ManagerCommand::Quit => ShutdownIntent::Quit,
                        ManagerCommand::Restart => ShutdownIntent::Restart,
                    };
                    self.log_launcher(match intent {
                        ShutdownIntent::Quit => "Requesting graceful Workbench app shutdown.",
                        ShutdownIntent::Restart => {
                            "Requesting graceful Workbench app shutdown before native restart."
                        }
                    });
                    if writeln!(stdin, r#"{{"type":"quit","version":1}}"#)
                        .and_then(|_| stdin.flush())
                        .is_err()
                    {
                        self.log_launcher(match intent {
                            ShutdownIntent::Quit => {
                                "Unable to send graceful Quit; terminating the Workbench app process tree."
                            }
                            ShutdownIntent::Restart => {
                                "Unable to send graceful Restart shutdown; terminating the Workbench app process tree."
                            }
                        });
                        let _ = job.terminate();
                        let _ = child.kill();
                        let _ = child.wait();
                        self.join_child_logs(stdout_thread, stderr_thread);
                        match intent {
                            ShutdownIntent::Restart => self.finish_restart(&app),
                            ShutdownIntent::Quit => self.finish(&app, 1),
                        }
                        return;
                    }
                    shutdown_intent = Some(intent);
                    shutdown_deadline = Some(Instant::now() + QUIT_DEADLINE);
                }
                Ok(ManagerCommand::Quit | ManagerCommand::Restart)
                | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.log_launcher("Workbench app process manager command channel disconnected.");
                    let _ = job.terminate();
                    let _ = child.kill();
                    let _ = child.wait();
                    self.join_child_logs(stdout_thread, stderr_thread);
                    self.finish(&app, 1);
                    return;
                }
            }
        }
    }

    fn finish_restart(&self, app: &AppHandle) {
        match self.spawn_replacement() {
            Ok(()) => {
                self.log_launcher("Started replacement Workbench tray.");
                self.finish(app, 0);
            }
            Err(error) => {
                self.log_launcher(&error);
                self.finish(app, 1);
            }
        }
    }

    fn join_child_logs(
        &self,
        stdout_thread: thread::JoinHandle<()>,
        stderr_thread: thread::JoinHandle<()>,
    ) {
        if stdout_thread.join().is_err() {
            self.log_launcher("Workbench app stdout reader failed unexpectedly.");
        }
        if stderr_thread.join().is_err() {
            self.log_launcher("Workbench app stderr reader failed unexpectedly.");
        }
    }

    fn spawn_replacement(&self) -> Result<(), String> {
        let launcher_path = self
            .repository_root_path
            .join("tray")
            .join("bin")
            .join("windows-x64")
            .join("workbench-tray.exe");
        require_file(&launcher_path)?;
        Command::new(&launcher_path)
            .arg("--workbench-root")
            .arg(&self.repository_root_path)
            .arg("--restart-after-pid")
            .arg(std::process::id().to_string())
            .current_dir(&self.repository_root_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Unable to start replacement Workbench tray: {error}"))
    }

    fn spawn_child(&self) -> Result<Child, String> {
        let tsx_path = self
            .repository_root_path
            .join("app")
            .join("node_modules")
            .join("tsx")
            .join("dist")
            .join("cli.mjs");
        let entry_path = self.repository_root_path.join("app").join("index.ts");
        require_file(&tsx_path)?;
        require_file(&entry_path)?;
        let mut command = Command::new("node");
        command
            .arg("--disable-warning=ExperimentalWarning")
            .arg(tsx_path)
            .arg(entry_path)
            .current_dir(&self.repository_root_path)
            .env("NO_COLOR", "1")
            .env("WORKBENCH_DESKTOP_PROTOCOL", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        command
            .spawn()
            .map_err(|error| format!("Unable to start the Workbench Node app: {error}"))
    }
}

fn require_file(file_path: &Path) -> Result<(), String> {
    if file_path.is_file() {
        Ok(())
    } else {
        Err(format!(
            "Workbench app dependency is unavailable: {}",
            file_path.display()
        ))
    }
}

fn valid_app_origin(value: &str) -> bool {
    let Some(port) = value.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    !port.is_empty() && port.parse::<u16>().is_ok_and(|port| port > 0)
}

fn write_child_log(log: &Arc<Mutex<RotatingLogWriter>>, line: &str) {
    if let Ok(mut log) = log.lock() {
        let _ = log.write_child_line(line);
    }
}

fn write_launcher_log(log: &Arc<Mutex<RotatingLogWriter>>, message: &str) {
    if let Ok(mut log) = log.lock() {
        let _ = log.write_launcher_line(message);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        quit_deadline_expired, should_open_browser, update_app_origin, valid_app_origin,
        AppOriginChange, DesktopAppController, DesktopRecord, ManagerCommand,
    };
    use std::{
        sync::Arc,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn readiness_accepts_only_bound_loopback_http_origins() {
        assert!(valid_app_origin("http://127.0.0.1:43210"));
        assert!(!valid_app_origin("http://0.0.0.0:43210"));
        assert!(!valid_app_origin("https://127.0.0.1:43210"));
        assert!(!valid_app_origin("http://127.0.0.1:0"));
        assert!(!valid_app_origin("http://127.0.0.1:not-a-port"));
    }

    #[test]
    fn readiness_parses_the_versioned_desktop_wire_record() {
        let record = serde_json::from_str::<DesktopRecord>(
            r#"{"appOrigin":"http://127.0.0.1:43210","openBrowser":false,"type":"ready","version":1}"#,
        )
        .expect("ready record");
        assert!(matches!(
            record,
            DesktopRecord::Ready {
                app_origin,
                open_browser: false,
                version: 1,
            } if app_origin == "http://127.0.0.1:43210"
        ));
        assert!(matches!(
            serde_json::from_str::<DesktopRecord>(r#"{"type":"restart","version":1}"#),
            Ok(DesktopRecord::Restart { version: 1 })
        ));
    }

    #[test]
    fn later_readiness_replaces_the_tray_origin_without_restarting_startup() {
        let mut origin = None;
        assert_eq!(
            update_app_origin(&mut origin, "http://127.0.0.1:43210".into()),
            AppOriginChange::Ready
        );
        assert_eq!(
            update_app_origin(&mut origin, "http://127.0.0.1:43211".into()),
            AppOriginChange::Moved
        );
        assert_eq!(
            update_app_origin(&mut origin, "http://127.0.0.1:43211".into()),
            AppOriginChange::Unchanged
        );
        assert_eq!(origin.as_deref(), Some("http://127.0.0.1:43211"));
        assert!(should_open_browser(&AppOriginChange::Ready, true));
        assert!(!should_open_browser(&AppOriginChange::Ready, false));
        assert!(!should_open_browser(&AppOriginChange::Moved, true));
    }

    #[test]
    fn repeated_quit_requests_emit_one_manager_command() {
        let root = std::env::temp_dir().join(format!(
            "workbench-tray-quit-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let controller = Arc::new(DesktopAppController::new(root.clone()).expect("controller"));
        let receiver = controller
            .command_receiver
            .lock()
            .expect("receiver lock")
            .take()
            .expect("receiver");
        controller.request_quit();
        controller.request_quit();
        assert!(matches!(receiver.recv(), Ok(ManagerCommand::Quit)));
        assert!(receiver.try_recv().is_err());
        drop(controller);
        std::fs::remove_dir_all(root).expect("remove controller fixture");
    }

    #[test]
    fn first_restart_or_quit_request_owns_shutdown() {
        let root = std::env::temp_dir().join(format!(
            "workbench-tray-restart-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let controller = Arc::new(DesktopAppController::new(root.clone()).expect("controller"));
        let receiver = controller
            .command_receiver
            .lock()
            .expect("receiver lock")
            .take()
            .expect("receiver");
        controller.request_restart();
        controller.request_quit();
        assert!(matches!(receiver.recv(), Ok(ManagerCommand::Restart)));
        assert!(receiver.try_recv().is_err());
        drop(controller);
        std::fs::remove_dir_all(root).expect("remove controller fixture");
    }

    #[test]
    fn quit_deadline_waits_before_expiry_and_forces_at_expiry() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(10);
        assert!(!quit_deadline_expired(Some(deadline), now));
        assert!(quit_deadline_expired(Some(deadline), deadline));
        assert!(!quit_deadline_expired(None, deadline));
    }
}
