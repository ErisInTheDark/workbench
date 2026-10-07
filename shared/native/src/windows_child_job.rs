/*
 * Exports:
 * - WindowsChildJob: hold a Windows kill-on-close job around a spawned child or an existing process tree.
 */
use std::{io, process::Child};

#[cfg(windows)]
pub struct WindowsChildJob {
    handle: isize,
}

#[cfg(windows)]
impl WindowsChildJob {
    pub fn attach(child: &Child) -> io::Result<Self> {
        use std::{ffi::c_void, os::windows::io::AsRawHandle};
        Self::attach_handle(child.as_raw_handle() as *mut c_void)
    }

    /// Attach a process this binary did not spawn. It must not have spawned descendants yet.
    pub fn attach_pid(pid: u32) -> io::Result<Self> {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
        };
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let attached = Self::attach_handle(process);
        unsafe {
            CloseHandle(process);
        }
        attached
    }

    fn attach_handle(process: *mut std::ffi::c_void) -> io::Result<Self> {
        use std::{ffi::c_void, mem::size_of};
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
            && unsafe { AssignProcessToJobObject(handle, process) } != 0;
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

    pub fn attach_pid(_pid: u32) -> io::Result<Self> {
        Err(io::Error::other("Process jobs are Windows-only."))
    }

    pub fn terminate(&self) -> io::Result<()> {
        Ok(())
    }
}
