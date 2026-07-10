"use client";

/*
 * Exports:
 * - default ThreadAgentPicker: render agent selection, refresh, and return-to-message controls for a thread composer. Keywords: thread, agent, picker, refresh.
 */
import type { WorkbenchAgentOption } from "../../../lib/types";
import { PanelCloseIcon, ReloadIcon } from "../workbench-icons";

const pickerIconButtonClassName = "inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] text-muted transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[color-mix(in_srgb,var(--text)_10%,transparent)] disabled:hover:bg-transparent disabled:hover:text-muted";

export default function ThreadAgentPicker ({
	agents,
	error,
	isLoading,
	isRefreshDisabled,
	isRefreshing,
	onClose,
	onRefresh,
	onSelectAgent,
	selectedAgentPath,
}: {
	agents: WorkbenchAgentOption[];
	error: string;
	isLoading: boolean;
	isRefreshDisabled: boolean;
	isRefreshing: boolean;
	onClose: () => void;
	onRefresh: () => void;
	onSelectAgent: (agentPath: string | null) => void;
	selectedAgentPath: string | null;
}) {
	return (
		<>
			<div className="flex items-center justify-between gap-3">
				<div className="shrink-1">
					<p className="m-0 text-[1.2em] font-semibold text-muted">Choose an agent</p>
				</div>
				<div className="flex shrink-0 items-center gap-2 self-start">
					<button
						type="button"
						aria-label={isRefreshing ? "Refreshing agents" : "Refresh agents"}
						title={isRefreshing ? "Refreshing agents" : "Refresh agents"}
						className={pickerIconButtonClassName}
						disabled={isRefreshDisabled}
						onClick={onRefresh}
					>
						<span className={isRefreshing ? "animate-spin [animation-direction:reverse]" : ""}>
							<ReloadIcon />
						</span>
					</button>
					<button
						type="button"
						aria-label="Back to message"
						title="Back to message"
						className={pickerIconButtonClassName}
						onClick={onClose}
					>
						<PanelCloseIcon />
					</button>
				</div>
			</div>
			{error ? (
				<p className="mt-3 mb-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
			) : null}
			{isLoading ? (
				<p className="mt-3 mb-0 text-[0.84em] leading-[1.6] text-muted">Loading agents...</p>
			) : (
				<div className="mt-3 grid gap-3">
					<button
						type="button"
						className={[
							"rounded-[1rem] border px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
							selectedAgentPath === null
								? "border-text bg-[color-mix(in_srgb,var(--text)_6%,transparent)]"
								: "border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_98%,transparent)] hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]",
						].join(" ")}
						onClick={() => {
							onSelectAgent(null);
						}}
					>
						<p className="m-0 text-[0.96em] font-semibold text-text">Default agent</p>
						<p className="mt-1 mb-0 text-[0.78em] leading-[1.6] text-muted">Use the harness default behavior without a custom agent file.</p>
					</button>
					{agents.map((agent) => (
						<button
							key={agent.path}
							type="button"
							className={[
								"rounded-[1rem] border px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
								selectedAgentPath === agent.path
									? "border-text bg-[color-mix(in_srgb,var(--text)_6%,transparent)]"
									: "border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_98%,transparent)] hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]",
							].join(" ")}
							onClick={() => {
								onSelectAgent(agent.path);
							}}
						>
							<p className="m-0 text-[0.96em] font-semibold text-text">{agent.name}</p>
							<p className="mt-1 mb-0 break-all text-[0.78em] leading-[1.6] text-muted">
								{agent.sourceLabel ? `${agent.sourceLabel} - ` : ""}{agent.path}
							</p>
							{agent.description ? (
								<p className="mt-2 mb-0 text-[0.82em] leading-[1.7] text-muted">{agent.description}</p>
							) : null}
						</button>
					))}
					{!agents.length && !error ? (
						<p className="m-0 text-[0.84em] leading-[1.6] text-muted">No user-invocable agent files are available in this workspace.</p>
					) : null}
				</div>
			)}
		</>
	);
}
