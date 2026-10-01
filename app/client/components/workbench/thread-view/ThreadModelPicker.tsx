/*
 * Exports:
 * - default ThreadModelPicker: grouped model cards with sticky provider navigation and favourites.
 */
"use client";

import { JSX, useRef, useState } from "react";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";
import { matchesWorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import { ClockIcon, HarnessIcon, StarIcon } from "../workbench-icons";
import WorkbenchIconButton from "../WorkbenchIconButton";
import { WorkbenchOptionCard } from "../WorkbenchOptionCards";
import WorkbenchTag from "../WorkbenchTag";
import type { WorkbenchGroupedModel, WorkbenchModelGroup } from "../workbench-model-groups";
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
	favouriteKeys,
	groups,
	loadingByHarness,
	errorByHarness,
	onSelectModel,
	onToggleFavourite,
	selectedModelId,
	selectedHarness,
	favouritesDisabled = false,
}: {
	appliesOnNextTurnOnly: boolean;
	favouriteKeys: ReadonlySet<string>;
	groups: readonly WorkbenchModelGroup[];
	loadingByHarness: Partial<Record<WorkbenchHarness, boolean>>;
	errorByHarness: Partial<Record<WorkbenchHarness, string>>;
	onSelectModel: (entry: WorkbenchGroupedModel) => void;
	onToggleFavourite: (entry: WorkbenchGroupedModel) => void;
	selectedModelId: string | null;
	selectedHarness: WorkbenchHarness;
	favouritesDisabled?: boolean;
}) {
	const scroll = useRef<HTMLDivElement>(null);
	const clientStateController = useWorkbenchClientStateController();
	const clientState = useWorkbenchClientStateSnapshot();
	const canPersistDisclosures = clientState.schemaVersion >= appStateReleases.modelGroupDisclosures.version;
	const [disclosureError, setDisclosureError] = useState("");
	const disclosureOpen = new Map(clientState.records.flatMap(record =>
		record.kind === "modelGroupDisclosure" ? [[record.groupId, record.open] as const] : []));
	const toggleDisclosure = (groupId: string, open: boolean) => {
		setDisclosureError("");
		void clientStateController.put({ kind: "modelGroupDisclosure", groupId, open }).catch(() => {
			console.warn("Unable to save model section preference.");
			setDisclosureError("Unable to save model section preference. Please try again.");
		});
	};
	const scrollToGroup = (id: string) => {
		const section = [...(scroll.current?.querySelectorAll<HTMLElement>("[data-model-group]") ?? [])]
			.find(candidate => candidate.dataset.modelGroup === id);
		if (scroll.current && section) {
			scroll.current.scrollTop += section.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top;
		}
	};

	const renderModelCard = (entry: WorkbenchGroupedModel, special: boolean) => {
		const { harness, model } = entry;
		const featureList = buildFeatureList(model);
		const isSelected = selectedHarness === harness && selectedModelId !== null
			&& matchesWorkbenchModelOption(model, selectedModelId);
		const favourite = [model.id, ...(model.aliases ?? [])]
			.some(id => favouriteKeys.has(`${harness}\0${id}`));

		return (
			<WorkbenchOptionCard
				key={`${harness}:${model.id}`}
				density="tight"
				className="min-w-0"
				showMarker={false}
				isChecked={isSelected}
				onClick={() => onSelectModel(entry)}
				label={<span className="grid gap-1">
					<span className="inline-flex min-w-0 items-center gap-2">
						{special ? <HarnessIcon harness={harness} size={16} className="shrink-0" /> : null}
						<span className="truncate">{model.displayName}</span>
					</span>
					{featureList.length ? <span className="mb-1 flex flex-wrap gap-1.5">
						{featureList.map((feature, index) => <WorkbenchTag key={index}>{feature}</WorkbenchTag>)}
					</span> : null}
				</span>}
				actions={<WorkbenchIconButton
					size="small"
					disabled={favouritesDisabled}
					label={`${favourite ? "Unfavourite" : "Favourite"} ${model.displayName}`}
					aria-pressed={favourite}
					onClick={() => onToggleFavourite(entry)}
				><StarIcon size={16} className={favourite ? "fill-current" : undefined} /></WorkbenchIconButton>}
			/>
		);
	};

	return (
		<div className="flex min-h-0 flex-col -ml-2 -mt-1 -mr-1">
			{disclosureError ? <p role="alert" className="m-0 px-2 pb-2 text-xs text-danger">{disclosureError}</p> : null}
			<div ref={scroll} className="min-h-0 flex-1 flex items-start gap-2">
				<nav aria-label="Model providers" className="sticky -top-1 flex max-h-full flex-col items-center overflow-y-auto overscroll-contain">
					{groups.filter(group => !group.providerId || group.providerId === "opencode").map(group => <button
						key={group.id}
						type="button"
						aria-label={group.label}
						title={group.label}
						className="enabled:cursor-pointer flex size-9 shrink-0 items-center justify-center rounded-lg text-fg/muted hover:bg-button-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
						onClick={() => scrollToGroup(group.id)}
					>
						{group.kind === "favourites" ? <StarIcon size={20} />
							: group.kind === "recent" ? <ClockIcon size={20} />
								: <HarnessIcon harness={group.harness!} size={20} />}
					</button>)}
				</nav>
				<div className="min-w-0 flex-grow">
					{groups.map(group => <ThreadDisclosure key={group.id}
						data-model-group={group.id}
						role="group" aria-label={group.label}
						className="pb-3"
						defaultOpen={true}
						open={canPersistDisclosures ? disclosureOpen.get(group.id) ?? true : undefined}
						onToggle={canPersistDisclosures ? event => {
							const open = event.currentTarget.open;
							if (open !== (disclosureOpen.get(group.id) ?? true)) toggleDisclosure(group.id, open);
						} : undefined}
						summary={<div className="flex items-center gap-2 py-2 text-[0.68rem] font-semibold uppercase tracking-widest text-fg/muted">
							<span>{group.label}</span><span className="h-px min-w-2 flex-1 bg-[color-mix(in_srgb,var(--text)_12%,transparent)]" />
						</div>}
					>
						{group.models.length ? <div className="grid gap-2">
							{group.models.map(entry => renderModelCard(entry, group.kind !== "provider"))}
						</div> : group.harness && loadingByHarness[group.harness] ? <p role="status" className="m-0 text-xs text-fg/muted">Loading models...</p>
							: group.harness && errorByHarness[group.harness] ? <p role="alert" className="m-0 text-xs text-danger">{errorByHarness[group.harness]}</p>
								: <p className="m-0 text-xs text-fg/muted">No models here yet.</p>}
					</ThreadDisclosure>)}
				</div>
			</div>
		</div>
	);
}
