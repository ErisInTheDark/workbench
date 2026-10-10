/*
 * Exports:
 * - Option: one selectable choice card inside Choices, at any depth; its children preview the choice.
 * - default Choices: single or multiple selection over its Options, sent to the agent as `{ name, value }` by a submit button.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { OptionCard } from "../ui/OptionCards";
import PrimaryButton from "../ui/PrimaryButton";
import { useVisAnswer } from "./vis-bridge";

interface ChoicesState {
  multiple: boolean;
  selected: readonly string[];
  toggle(value: string): void;
}

const ChoicesContext = createContext<ChoicesState | null>(null);

function sameSelection(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export default function Choices({ children, multiple = false, name, submitLabel = "Send choice" }: {
  children: ReactNode;
  multiple?: boolean;
  /** The answer's name, so one vis can ask several questions. */
  name: string;
  submitLabel?: string;
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const answer = useVisAnswer<string | readonly string[]>(name);
  const toggle = (value: string) => setSelected(current => !multiple
    ? [value]
    : current.includes(value) ? current.filter(entry => entry !== value) : [...current, value]);
  const sentSelection = answer.sent === null ? null : typeof answer.sent.value === "string" ? [answer.sent.value] : answer.sent.value;
  const isSent = sentSelection !== null && sameSelection(sentSelection, selected);
  return (
    <ChoicesContext.Provider value={{ multiple, selected, toggle }}>
      <div aria-label={name} className="flex flex-col gap-3" role={multiple ? "group" : "radiogroup"}>
        {children}
        <div className="flex items-center gap-3">
          <PrimaryButton disabled={!selected.length} onClick={() => answer.send(multiple ? selected : selected[0]!)}>
            {submitLabel}
          </PrimaryButton>
          {isSent ? <span className="text-sm text-fg/muted">Sent to the agent</span> : null}
        </div>
      </div>
    </ChoicesContext.Provider>
  );
}

export function Option({ children, description, title, value }: {
  children?: ReactNode;
  description?: string;
  title: ReactNode;
  value: string;
}) {
  const choices = useContext(ChoicesContext);
  if (!choices) throw new Error("Option must be inside Choices.");
  return (
    <OptionCard
      description={description}
      isChecked={choices.selected.includes(value)}
      isSingleChoice={!choices.multiple}
      label={title}
      onClick={() => choices.toggle(value)}
    >
      {children}
    </OptionCard>
  );
}
