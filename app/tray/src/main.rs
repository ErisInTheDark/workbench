/*
 * No public exports. Native entry owns Tauri singleton setup, tray construction, and desktop app shutdown routing.
 */
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop_app_controller;
mod rotating_log_writer;
mod windows_child_job;
mod windows_process_wait;
mod windows_single_instance;

use desktop_app_controller::DesktopAppController;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};

#[derive(Debug, PartialEq)]
struct LauncherInputs {
    repository_root_path: PathBuf,
    restart_after_process_id: Option<u32>,
}

fn launcher_inputs(
    arguments: impl IntoIterator<Item = OsString>,
    executable_path: &Path,
) -> Result<LauncherInputs, String> {
    let mut arguments = arguments.into_iter();
    let mut repository_root_path = None;
    let mut restart_after_process_id = None;
    while let Some(flag) = arguments.next() {
        if flag == "--workbench-root" {
            if repository_root_path.is_some() {
                return Err("Workbench tray received --workbench-root more than once.".into());
            }
            repository_root_path = Some(PathBuf::from(
                arguments
                    .next()
                    .ok_or("Workbench tray requires a checkout root path.")?,
            ));
            continue;
        }
        if flag == "--restart-after-pid" {
            if restart_after_process_id.is_some() {
                return Err("Workbench tray received --restart-after-pid more than once.".into());
            }
            let raw_process_id = arguments
                .next()
                .ok_or("Workbench tray requires a predecessor process id.")?;
            let process_id = raw_process_id
                .to_string_lossy()
                .parse::<u32>()
                .map_err(|_| "Workbench tray received an invalid predecessor process id.")?;
            if process_id == 0 {
                return Err("Workbench tray received an invalid predecessor process id.".into());
            }
            restart_after_process_id = Some(process_id);
            continue;
        }
        return Err(format!(
            "Workbench tray received an unexpected argument: {}.",
            flag.to_string_lossy()
        ));
    }
    let root = if let Some(root) = repository_root_path {
        root
    } else {
        let root = executable_path
            .ancestors()
            .nth(5)
            .ok_or("Workbench tray could not derive its checkout root from its executable path.")?;
        root.to_path_buf()
    };
    Ok(LauncherInputs {
        repository_root_path: validate_repository_root(root)?,
        restart_after_process_id,
    })
}

fn validate_repository_root(root: PathBuf) -> Result<PathBuf, String> {
    if !root.join("app").join("server").join("index.ts").is_file() {
        return Err(format!(
            "Workbench checkout is unavailable: {}",
            root.display()
        ));
    }
    Ok(root)
}

fn run() -> Result<(), String> {
    let executable_path = std::env::current_exe()
        .map_err(|error| format!("Workbench tray could not locate its executable: {error}"))?;
    let inputs = launcher_inputs(std::env::args_os().skip(1), &executable_path)?;
    if let Some(process_id) = inputs.restart_after_process_id {
        windows_process_wait::wait_for_process_exit(process_id)?;
    }
    let controller = Arc::new(DesktopAppController::new(inputs.repository_root_path)?);
    let setup_controller = Arc::clone(&controller);
    let event_controller = Arc::clone(&controller);
    let app = tauri::Builder::default()
        .plugin(windows_single_instance::init(|app| {
            app.state::<Arc<DesktopAppController>>()
                .open_browser(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::clone(&controller))
        .setup(move |app| {
            let open_url = MenuItem::with_id(app, "open-url", "Open url", true, None::<&str>)?;
            let copy_url = MenuItem::with_id(app, "copy-url", "Copy url", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_url, &copy_url, &quit])?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .ok_or("Workbench tray icon is unavailable.")?
                        .clone(),
                )
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Workbench")
                .on_menu_event(|app, event| {
                    let controller = app.state::<Arc<DesktopAppController>>();
                    match event.id.as_ref() {
                        "open-url" => controller.open_browser(app),
                        "copy-url" => controller.copy_url(),
                        "quit" => controller.request_quit(),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    let app = tray.app_handle();
                    let controller = app.state::<Arc<DesktopAppController>>();
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => controller.open_browser(app),
                        TrayIconEvent::Click {
                            button: MouseButton::Middle,
                            button_state: MouseButtonState::Up,
                            ..
                        } => controller.copy_url(),
                        _ => {}
                    }
                })
                .build(app)?;
            setup_controller.start(app.handle().clone())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(|error| format!("Unable to build Workbench tray: {error}"))?;

    app.run(move |_app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !event_controller.exit_allowed() {
                api.prevent_exit();
                event_controller.request_quit();
            }
        }
    });
    Ok(())
}

#[cfg(windows)]
pub(crate) fn report_fatal_error(error: &str) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

    eprintln!("{error}");
    let message = std::ffi::OsStr::new(error)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let title = std::ffi::OsStr::new("Workbench could not start")
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
pub(crate) fn report_fatal_error(error: &str) {
    eprintln!("{error}");
}

fn main() {
    if let Err(error) = run() {
        report_fatal_error(&error);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{launcher_inputs, LauncherInputs};
    use std::{
        ffi::OsString,
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn fixture_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "workbench-tray-root-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("app").join("server")).expect("create app fixture");
        fs::write(root.join("app").join("server").join("index.ts"), "").expect("create app entry fixture");
        root
    }

    #[test]
    fn no_arguments_derive_checkout_from_committed_executable_location() {
        let root = fixture_root();
        let executable_path = root
            .join("app")
            .join("tray")
            .join("bin")
            .join("windows-x64")
            .join("workbench-tray.exe");
        let actual =
            launcher_inputs(Vec::<OsString>::new(), &executable_path).expect("derived checkout root");
        assert_eq!(
            actual,
            LauncherInputs {
                repository_root_path: root.clone(),
                restart_after_process_id: None,
            }
        );
        fs::remove_dir_all(root).expect("remove checkout fixture");
    }

    #[test]
    fn explicit_checkout_argument_remains_supported() {
        let root = fixture_root();
        let executable_path = PathBuf::from("unused.exe");
        let actual = launcher_inputs(
            [
                OsString::from("--workbench-root"),
                root.clone().into_os_string(),
            ],
            &executable_path,
        )
        .expect("explicit checkout root");
        assert_eq!(
            actual,
            LauncherInputs {
                repository_root_path: root.clone(),
                restart_after_process_id: None,
            }
        );
        fs::remove_dir_all(root).expect("remove checkout fixture");
    }

    #[test]
    fn restart_handoff_accepts_one_nonzero_predecessor_process_id() {
        let root = fixture_root();
        let actual = launcher_inputs(
            [
                OsString::from("--restart-after-pid"),
                OsString::from("43210"),
                OsString::from("--workbench-root"),
                root.clone().into_os_string(),
            ],
            &PathBuf::from("unused.exe"),
        )
        .expect("restart inputs");
        assert_eq!(
            actual,
            LauncherInputs {
                repository_root_path: root.clone(),
                restart_after_process_id: Some(43_210),
            }
        );
        assert!(launcher_inputs(
            [
                OsString::from("--workbench-root"),
                root.clone().into_os_string(),
                OsString::from("--restart-after-pid"),
                OsString::from("0"),
            ],
            &PathBuf::from("unused.exe"),
        )
        .is_err());
        fs::remove_dir_all(root).expect("remove checkout fixture");
    }
}
