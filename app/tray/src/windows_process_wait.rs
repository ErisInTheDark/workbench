/*
 * Exports:
 * - wait_for_process_exit: wait on one exact Windows process lifetime before replacement startup.
 */
#[cfg(windows)]
pub fn wait_for_process_exit(process_id: u32) -> Result<(), String> {
    use std::io;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER},
        System::Threading::{INFINITE, OpenProcess, WaitForSingleObject},
    };

    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
    let handle = unsafe { OpenProcess(SYNCHRONIZE_ACCESS, 0, process_id) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            return Ok(());
        }
        return Err(format!(
            "Unable to observe predecessor process {process_id}: {error}"
        ));
    }
    let wait_result = unsafe { WaitForSingleObject(handle, INFINITE) };
    let wait_error = (wait_result != 0).then(io::Error::last_os_error);
    let close_result = unsafe { CloseHandle(handle) };
    if let Some(error) = wait_error {
        return Err(format!(
            "Waiting for predecessor process {process_id} failed: {error}"
        ));
    }
    if close_result == 0 {
        return Err(format!(
            "Closing predecessor process {process_id} failed: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn wait_for_process_exit(_process_id: u32) -> Result<(), String> {
    Ok(())
}
