/*
 * Exports:
 * - default ThreadModelPicker: model radio cards with favourite actions and an Other disclosure.
 */
"use client";

import { JSX } from "react";
import type { WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";
import { StarIcon, StarOffIcon } from "../workbench-icons";
import { WorkbenchOptionCard } from "../WorkbenchOptionCards";
import WorkbenchIconButton from "../WorkbenchIconButton";
import ThreadDisclosure from "./ThreadDisclosure";

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

	return features;
}

export default function ThreadModelPicker ({
	appliesOnNextTurnOnly,
	unfavouritedModelIds,
	error,
	harness,
	isLoading,
	models,
	onSelectModel,
	onToggleFavourite,
	selectedModelId,
	favouritesDisabled = false,
}: {
	appliesOnNextTurnOnly: boolean;
	unfavouritedModelIds: string[];
	error: string;
	harness: WorkbenchHarness;
	isLoading: boolean;
	models: WorkbenchModelOption[];
	onSelectModel: (model: WorkbenchModelOption) => void;
	onToggleFavourite: (modelId: string) => void;
	selectedModelId: string | null;
	favouritesDisabled?: boolean;
}) {
	const visibleModels = models.filter((model) => model.policyState !== "disabled");
	const topGroup = visibleModels.filter((model) => !unfavouritedModelIds.includes(model.id));
	const bottomGroup = visibleModels.filter((model) => unfavouritedModelIds.includes(model.id));

	const renderModelCard = (model: WorkbenchModelOption, unfavourited: boolean) => {
		const featureList = buildFeatureList(model);
		const isSelected = selectedModelId === model.id;

		return (
				<WorkbenchOptionCard
					key={model.id}
					density="tight"
					className="min-w-0"
					isChecked={isSelected}
					onClick={() => onSelectModel(model)}
					label={<span className="grid gap-1">
						<span>{model.displayName}</span>
						{featureList.length ? <span className="mb-1 flex flex-wrap gap-1.5">
							{featureList.map((feature, index) => <span key={index} className="rounded-full bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-2 py-0.5 text-xs font-medium text-muted">{feature}</span>)}
						</span> : null}
					</span>}
					actions={<WorkbenchIconButton
						size="small"
						disabled={favouritesDisabled}
						label={`${unfavourited ? "Favourite" : "Unfavourite"} ${model.displayName}`}
						onClick={() => onToggleFavourite(model.id)}
					>{unfavourited ? <StarIcon /> : <StarOffIcon />}</WorkbenchIconButton>}
				/>
		);
	};

	return (
		<>
			{appliesOnNextTurnOnly ? <p className="text-xs text-muted">Changes apply to the next new turn.</p> : null}
			{error ? (
				<p className="mt-3 mb-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
			) : null}
			{isLoading ? (
				<p className="mt-3 mb-0 text-[0.84em] leading-[1.6] text-muted">Loading models...</p>
			) : (
				<div className="mt-1 space-y-2">
					<div role="group" aria-label={`${harness} models`} className="grid gap-2">
						{topGroup.map((model) => renderModelCard(model, false))}
					</div>
					{bottomGroup.length ? (
						<ThreadDisclosure summary="Other" contentClassName="pt-1">
							<div role="group" aria-label={`${harness} other models`} className="grid gap-2">
								{bottomGroup.map((model) => renderModelCard(model, true))}
							</div>
						</ThreadDisclosure>
					) : null}
					{!visibleModels.length && !error ? (
						<p className="m-0 text-[0.84em] leading-[1.6] text-muted">No models are available for this harness.</p>
					) : null}
				</div>
			)}
		</>
	);
}
