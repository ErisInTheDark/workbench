/*
 * Exports:
 * - default ThreadUserInputRequest: render full or compact questionnaires, including loading, live answers, previews, and history.
 * Local components bind a keyed editing session and render approval command context.
 */
"use client";

import { useMemo, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";

import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import type {
  WorkbenchQuestionnaireDraft,
  WorkbenchSkillSummary,
  WorkbenchThreadComposerAttachmentDraft,
  WorkbenchUserInputQuestion,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "workbench-shared/types";
import { readClipboardImageDataUrls } from "../../../workbench/dom/clipboard";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import {
  buildInlineMentionHighlights,
  getActivatedWorkbenchSkillPathsForTextValues,
  type InlineMentionHighlightSources,
} from "../../../workbench/thread/inline-mention-highlights";
import { getThreadCommandDisplay } from "../../../workbench/thread/thread-command-matchers";
import {
  hasWorkbenchApprovalDecisionSelection,
  isWorkbenchApprovalDecisionQuestion,
  isWorkbenchApprovalRequest,
} from "workbench-shared/workbench/thread/thread-user-input-requests";
import PrimaryButton from "../PrimaryButton";
import { FeatherIcon, SendHorizontalIcon, XIcon } from "../workbench-icons";
import { WorkbenchOptionCard } from "../WorkbenchOptionCards";
import PlaintextEditable from "./PlaintextEditable";
import ThreadLightboxImage from "./ThreadLightboxImage";
import { isMobileTextInputEnvironment } from "./mobile-text-input-environment";
import { formatQuestionDisplay, shouldUseCompactSingleQuestionDisplay } from "./thread-user-input-request-preview";
import { getQuestionnaireTitle } from "workbench-shared/workbench/thread/thread-questionnaire-transcript";
import { ThreadCommandSummary } from "./thread-view-primitives";
import type { DraftUpdate } from "./DraftSessionController";
import { useDraftSession } from "./use-draft-session";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const EMPTY_HISTORY_CUSTOM_TEXT_SPACER_CLASS = "w-full min-h-[2.45rem] rounded-lg px-3 py-2";
const APPROVAL_OPTION_REQUIRED_MESSAGE = "Choose one of the approval options before submitting.";

function deriveAnsweredValues (
  question: WorkbenchUserInputQuestion,
  response: WorkbenchUserInputResponse | null,
) {
  const answers = response?.answers[question.id]?.answers ?? [];
  const optionLabels = new Set(question.options.map((option) => option.label));
  const matchedOptions = answers.filter((answer) => optionLabels.has(answer));
  const unmatchedAnswers = answers.filter((answer) => !optionLabels.has(answer));

  return {
    customValue: unmatchedAnswers.join("\n\n"),
    selectedValues: matchedOptions,
  };
}

const emptyQuestionnaireDraft = (): WorkbenchQuestionnaireDraft => ({
  attachments: [], customValues: {}, selectedValues: {}, updatedAt: 0,
});

function isSingleChoiceQuestion (
  request: WorkbenchUserInputRequest,
  question: WorkbenchUserInputQuestion,
) {
  if (request.approval) {
    return true;
  }

  return isWorkbenchApprovalDecisionQuestion(question);
}

type InteractiveThreadUserInputRequestProps = {
  actions?: ReactNode;
  draft: WorkbenchQuestionnaireDraft | null;
  highlightSources?: InlineMentionHighlightSources;
  knownSkills?: WorkbenchSkillSummary[];
  leadingActions?: ReactNode;
  mode: "live";
  onDraftChange: (update: DraftUpdate<WorkbenchQuestionnaireDraft>) => Promise<WorkbenchQuestionnaireDraft> | WorkbenchQuestionnaireDraft;
  onDraftClear: () => Promise<void> | void;
  onSubmit: (
    response: WorkbenchUserInputResponse,
    supplementalInput?: UserInput[],
    activatedSkillPaths?: string[],
  ) => Promise<void>;
  presentation?: "compact" | "full";
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  request: WorkbenchUserInputRequest;
  spellCheck: boolean;
};

type HistoryThreadUserInputRequestProps = {
  highlightSources?: InlineMentionHighlightSources;
  knownSkills?: WorkbenchSkillSummary[];
  mode: "history";
  presentation?: "compact" | "full";
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  request: WorkbenchUserInputRequest;
  response: WorkbenchUserInputResponse | null;
  statusLabel?: string;
};

type PreviewThreadUserInputRequestProps = {
  draft: WorkbenchQuestionnaireDraft | null;
  highlightSources?: InlineMentionHighlightSources;
  knownSkills?: WorkbenchSkillSummary[];
  mode: "preview";
  presentation?: "compact" | "full";
  projectRootPath?: string;
  request: WorkbenchUserInputRequest;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
};

type ThreadUserInputRequestProps = (
  | HistoryThreadUserInputRequestProps
  | InteractiveThreadUserInputRequestProps
  | PreviewThreadUserInputRequestProps
) & {
  contentClassName?: string;
};

type LoadingThreadUserInputRequestProps = {
  contentClassName?: string;
  mode: "loading";
  presentation?: "compact" | "full";
};

function ThreadUserInputRequestFrame({
  children,
  compact,
  loading = false,
}: {
  children: ReactNode;
  compact: boolean;
  loading?: boolean;
}) {
  return (
    <div
      aria-busy={loading || undefined}
      aria-label={loading ? "Loading questionnaire" : undefined}
      role={loading ? "status" : undefined}
      className={joinClasses("thread-user-input-request px-1 py-1", compact ? "space-y-2" : "space-y-4")}
      data-thread-user-input-presentation={compact ? "compact" : "full"}
    >
      {children}
    </div>
  );
}

function ThreadApprovalCommandSummary ({
  knownSkills,
  projectRootPath,
  request,
  workspaceRoots,
}: {
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  request: WorkbenchUserInputRequest;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const commandContext = request.approval?.command ?? null;
  const display = useMemo(() => (
    commandContext
      ? getThreadCommandDisplay({
        command: commandContext.command,
        commandActions: commandContext.commandActions,
        cwd: commandContext.cwd,
        knownSkills,
        projectRootPath,
        workspaceRoots,
      })
      : null
  ), [commandContext, knownSkills, projectRootPath, workspaceRoots]);

  if (!display || display.omitFromDisplay || display.summaryKind !== "matched") {
    return null;
  }

  return (
    <div className="rounded-lg bg-[color-mix(in_srgb,var(--text)_4%,transparent)] [--approval-summary-fg-bg:color-mix(in_srgb,var(--text)_4%,var(--fg-bg,var(--bg)))] px-3 py-2.5">
      <p className="m-0 text-[0.72em] font-semibold tracking-[0.08em] [color:color-mix(in_srgb,var(--text)_var(--muted-strength),var(--approval-summary-fg-bg))] uppercase">
        Matched action
      </p>
      <p className="mt-1 mb-0 min-w-0 text-[0.92em] leading-[1.65] text-text">
        <ThreadCommandSummary display={display} />
      </p>
    </div>
  );
}

export default function ThreadUserInputRequest (props: ThreadUserInputRequestProps | LoadingThreadUserInputRequestProps) {
  if (props.mode === "loading") {
    const compact = props.presentation === "compact";
    return (
      <ThreadUserInputRequestFrame compact={compact} loading>
        <div className={joinClasses("thread-user-input-request-content", compact ? "space-y-2.5" : "space-y-4", props.contentClassName)} aria-hidden="true">
          <div className="space-y-1 text-[1.02em] leading-[1.35]">
            <div className="h-[1.35em] w-4/5 rounded workbench-skeleton" />
            <div className="h-[1.35em] w-1/2 rounded workbench-skeleton" />
          </div>
          <div className="flex items-center gap-2">
            <div className="min-h-[2.45rem] min-w-0 flex-1 rounded-lg workbench-skeleton" />
            <div className="size-8 shrink-0 rounded-full workbench-skeleton" />
          </div>
        </div>
      </ThreadUserInputRequestFrame>
    );
  }
  return <ThreadUserInputRequestContent key={`${props.mode}:${props.request.id}`} {...props} />;
}

function ThreadUserInputRequestContent (props: ThreadUserInputRequestProps) {
  const { mode, request } = props;
  const isHistoryMode = mode === "history";
  const isPreviewMode = mode === "preview";
  const isInteractiveMode = mode === "live";
  const isReadOnlyMode = isHistoryMode || isPreviewMode;
  const compact = props.presentation === "compact";
  const useCompactSingleQuestionDisplay = shouldUseCompactSingleQuestionDisplay(request);
  const requestTitle = getQuestionnaireTitle(request);
  const requestSummary = useCompactSingleQuestionDisplay ? "" : request.summary.trim();
  const historyProps = mode === "history" ? props : null;
  const previewProps = mode === "preview" ? props : null;
  const interactiveProps = isInteractiveMode ? props : null;
  const highlightSources = props.highlightSources;
  const interactiveDraft = interactiveProps?.draft ?? null;
  const quickResponseQuestion = isInteractiveMode
    && !request.approval
    && request.questions.length === 1
    && request.questions[0]?.options.length === 1
    ? request.questions[0]
    : null;
  const initialDraft = useMemo(() => emptyQuestionnaireDraft(), []);
  const editing = useDraftSession(interactiveDraft ?? initialDraft, {
    empty: emptyQuestionnaireDraft,
    save: (update) => interactiveProps
      ? interactiveProps.onDraftChange(update)
      : update(initialDraft),
  });
  const { selectedValues, customValues, attachments } = editing.draft;
  const [isQuickResponseCustomInputRequested, setIsQuickResponseCustomInputRequested] = useState(false);
  const [localError, setError] = useState("");
  const error = localError || editing.error;
  const { isSubmitting, isAttaching } = editing;
  const hasCustomResponseContent = Object.values(customValues).some((value) => value.trim())
    || attachments.length > 0;
  const useQuickResponseLayout = Boolean(
    quickResponseQuestion
    && !isQuickResponseCustomInputRequested
    && !hasCustomResponseContent,
  );

  const resetAnswers = () => {
    void editing.session.reset();
    setError("");
  };

  const submitResponse = async (
    response: WorkbenchUserInputResponse,
    responseAttachments: WorkbenchThreadComposerAttachmentDraft[],
    responseCustomValues: Record<string, string>,
  ) => {
    if (!interactiveProps || isSubmitting || isAttaching) {
      return;
    }

    if (isWorkbenchApprovalRequest(request) && !hasWorkbenchApprovalDecisionSelection(request, response)) {
      setError(APPROVAL_OPTION_REQUIRED_MESSAGE);
      return;
    }

    const supplementalInput: UserInput[] = responseAttachments.map((attachment) => ({
      type: "image",
      url: attachment.url,
    }));
    const activatedSkillPaths = highlightSources
      ? getActivatedWorkbenchSkillPathsForTextValues(Object.values(responseCustomValues), highlightSources)
      : [];
    setError("");
    await editing.session.submit(async () => {
      await interactiveProps.onSubmit(
        response,
        supplementalInput.length ? supplementalInput : undefined,
        activatedSkillPaths.length ? activatedSkillPaths : undefined,
      );
      try {
        await interactiveProps.onDraftClear();
      } catch (error) {
        editing.session.reportError(error, "The answer was sent, but its draft could not be cleared.");
      }
      return true;
    });
  };

  const handleSubmit = async () => {
    const answers: WorkbenchUserInputResponse["answers"] = {};
    for (const question of request.questions) {
      const selectedQuestionValues = selectedValues[question.id] ?? [];
      const customValue = customValues[question.id]?.trim();

      answers[question.id] = {
        answers: [
          ...selectedQuestionValues,
          ...(customValue ? [customValue] : []),
        ],
      };
    }

    await submitResponse({ answers }, attachments, customValues);
  };

  const handleQuickResponse = async (
    question: WorkbenchUserInputQuestion,
    optionLabel: string,
  ) => {
    await submitResponse({
      answers: {
        [question.id]: {
          answers: [optionLabel],
        },
      },
    }, [], {});
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!interactiveProps) {
      return;
    }

    const hasImage = Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"));
    if (!hasImage) {
      return;
    }

    event.preventDefault();
    setError("");
    void editing.session.attachImages(() => readClipboardImageDataUrls(event.clipboardData.items));
  };

  const handleLastQuestionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactiveProps || isSubmitting || isAttaching || event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) {
      return;
    }

    if (isMobileTextInputEnvironment()) {
      return;
    }

    event.preventDefault();
    void handleSubmit();
  };
  const renderSubmitButton = () => (
    <PrimaryButton
      type="button"
      data-thread-questionnaire-submit="true"
      onClick={() => {
        void handleSubmit();
      }}
      disabled={isSubmitting || isAttaching}
      className="justify-self-end"
      shape="circle"
      aria-label={isSubmitting ? "Submitting..." : isAttaching ? "Attaching..." : "Submit"}
      title={isSubmitting ? "Submitting..." : isAttaching ? "Attaching..." : "Submit"}
      pendingHalo={isSubmitting || isAttaching}
    >
      <SendHorizontalIcon size={20} />
    </PrimaryButton>
  );

  return (
    <ThreadUserInputRequestFrame compact={compact}>
      <div className={joinClasses("thread-user-input-request-content", compact ? "space-y-2.5" : "space-y-4", props.contentClassName)}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="space-y-1">
              <h3 className="m-0 text-[1.02em] font-semibold leading-[1.35] text-text">
                {requestTitle}
              </h3>
              {requestSummary ? (
                <p className="m-0 max-w-3xl text-[0.88em] leading-[1.7] text-fg/muted">
                  {requestSummary}
                </p>
              ) : null}
            </div>
          </div>
          {isHistoryMode ? (
            historyProps?.statusLabel ? (
              <p className="m-0 text-[0.76em] font-medium leading-[1.6] text-fg/muted">{historyProps.statusLabel}</p>
            ) : null
          ) : (
            <>{/*
          <button
            type="button"
            onClick={() => {
              resetAnswers();
            }}
            className="rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-2 text-[0.76em] font-medium text-text transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          >
            Clear answers
              </button>
              */}</>
          )}
        </div>

        <ThreadApprovalCommandSummary
          knownSkills={props.knownSkills}
          projectRootPath={props.projectRootPath}
          request={request}
          workspaceRoots={props.workspaceRoots}
        />

        <div className="space-y-3">
          {request.questions.map((question, index) => {
            const isLastQuestion = index === request.questions.length - 1;
            const { headerText, questionText } = formatQuestionDisplay(question, index);
            const answerValues = isHistoryMode
              ? deriveAnsweredValues(question, historyProps?.response ?? null)
              : isPreviewMode ? {
                customValue: previewProps?.draft?.customValues[question.id] ?? "",
                selectedValues: previewProps?.draft?.selectedValues[question.id] ?? [],
              } : {
                customValue: customValues[question.id] ?? "",
                selectedValues: selectedValues[question.id] ?? [],
              };
            const selectedQuestionValues = answerValues.selectedValues;
            const customValue = answerValues.customValue;
            const isSingleChoice = isSingleChoiceQuestion(request, question);
            const customValueHighlights = highlightSources
              ? buildInlineMentionHighlights(customValue, highlightSources)
              : [];
            const quickResponseOption = quickResponseQuestion?.id === question.id
              ? quickResponseQuestion.options[0] ?? null
              : null;
            const isSoleFreeformQuestion = isInteractiveMode
              && request.questions.length === 1
              && question.options.length === 0;
            const showQuestionHeader = request.questions.length !== 1;
            const showQuestionText = Boolean(questionText)
              && (showQuestionHeader || questionText !== requestTitle.trim());

            return (
              <section
                key={question.id}
                className="mb-0"
              >
                {showQuestionHeader || showQuestionText ? (
                  <div className="space-y-1">
                    {showQuestionHeader ? (
                      <p className="m-0 text-[0.72em] font-semibold tracking-[0.08em] text-fg/muted uppercase">
                        {headerText}
                      </p>
                    ) : null}
                    {showQuestionText ? (
                      <p className="m-0 whitespace-pre-wrap break-words text-[0.92em] leading-[1.65] text-text">
                        {questionText}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <div className={compact ? "mt-2 space-y-0.5" : "mt-3 space-y-2"}>
                  {useQuickResponseLayout && quickResponseOption ? (
                    <div className="flex items-stretch gap-2">
                      <WorkbenchOptionCard
                        className="min-w-0 flex-1"
                        description={quickResponseOption.description}
                        disabled={isSubmitting || isAttaching}
                        isChecked={selectedQuestionValues.includes(quickResponseOption.label)}
                        isSingleChoice={false}
                        label={quickResponseOption.label}
                        presentation={compact ? "compact-card" : "card"}
                        showMarker={false}
                        onClick={() => {
                          void handleQuickResponse(question, quickResponseOption.label);
                        }}
                      />
                      <WorkbenchOptionCard
                        ariaLabel="Write a custom response"
                        className={joinClasses(
                          "shrink-0 self-stretch !items-center justify-center",
                          compact ? "!w-10 !px-2" : "!w-16 !px-3",
                        )}
                        disabled={isSubmitting || isAttaching}
                        isChecked={false}
                        isSingleChoice={false}
                        label={(
                          <FeatherIcon size={compact ? 20 : 32} />
                        )}
                        presentation={compact ? "compact-card" : "card"}
                        showMarker={false}
                        onClick={() => {
                          setIsQuickResponseCustomInputRequested(true);
                          if (error) {
                            setError("");
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <>
                      {question.options.map((option, index) => {
                        const optionId = `${request.id}:${question.id}:option:${index}`;
                        const isChecked = selectedQuestionValues.includes(option.label);

                        if (isReadOnlyMode) {
                          return (
                            <WorkbenchOptionCard
                              key={optionId}
                              description={option.description}
                              isChecked={isChecked}
                              isHistoryMode
                              isSingleChoice={isSingleChoice}
                              label={option.label}
                              markerId={optionId}
                              presentation={compact ? "compact-inline" : "card"}
                            />
                          );
                        }

                        return (
                          <WorkbenchOptionCard
                            key={optionId}
                            disabled={isSubmitting}
                            description={option.description}
                            isChecked={isChecked}
                            isSingleChoice={isSingleChoice}
                            label={option.label}
                            markerId={optionId}
                            presentation={compact ? "compact-inline" : "card"}
                            onClick={() => {
                              const values = isChecked
                                ? selectedQuestionValues.filter((value) => value !== option.label)
                                : isSingleChoice ? [option.label] : [...selectedQuestionValues, option.label];
                              editing.session.edit((draft) => {
                                const next = { ...draft.selectedValues };
                                if (values.length) next[question.id] = values;
                                else delete next[question.id];
                                return { ...draft, selectedValues: next };
                              });
                              if (error) {
                                setError("");
                              }
                            }}
                          />
                        );
                      })}
                      {isReadOnlyMode ? (
                        customValue ? (
                          <PlaintextEditable
                            id={`${request.id}:${question.id}:custom`}
                            ariaLabel={`${headerText} answer`}
                            className="thread-plaintext-editable min-h-[2.45rem] w-full rounded-lg bg-[color-mix(in_srgb,var(--text)_4%,transparent)] [--editable-fg-bg:color-mix(in_srgb,var(--text)_4%,var(--fg-bg,var(--bg)))] px-3 py-3 text-[0.84em] leading-[1.5] text-text outline-none"
                            readOnly
                            spellCheck={false}
                            highlights={customValueHighlights}
                            value={customValue}
                          />
                        ) : (
                          !isLastQuestion ? (
                            <div
                              aria-hidden="true"
                              className={EMPTY_HISTORY_CUSTOM_TEXT_SPACER_CLASS}
                            />
                          ) : null
                        )
                      ) : compact && isLastQuestion ? (
                        <div
                          className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 [&:has([data-empty=false])]:grid-cols-1"
                          data-thread-questionnaire-custom-layout="compact-flow"
                        >
                          <PlaintextEditable
                            id={`${request.id}:${question.id}:custom`}
                            ariaLabel={`${headerText} answer`}
                            autoFocus={isSoleFreeformQuestion || isQuickResponseCustomInputRequested}
                            className="thread-plaintext-editable min-h-8 w-full rounded-lg bg-[color-mix(in_srgb,var(--text)_4%,transparent)] [--editable-fg-bg:color-mix(in_srgb,var(--text)_4%,var(--fg-bg,var(--bg)))] px-2.5 py-1.5 text-[0.82em] leading-[1.45] text-text outline-none"
                            placeholder={isSoleFreeformQuestion ? "Write a response" : undefined}
                            spellCheck={!question.isSecret && (interactiveProps?.spellCheck ?? false)}
                            highlights={customValueHighlights}
                            mentionSources={highlightSources}
                            mentionSuggestionsPlacement="below"
                            disabled={isSubmitting}
                            value={customValue}
                            onChange={(nextValue) => {
                              editing.session.edit((draft) => ({
                                ...draft,
                                customValues: { ...draft.customValues, [question.id]: nextValue },
                              }));
                              if (error) {
                                setError("");
                              }
                            }}
                            onKeyDown={handleLastQuestionKeyDown}
                            onPaste={handlePaste}
                          />
                          {renderSubmitButton()}
                        </div>
                      ) : (
                        <PlaintextEditable
                          id={`${request.id}:${question.id}:custom`}
                          ariaLabel={`${headerText} answer`}
                          autoFocus={isSoleFreeformQuestion || isQuickResponseCustomInputRequested}
                          className={joinClasses(
                            "thread-plaintext-editable min-h-[2.45rem] w-full rounded-lg px-3 py-2 text-[0.84em] leading-[1.5] text-text outline-none transition",
                            customValue || isSoleFreeformQuestion
                              ? "bg-[color-mix(in_srgb,var(--text)_4%,transparent)] [--editable-fg-bg:color-mix(in_srgb,var(--text)_4%,var(--fg-bg,var(--bg)))] py-3 mt-1 mb-3"
                              : `
                              hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:[--editable-fg-bg:color-mix(in_srgb,var(--text)_4%,var(--fg-bg,var(--bg)))] hover:py-3 hover:mb-3
                              focus-visible:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:[--editable-fg-bg:color-mix(in_srgb,var(--text)_4%,var(--fg-bg,var(--bg)))] focus-visible:py-3 focus-visible:mt-1 focus-visible:mb-3
                            `,
                          )}
                          placeholder={isSoleFreeformQuestion ? "Write a response" : undefined}
                          spellCheck={!question.isSecret && (interactiveProps?.spellCheck ?? false)}
                          highlights={customValueHighlights}
                          mentionSources={highlightSources}
                          mentionSuggestionsPlacement="below"
                          disabled={isSubmitting}
                          value={customValue}
                          onChange={(nextValue) => {
                            editing.session.edit((draft) => ({
                              ...draft,
                              customValues: { ...draft.customValues, [question.id]: nextValue },
                            }));
                            if (error) {
                              setError("");
                            }
                          }}
                          onKeyDown={isLastQuestion ? handleLastQuestionKeyDown : undefined}
                          onPaste={handlePaste}
                        />
                      )}
                    </>
                  )}
                </div>
              </section>
            );
          })}
        </div>
        {!isHistoryMode && ((isPreviewMode ? previewProps?.draft?.attachments.length : attachments.length) || isAttaching) ? (
          <div className="space-y-2">
            {(isPreviewMode ? previewProps?.draft?.attachments ?? [] : attachments).length ? (
              <div className="flex flex-wrap gap-3">
                {(isPreviewMode ? previewProps?.draft?.attachments ?? [] : attachments).map((attachment, index) => (
                  <div key={attachment.id} className={joinClasses("relative", compact ? "h-16 w-16" : "h-24 w-24")}>
                    <ThreadLightboxImage
                      alt={`Questionnaire attached image ${index + 1}`}
                      buttonClassName="h-full w-full rounded-[0.95rem]"
                      imageClassName="h-full w-full object-cover"
                      src={attachment.url}
                    />
                    {!isPreviewMode ? <button
                      type="button"
                      disabled={isSubmitting}
                      aria-label={`Remove questionnaire attached image ${index + 1}`}
                      title="Remove attached image"
                      className="absolute top-1.5 right-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] text-text shadow-sm transition hover:bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                      onClick={() => {
                        editing.session.edit((draft) => ({
                          ...draft,
                          attachments: draft.attachments.filter((currentAttachment) => currentAttachment.id !== attachment.id),
                        }));
                      }}
                    >
                      <XIcon size={14} />
                    </button> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {isAttaching && !isPreviewMode ? (
              <p className="m-0 text-[0.78em] leading-[1.6] text-fg/muted">Attaching pasted image...</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {interactiveProps && (!compact || interactiveProps.leadingActions || interactiveProps.actions) ? (
        <div className="thread-user-input-request-actions flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {interactiveProps?.leadingActions}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {!compact && !useQuickResponseLayout ? renderSubmitButton() : null}
            {interactiveProps?.actions}
          </div>
        </div>
      ) : null}

      {interactiveProps && error ? (
        <p className="m-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
      ) : null}
    </ThreadUserInputRequestFrame>
  );
}
