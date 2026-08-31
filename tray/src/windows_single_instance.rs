/*
 * Exports:
 * - init: build the Windows tray singleton plugin with bounded secondary activation and owner takeover.
 */
use std::time::{Duration, Instant};

const RECEIVER_POLL_INTERVAL: Duration = Duration::from_millis(50);
const SECONDARY_ACTIVATION_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq)]
enum LaunchRole {
    Primary,
    Secondary,
}

#[derive(Debug, PartialEq)]
enum OwnershipWait {
    Acquired,
    Pending,
}

fn timeout_milliseconds(duration: Duration) -> u32 {
    duration.as_millis().clamp(1, u32::MAX as u128) as u32
}

fn settle_existing_instance<T: Copy>(
    mut find_receiver: impl FnMut() -> Option<T>,
    mut notify_receiver: impl FnMut(T, u32) -> Result<(), String>,
    mut wait_for_ownership: impl FnMut(u32) -> Result<OwnershipWait, String>,
    mut now: impl FnMut() -> Instant,
) -> Result<LaunchRole, String> {
    let deadline = now() + SECONDARY_ACTIVATION_DEADLINE;
    loop {
        let remaining = deadline.saturating_duration_since(now());
        if remaining.is_zero() {
            return Err(
                "Existing Workbench tray did not accept activation within five seconds.".into(),
            );
        }
        if let Some(receiver) = find_receiver() {
            return match notify_receiver(receiver, timeout_milliseconds(remaining)) {
                Ok(()) => Ok(LaunchRole::Secondary),
                Err(delivery_error) => match wait_for_ownership(0)? {
                    OwnershipWait::Acquired => Ok(LaunchRole::Primary),
                    OwnershipWait::Pending => Err(delivery_error),
                },
            };
        }
        let wait = remaining.min(RECEIVER_POLL_INTERVAL);
        if wait_for_ownership(timeout_milliseconds(wait))? == OwnershipWait::Acquired {
            return Ok(LaunchRole::Primary);
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::{settle_existing_instance, LaunchRole, OwnershipWait};
    use std::{io, ptr};
    use tauri::{
        plugin::{self, TauriPlugin},
        AppHandle, Manager, RunEvent, Runtime,
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT,
            WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT, WPARAM,
        },
        System::{
            LibraryLoader::GetModuleHandleW,
            Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
        },
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, FindWindowW, GetWindowLongPtrW,
            RegisterClassExW, SendMessageTimeoutW, SetWindowLongPtrW, CREATESTRUCTW, GWLP_USERDATA,
            GWL_STYLE, SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_APP, WM_CREATE, WM_DESTROY, WNDCLASSEXW,
            WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_OVERLAPPED,
            WS_POPUP, WS_VISIBLE,
        },
    };

    const ACTIVATION_MESSAGE: u32 = WM_APP + 42;

    struct MutexHandle(isize);
    struct TargetWindowHandle(isize);

    struct UserData<R: Runtime> {
        app: AppHandle<R>,
        callback: Box<dyn FnMut(&AppHandle<R>) + Send + Sync + 'static>,
    }

    impl<R: Runtime> UserData<R> {
        fn activate(&mut self) {
            (self.callback)(&self.app);
        }
    }

    pub fn init<
        R: Runtime,
        F: FnMut(&AppHandle<R>) + Send + Sync + 'static,
    >(
        callback: F,
    ) -> TauriPlugin<R> {
        plugin::Builder::new("workbench-single-instance")
            .setup(|app, _api| {
                let identifier = app.config().identifier.clone();
                let class_name = encode_wide(format!("{identifier}-sic"));
                let window_name = encode_wide(format!("{identifier}-siw"));
                let mutex_name = encode_wide(format!("{identifier}-sim"));
                let mutex = unsafe { CreateMutexW(ptr::null(), true.into(), mutex_name.as_ptr()) };
                if mutex.is_null() {
                    return Err(io::Error::last_os_error().into());
                }

                if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                    let role = settle_existing_instance(
                        || {
                            let receiver =
                                unsafe { FindWindowW(class_name.as_ptr(), window_name.as_ptr()) };
                            (!receiver.is_null()).then_some(receiver)
                        },
                        notify_receiver,
                        |timeout| wait_for_ownership(mutex, timeout),
                        std::time::Instant::now,
                    );
                    match role {
                        Ok(LaunchRole::Secondary) => {
                            unsafe {
                                CloseHandle(mutex);
                            }
                            app.cleanup_before_exit();
                            std::process::exit(0);
                        }
                        Ok(LaunchRole::Primary) => {}
                        Err(error) => {
                            unsafe {
                                CloseHandle(mutex);
                            }
                            return Err(io::Error::other(error).into());
                        }
                    }
                }

                let user_data = Box::into_raw(Box::new(UserData {
                    app: app.clone(),
                    callback: Box::new(callback),
                }));
                let receiver = create_receiver::<R>(&class_name, &window_name, user_data);
                if receiver.is_null() {
                    let error = io::Error::last_os_error();
                    unsafe {
                        drop(Box::from_raw(user_data));
                        ReleaseMutex(mutex);
                        CloseHandle(mutex);
                    }
                    return Err(error.into());
                }
                app.manage(MutexHandle(mutex as isize));
                app.manage(TargetWindowHandle(receiver as isize));
                Ok(())
            })
            .on_event(|app, event| {
                if let RunEvent::Exit = event {
                    destroy(app);
                }
            })
            .build()
    }

    fn notify_receiver(receiver: HWND, timeout: u32) -> Result<(), String> {
        let mut result = 0;
        let delivered = unsafe {
            SendMessageTimeoutW(
                receiver,
                ACTIVATION_MESSAGE,
                0,
                0,
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                timeout,
                &mut result,
            )
        };
        if delivered == 0 {
            let error = io::Error::last_os_error();
            let detail = if error.raw_os_error() == Some(0) {
                "activation timed out".into()
            } else {
                error.to_string()
            };
            Err(format!(
                "Existing Workbench tray did not accept activation: {detail}"
            ))
        } else if result != 1 {
            Err("Existing Workbench tray did not acknowledge activation.".into())
        } else {
            Ok(())
        }
    }

    pub(super) fn known_ownership_wait(result: u32) -> Option<OwnershipWait> {
        match result {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Some(OwnershipWait::Acquired),
            WAIT_TIMEOUT => Some(OwnershipWait::Pending),
            _ => None,
        }
    }

    fn wait_for_ownership(
        mutex: *mut core::ffi::c_void,
        timeout: u32,
    ) -> Result<OwnershipWait, String> {
        let result = unsafe { WaitForSingleObject(mutex, timeout) };
        if let Some(wait) = known_ownership_wait(result) {
            return Ok(wait);
        }
        match result {
            WAIT_FAILED => Err(format!(
                "Unable to wait for Workbench tray ownership: {}",
                io::Error::last_os_error()
            )),
            result => Err(format!(
                "Workbench tray ownership wait returned unexpected status {result}."
            )),
        }
    }

    fn destroy<R: Runtime, M: Manager<R>>(manager: &M) {
        if let Some(receiver) = manager.try_state::<TargetWindowHandle>() {
            unsafe {
                DestroyWindow(receiver.0 as _);
            }
        }
        if let Some(mutex) = manager.try_state::<MutexHandle>() {
            unsafe {
                ReleaseMutex(mutex.0 as _);
                CloseHandle(mutex.0 as _);
            }
        }
    }

    unsafe extern "system" fn receiver_window_proc<R: Runtime>(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_CREATE => {
                let create = unsafe { &*(lparam as *const CREATESTRUCTW) };
                unsafe {
                    SetWindowLongPtrW(window, GWLP_USERDATA, create.lpCreateParams as isize);
                }
                0
            }
            ACTIVATION_MESSAGE => {
                let user_data =
                    unsafe { GetWindowLongPtrW(window, GWLP_USERDATA) as *mut UserData<R> };
                if user_data.is_null() {
                    return 0;
                }
                unsafe {
                    (*user_data).activate();
                }
                1
            }
            WM_DESTROY => {
                let user_data =
                    unsafe { GetWindowLongPtrW(window, GWLP_USERDATA) as *mut UserData<R> };
                if !user_data.is_null() {
                    unsafe {
                        SetWindowLongPtrW(window, GWLP_USERDATA, 0);
                        drop(Box::from_raw(user_data));
                    }
                }
                0
            }
            _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
        }
    }

    fn create_receiver<R: Runtime>(
        class_name: &[u16],
        window_name: &[u16],
        user_data: *const UserData<R>,
    ) -> HWND {
        unsafe {
            let module = GetModuleHandleW(ptr::null());
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: 0,
                lpfnWndProc: Some(receiver_window_proc::<R>),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: module,
                hIcon: ptr::null_mut(),
                hCursor: ptr::null_mut(),
                hbrBackground: ptr::null_mut(),
                lpszMenuName: ptr::null(),
                lpszClassName: class_name.as_ptr(),
                hIconSm: ptr::null_mut(),
            };
            RegisterClassExW(&class);
            let window = CreateWindowExW(
                WS_EX_NOACTIVATE
                    | WS_EX_TRANSPARENT
                    | WS_EX_LAYERED
                    | WS_EX_TOOLWINDOW,
                class_name.as_ptr(),
                window_name.as_ptr(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                module,
                user_data as _,
            );
            if !window.is_null() {
                SetWindowLongPtrW(window, GWL_STYLE, (WS_VISIBLE | WS_POPUP) as isize);
            }
            window
        }
    }

    fn encode_wide(string: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        string
            .as_ref()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
}

