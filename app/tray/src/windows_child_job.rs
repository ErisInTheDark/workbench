/*
 * Exports:
 * - WindowsChildJob: hold a Windows kill-on-close job around the Node app process tree.
 */
use std::{io, process::Child};

#[cfg(windows)]
pub struct WindowsChildJob {
    handle: isize,
}

#[cfg(windows)]
impl WindowsChildJob {
    pub fn attach(child: &Child) -> io::Result<Self> {
        use std::{ffi::c_void, mem::size_of, os::windows::io::AsRawHandle};
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        let assigned = configured != 0
            && unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as *mut c_void) } != 0;
        if !assigned {
            let error = io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(error);
        }
        Ok(Self {
            handle: handle as isize,
        })
    }

    pub fn terminate(&self) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        let result = unsafe { TerminateJobObject(self.handle as *mut _, 1) };
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsChildJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            CloseHandle(self.handle as *mut _);
        }
    }
}

#[cfg(not(windows))]
pub struct WindowsChildJob;

#[cfg(not(windows))]
impl WindowsChildJob {
    pub fn attach(_child: &Child) -> io::Result<Self> {
        Ok(Self)
    }

    pub fn terminate(&self) -> io::Result<()> {
        Ok(())
    }
}
