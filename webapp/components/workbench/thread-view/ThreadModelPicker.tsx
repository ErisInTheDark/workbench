"use client";

/*
 * Exports:
 * - default ThreadModelPicker: render model selection, priority, refresh, and return-to-message controls for a thread composer. Keywords: thread, model, picker, refresh.
 * - Local helpers: format model context windows, feature pills, harness labels, and model priority arrows. Keywords: model metadata, harness, priority.
 */
import { JSX, type KeyboardEvent } from "react";
import type { WorkbenchHarness, WorkbenchModelOption } from "../../../lib/types";
import { PanelCloseIcon, ReloadIcon } from "../workbench-icons";

const pickerIconButtonClassName = "inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] text-muted transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[color-mix(in_srgb,var(--text)_10%,transparent)] disabled:hover:bg-transparent disabled:hover:text-muted";

function formatContextWindow (tokens: number | null) {
	if (!tokens) {
		return null;
	}

	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}

	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}k`;
	}

	return `${tokens}`;
}

function buildFeatureList (model: WorkbenchModelOption) {
	const features: (string | JSX.Element)[] = [];

	if (model.billingMultiplier !== undefined && model.billingMultiplier !== null) {
		features.push(<span className={
			model.billingMultiplier === 0 ? "text-blue-400"
				: model.billingMultiplier < 0.5 ? "text-green-400"
					: model.billingMultiplier <= 1 ? "text-yellow-500"
						: "text-rose-500"
		}>{model.billingMultiplier}x</span>);
	}

	const contextWindow = formatContextWindow(model.maxContextWindowTokens);
	if (contextWindow) {
		features.push(contextWindow);
	}

	if (model.isDefault) {
		features.push("Default");
	}
	if (model.supportsVision) {
		features.push("Vision");
	}
	if (model.supportsReasoningEffort) {
		features.push(`Effort`);
	}
	if (model.supportsPersonality) {
		features.push("Personality");
	}

	// if (model.additionalSpeedTiers.length) {
	// 	features.push(`Speed tiers: ${model.additionalSpeedTiers.join(", ")}`);
	// }

	return features;
}

function formatHarnessLabel (harness: WorkbenchHarness) {
	switch (harness) {
		case "copilot":
			return "Copilot";
		case "opencode":
			return "OpenCode";
		case "codex":
			return "Codex";
	}
}

function DownArrowIcon () {
	return (
		<svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
			<path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
		</svg>
	);
}

function UpArrowIcon () {
	return (
		<svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
			<path d="M4 9.5L8 5.5L12 9.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
		</svg>
	);
}

export default function ThreadModelPicker ({
	appliesOnNextTurnOnly,
	deprioritizedModelIds,
	error,
	harness,
	isLoading,
	isRefreshDisabled,
	isRefreshing,
	models,
	onClose,
	onRefresh,
	onSelectModel,
	onToggleModelPriority,
	selectedModelId,
}: {
	appliesOnNextTurnOnly: boolean;
	deprioritizedModelIds: string[];
	error: string;
	harness: WorkbenchHarness;
	isLoading: boolean;
	isRefreshDisabled: boolean;
	isRefreshing: boolean;
	models: WorkbenchModelOption[];
	onClose: () => void;
	onRefresh: () => void;
	onSelectModel: (model: WorkbenchModelOption) => void;
	onToggleModelPriority: (modelId: string) => void;
	selectedModelId: string | null;
}) {
	const visibleModels = models.filter((model) => model.policyState !== "disabled");
	const topGroup = visibleModels.filter((model) => !deprioritizedModelIds.includes(model.id));
	const bottomGroup = visibleModels.filter((model) => deprioritizedModelIds.includes(model.id));
	const harnessLabel = formatHarnessLabel(harness);

	const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, model: WorkbenchModelOption) => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}

		event.preventDefault();
		onSelectModel(model);
	};

	const renderModelCard = (model: WorkbenchModelOption, deprioritized: boolean) => {
		const featureList = buildFeatureList(model);
		const isSelected = selectedModelId === model.id;

		return (
			<div
				key={model.id}
				role="radio"
				aria-checked={isSelected}
				tabIndex={0}
				className={[
					"rounded-[1rem] border px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
					isSelected
						? "border-text bg-[color-mix(in_srgb,var(--text)_6%,transparent)]"
						: "border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_98%,transparent)] hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]",
					deprioritized && "opacity-55",
				].filter(Boolean).join(" ")}
				onClick={() => {
					onSelectModel(model);
				}}
				onKeyDown={(event) => {
					handleCardKeyDown(event, model);
				}}
			>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<p className="m-0 flex items-center gap-3 text-[0.96em] font-semibold text-text">
							<span>{model.displayName}</span>
							{featureList.length ? (
								<span className="inline-flex flex-wrap gap-2 text-[0.76em] leading-[1.5] text-muted">
									{featureList.map((feature, index) => (
										<span
											key={index}
											className="rounded-full bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-2.5 py-1"
										>
											{feature}
										</span>
									))}
								</span>
							) : null}
						</p>
						{model.description ? (
							<p className="mt-1 mb-0 text-[0.7em] leading-[1.7] text-muted">{model.description}</p>
						) : null}
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] text-muted transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
							aria-label={deprioritized ? `Move ${model.displayName} back to the top group` : `Move ${model.displayName} to the bottom group`}
							onClick={(event) => {
								event.stopPropagation();
								onToggleModelPriority(model.id);
							}}
						>
							{deprioritized ? <UpArrowIcon /> : <DownArrowIcon />}
						</button>
					</div>
				</div>
			</div>
		);
	};

	return (
		<>
			<div className="flex items-center justify-between gap-3">
				<div className="shrink-1">
					<p className="m-0 text-[1.2em] font-semibold text-muted">
						Choose a {harnessLabel} model
					</p>
					{appliesOnNextTurnOnly ? (
						<p className="-mt-1 mb-0 text-[0.78em] leading-[1.6] text-muted">
							Changes apply to the next new turn.
						</p>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-2 self-start">
					<button
						type="button"
						aria-label={isRefreshing ? "Refreshing models" : "Refresh models"}
						title={isRefreshing ? "Refreshing models" : "Refresh models"}
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
				<p className="mt-3 mb-0 text-[0.84em] leading-[1.6] text-muted">Loading models...</p>
			) : (
				<div className="mt-3 space-y-4">
					<div role="radiogroup" aria-label={`${harness} models`} className="grid gap-3">
						{topGroup.map((model) => renderModelCard(model, false))}
					</div>
					{bottomGroup.length ? (
						<div className="space-y-3">
							<div role="radiogroup" aria-label={`${harness} deprioritized models`} className="grid gap-3">
								{bottomGroup.map((model) => renderModelCard(model, true))}
							</div>
						</div>
					) : null}
					{!visibleModels.length && !error ? (
						<p className="m-0 text-[0.84em] leading-[1.6] text-muted">No models are available for this harness.</p>
					) : null}
				</div>
			)}
		</>
	);
}