#[cfg(windows)]
pub use platform::init;

#[cfg(not(windows))]
pub fn init<
    R: tauri::Runtime,
    F: FnMut(&tauri::AppHandle<R>) + Send + Sync + 'static,
>(
    _callback: F,
) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("workbench-single-instance").build()
}

#[cfg(test)]
mod tests {
    use super::{settle_existing_instance, LaunchRole, OwnershipWait};
    use std::{
        cell::Cell,
        time::{Duration, Instant},
    };

    #[test]
    fn healthy_receiver_accepts_one_secondary_activation() {
        let now = Instant::now();
        let delivered = Cell::new(0);
        let role = settle_existing_instance(
            || Some(7),
            |receiver, timeout| {
                assert_eq!(receiver, 7);
                assert!(timeout > 0);
                delivered.set(delivered.get() + 1);
                Ok(())
            },
            |_| panic!("ownership wait should not run after delivery"),
            || now,
        )
        .expect("secondary role");
        assert_eq!(role, LaunchRole::Secondary);
        assert_eq!(delivered.get(), 1);
    }

    #[test]
    fn owner_exit_during_receiver_discovery_transfers_primary_role() {
        let now = Instant::now();
        let role = settle_existing_instance(
            || None::<u8>,
            |_, _| panic!("receiver should not be notified"),
            |timeout| {
                assert!(timeout > 0);
                Ok(OwnershipWait::Acquired)
            },
            || now,
        )
        .expect("primary takeover");
        assert_eq!(role, LaunchRole::Primary);
    }

