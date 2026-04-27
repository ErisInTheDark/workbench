"use client";

import type { WorkbenchAgentOption } from "../../../lib/types";

export default function ThreadAgentPicker ({
	agents,
	error,
	isLoading,
	onClose,
	onSelectAgent,
	selectedAgentPath,
}: {
	agents: WorkbenchAgentOption[];
	error: string;
	isLoading: boolean;
	onClose: () => void;
	onSelectAgent: (agentPath: string | null) => void;
	selectedAgentPath: string | null;
}) {
	return (
		<>
			<div className="flex items-center justify-between gap-3">
				<div className="shrink-1">
					<p className="m-0 text-[0.82em] font-semibold uppercase tracking-[0.16em] text-muted">Agents</p>
					<p className="mt-1 mb-0 text-[0.86em] leading-[1.6] text-muted">
						Select a user-invocable agent file for this harness. Codex injects the file as turn instructions; Copilot selects the matching custom agent.
					</p>
				</div>
				<button
					type="button"
					className="shrink-0 self-start rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-1.5 text-[0.78em] font-medium text-text transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
					onClick={onClose}
				>
					Back to message
				</button>
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
							<p className="mt-1 mb-0 break-all text-[0.78em] leading-[1.6] text-muted">{agent.path}</p>
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