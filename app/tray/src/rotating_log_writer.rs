/*
 * Exports:
 * - RotatingLogWriter: persist launcher and child lines with bounded line rotation and file retention.
 */
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
};
use time::OffsetDateTime;

pub struct RotatingLogWriter {
    current_file: File,
    directory_path: PathBuf,
    line_count: usize,
    max_files: usize,
    max_lines: usize,
    prefix: String,
    segment: usize,
}

impl RotatingLogWriter {
    pub fn new(
        directory_path: impl Into<PathBuf>,
        prefix: impl Into<String>,
        max_lines: usize,
        max_files: usize,
    ) -> io::Result<Self> {
        if max_lines == 0 || max_files == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "log rotation limits must be positive",
            ));
        }
        let directory_path = directory_path.into();
        fs::create_dir_all(&directory_path)?;
        let prefix = prefix.into();
        let current_file = Self::create_file(&directory_path, &prefix, 0)?;
        let writer = Self {
            current_file,
            directory_path,
            line_count: 0,
            max_files,
            max_lines,
            prefix,
            segment: 0,
        };
        writer.prune()?;
        Ok(writer)
    }

    pub fn write_child_line(&mut self, line: &str) -> io::Result<()> {
        self.write_line(line)
    }

    pub fn write_launcher_line(&mut self, message: &str) -> io::Result<()> {
        let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
        self.write_line(&format!(
            "[{:02}:{:02}:{:02}.{:03}] {}",
            now.hour(),
            now.minute(),
            now.second(),
            now.millisecond(),
            message.replace(['\r', '\n'], " ")
        ))
    }

    fn create_file(directory_path: &Path, prefix: &str, segment: usize) -> io::Result<File> {
        let now = OffsetDateTime::now_utc();
        let file_name = format!(
            "{}-{:04}{:02}{:02}-{:02}{:02}{:02}-{}-{:04}.log",
            prefix,
            now.year(),
            u8::from(now.month()),
            now.day(),
            now.hour(),
            now.minute(),
            now.second(),
            process::id(),
            segment
        );
        OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(directory_path.join(file_name))
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.segment += 1;
        self.current_file = Self::create_file(&self.directory_path, &self.prefix, self.segment)?;
        self.line_count = 0;
        self.prune()
    }

    fn write_line(&mut self, line: &str) -> io::Result<()> {
        if self.line_count >= self.max_lines {
            self.rotate()?;
        }
        writeln!(self.current_file, "{}", line.trim_end_matches(['\r', '\n']))?;
        self.current_file.flush()?;
        self.line_count += 1;
        Ok(())
    }

    fn prune(&self) -> io::Result<()> {
        let mut files = fs::read_dir(&self.directory_path)?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(&format!("{}-", self.prefix))
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        files.sort();
        let excess = files.len().saturating_sub(self.max_files);
        for file_path in files.into_iter().take(excess) {
            fs::remove_file(file_path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::RotatingLogWriter;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temporary_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "workbench-tray-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ))
    }

    #[test]
    fn rotates_before_the_next_line_and_retains_only_owned_files() {
        let directory = temporary_directory("rotation");
        fs::create_dir_all(&directory).expect("create test directory");
        fs::write(directory.join("workbench-daemon-keep.log"), "keep\n")
            .expect("write foreign log");
        let mut writer =
            RotatingLogWriter::new(&directory, "workbench-app", 2, 2).expect("create writer");
        for line in ["one", "two", "three", "four", "five"] {
            writer.write_child_line(line).expect("write line");
        }
        drop(writer);

        let names = fs::read_dir(&directory)
            .expect("read logs")
            .map(|entry| entry.expect("log entry").file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            names.iter().filter(|name| name.starts_with("workbench-app-")).count(),
            2
        );
        assert!(names.iter().any(|name| name == "workbench-daemon-keep.log"));
        fs::remove_dir_all(directory).expect("remove test directory");
    }
}
