/*
 * Exports:
 * - default ThreadAgentPicker: agent radio cards with descriptions and catalogue status.
 */
"use client";
import type { WorkbenchAgentOption } from "workbench-shared/types";
import { WorkbenchOptionCard } from "../WorkbenchOptionCards";

export default function ThreadAgentPicker ({
	agents,
	error,
	isLoading,
	onSelectAgent,
	selectedAgentPath,
}: {
	agents: WorkbenchAgentOption[];
	error: string;
	isLoading: boolean;
	onSelectAgent: (agentPath: string | null) => void;
	selectedAgentPath: string | null;
}) {
	return (
		<>
			{error ? (
				<p className="mt-3 mb-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
			) : null}
			{isLoading ? (
				<p className="mt-3 mb-0 text-[0.84em] leading-[1.6] text-muted">Loading agents...</p>
			) : (
				<div className="mt-1 grid gap-2">
					<WorkbenchOptionCard density="tight" isChecked={selectedAgentPath === null} label="Default agent" onClick={() => onSelectAgent(null)} />
					{agents.map((agent) => (
						<WorkbenchOptionCard
							key={agent.path}
							density="tight"
							isChecked={selectedAgentPath === agent.path}
							onClick={() => onSelectAgent(agent.path)}
							label={<span className="grid gap-1">
								<span>{agent.name}</span>
								<span className="break-all text-[0.9em] font-normal leading-[1.6] text-muted">{agent.sourceLabel ? `${agent.sourceLabel} - ` : ""}{agent.path}</span>
								{agent.description ? <span className="whitespace-pre-wrap text-[0.9em] font-normal leading-[1.6] text-muted">{agent.description}</span> : null}
							</span>}
						/>
					))}
					{!agents.length && !error ? (
						<p className="m-0 text-[0.84em] leading-[1.6] text-muted">No user-invocable agent files are available in this workspace.</p>
					) : null}
				</div>
			)}
		</>
	);
}