    #[test]
    fn receiver_discovery_waits_without_losing_activation() {
        let now = Instant::now();
        let receiver_ready = Cell::new(false);
        let role = settle_existing_instance(
            || receiver_ready.get().then_some(7),
            |receiver, _| {
                assert_eq!(receiver, 7);
                Ok(())
            },
            |_| {
                receiver_ready.set(true);
                Ok(OwnershipWait::Pending)
            },
            || now,
        )
        .expect("secondary role");
        assert_eq!(role, LaunchRole::Secondary);
    }

    #[test]
    fn owner_exit_after_failed_delivery_transfers_primary_role() {
        let now = Instant::now();
        let role = settle_existing_instance(
            || Some(3),
            |_, _| Err("receiver disappeared".into()),
            |timeout| {
                assert_eq!(timeout, 0);
                Ok(OwnershipWait::Acquired)
            },
            || now,
        )
        .expect("primary takeover");
        assert_eq!(role, LaunchRole::Primary);
    }

    #[test]
    fn failed_delivery_while_owner_remains_alive_surfaces_failure() {
        let now = Instant::now();
        let result = settle_existing_instance(
            || Some(3),
            |_, _| Err("receiver did not acknowledge activation".into()),
            |timeout| {
                assert_eq!(timeout, 0);
                Ok(OwnershipWait::Pending)
            },
            || now,
        );
        assert_eq!(
            result,
            Err("receiver did not acknowledge activation".into())
        );
    }

    #[test]
    fn unresponsive_owner_fails_at_the_single_activation_deadline() {
        let started = Instant::now();
        let calls = Cell::new(0);
        let result = settle_existing_instance(
            || None::<u8>,
            |_, _| panic!("receiver should not be notified"),
            |_| Ok(OwnershipWait::Pending),
            || {
                let call = calls.get();
                calls.set(call + 1);
                if call == 0 {
                    started
                } else {
                    started + Duration::from_secs(5)
                }
            },
        );
        assert!(result.is_err());
    }

    #[cfg(windows)]
    #[test]
    fn normal_and_abandoned_mutex_results_both_transfer_ownership() {
        use super::platform::known_ownership_wait;
        use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0};

        assert_eq!(
            known_ownership_wait(WAIT_OBJECT_0),
            Some(OwnershipWait::Acquired)
        );
        assert_eq!(
            known_ownership_wait(WAIT_ABANDONED),
            Some(OwnershipWait::Acquired)
        );
    }
}
