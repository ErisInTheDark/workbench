// No exports. `wb` for agent shells on Windows and Linux: forwards argv exactly to the local daemon's agent-command
// route and runs checkout-local `ports` and `test` through node. A native image receives argv from every shell
// without re-parsing, so quotes, newlines, shell metacharacters and bare `--` arrive intact.
// Request fields mirror daemon/server/WorkbenchAgentCommandController.ts; daemon discovery lives in endpoint.go.
package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	checkoutRootEnv    = "WORKBENCH_CHECKOUT_ROOT"
	redirectedEnv      = "WORKBENCH_CWD_REDIRECTED"
	hookEnv            = "WORKBENCH_APPLY_PATCH_CLAIM_HOOK"
	hookConnectTimeout = 2 * time.Second
	agentCommandPath   = "/daemon/agent-command"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "wb could not read its working directory: %v\n", err)
		return 1
	}
	if code, redirected := redirect(cwd, args); redirected {
		return code
	}
	os.Unsetenv(redirectedEnv)
	root := os.Getenv(checkoutRootEnv)
	if len(args) == 1 && args[0] == "ports" {
		return runPorts(root)
	}
	if len(args) > 0 && args[0] == "test" && (len(args) < 2 || args[1] != "live") {
		return runTests(root, cwd, args[1:])
	}
	hook := isHook(args)
	if hook && len(args) == 0 {
		args = []string{"__hook", "apply-patch-claim"}
	}
	origin, err := resolveOrigin()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Workbench daemon is unavailable: %v\n", err)
		return failure(hook)
	}
	return dispatch(origin, cwd, args, hook)
}

// The apply-patch claim hook must never block a provider edit when Workbench is unreachable.
func isHook(args []string) bool {
	return len(args) == 0 && os.Getenv(hookEnv) == "1" ||
		len(args) == 2 && args[0] == "__hook" && args[1] == "apply-patch-claim"
}

func failure(hook bool) int {
	if hook {
		fmt.Println("{}")
		return 0
	}
	return 1
}

// Running wb inside another Workbench checkout uses that checkout's own launcher.
func redirect(cwd string, args []string) (int, bool) {
	if os.Getenv(redirectedEnv) == "1" {
		return 0, false
	}
	candidate := filepath.Join(cwd, "daemon", "launcher", "bin", platformDirectory(), executableName())
	if !isFile(candidate) {
		return 0, false
	}
	if root := os.Getenv(checkoutRootEnv); root != "" && sameFile(root, cwd) {
		return 0, false
	}
	if self, err := os.Executable(); err == nil && sameFile(self, candidate) {
		return 0, false
	}
	env := withEnv(os.Environ(), redirectedEnv+"=1", checkoutRootEnv+"="+cwd)
	return runChild(candidate, args, env), true
}

func runPorts(root string) int {
	cli := filepath.Join(root, "cli", "dispatch.mjs")
	if root == "" || !isFile(cli) {
		fmt.Fprintln(os.Stderr, "Workbench checkout CLI is unavailable.")
		return 1
	}
	return runNode("--disable-warning=ExperimentalWarning", cli, "ports")
}

func runTests(root string, cwd string, args []string) int {
	if root == "" || !sameFile(cwd, root) {
		fmt.Fprintln(os.Stderr, "wb test only works from the Workbench repository root.")
		return 1
	}
	entry := filepath.Join(root, "test", "run-claimed-tests.mjs")
	return runNode(append([]string{"--disable-warning=ExperimentalWarning", "--import", "tsx", entry}, args...)...)
}

func runNode(args ...string) int {
	node, err := exec.LookPath("node")
	if err != nil {
		fmt.Fprintln(os.Stderr, "wb could not find node on PATH.")
		return 1
	}
	return runChild(node, args, os.Environ())
}

// Linux replaces this process; Windows has no exec, so it waits and leaves Ctrl+C to the child.
func runChild(executable string, args []string, env []string) int {
	if runtime.GOOS != "windows" {
		err := syscall.Exec(executable, append([]string{executable}, args...), env)
		fmt.Fprintf(os.Stderr, "wb could not start %s: %v\n", executable, err)
		return 1
	}
	signal.Ignore(os.Interrupt)
	command := exec.Command(executable, args...)
	command.Env = env
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "wb could not start %s: %v\n", executable, err)
		return 1
	}
	return 0
}

func dispatch(origin string, cwd string, args []string, hook bool) int {
	form := url.Values{}
	form.Set("cwd", wireDirectory(cwd))
	form.Set("callerThreadId", firstNonEmpty(os.Getenv("WORKBENCH_THREAD_ID"), os.Getenv("CODEX_THREAD_ID")))
	form.Set("callerHarness", firstNonEmpty(os.Getenv("WORKBENCH_HARNESS"), "codex"))
	form.Set("workbenchOrigin", origin)
	form.Set("dangerouslyAccessEnvVars", os.Getenv("DANGEROUSLY_ACCESS_ENV_VARS"))
	form.Set("managedScript", os.Getenv("THIS_IS_A_MANAGED_SCRIPT"))
	for _, argument := range args {
		form.Add("arg", argument)
	}
	path := agentCommandPath
	// A vis render pipes its rendered output here; the larger body is admitted only on this route.
	visRender := len(args) >= 2 && args[0] == "vis" && args[1] == "render"
	if hook || visRender {
		input, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "wb could not read stdin: %v\n", err)
			return failure(hook)
		}
		if hook {
			form.Set("hookInput", string(input))
		} else {
			form.Set("stdin", string(input))
			path += "?input=vis-render"
		}
	}
	dialer := &net.Dialer{}
	if hook {
		dialer.Timeout = hookConnectTimeout
	}
	client := &http.Client{
		CheckRedirect: refuseRedirect,
		Transport:     &http.Transport{DialContext: dialer.DialContext},
	}
	response, err := client.Post(origin+path, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Workbench daemon request failed: %v\n", err)
		return failure(hook)
	}
	defer response.Body.Close()
	succeeded := response.StatusCode >= 200 && response.StatusCode < 300
	target := os.Stdout
	if !succeeded {
		target = os.Stderr
	}
	if _, err := io.Copy(target, response.Body); err != nil {
		fmt.Fprintf(os.Stderr, "Workbench daemon response failed: %v\n", err)
		return failure(hook)
	}
	if succeeded {
		return 0
	}
	return failure(hook)
}

func refuseRedirect(*http.Request, []*http.Request) error {
	return http.ErrUseLastResponse
}

// The daemon has always received Windows directories with forward slashes from the earlier shell shim.
func wireDirectory(directory string) string {
	if runtime.GOOS == "windows" {
		return filepath.ToSlash(directory)
	}
	return directory
}

func platformDirectory() string {
	if runtime.GOOS == "windows" {
		return "windows-x64"
	}
	return "linux-x64"
}

func executableName() string {
	if runtime.GOOS == "windows" {
		return "wb.exe"
	}
	return "wb"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func sameFile(left string, right string) bool {
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	return leftErr == nil && rightErr == nil && os.SameFile(leftInfo, rightInfo)
}

func withEnv(environ []string, entries ...string) []string {
	result := make([]string, 0, len(environ)+len(entries))
	for _, existing := range environ {
		keep := true
		for _, entry := range entries {
			name := entry[:strings.IndexByte(entry, '=')+1]
			if len(existing) >= len(name) && strings.EqualFold(existing[:len(name)], name) {
				keep = false
				break
			}
		}
		if keep {
			result = append(result, existing)
		}
	}
	return append(result, entries...)
}
