/*
 * Exports:
 * - Option: one option of an Options set; its children are that option's full-size preview.
 * - default Options: tabs over its direct Option children, showing one full-size preview at a time. The shown option is
 *   synced state (control id `id`, else `label`), so the user's pick survives the agent's edits and `wb vis read` returns it.
 */
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import Tabs, { Tab } from "../ui/Tabs";
import { useVisState } from "./vis-bridge";

interface OptionProps {
  children?: ReactNode;
  title: ReactNode;
  /** What `wb vis read` reports when this option is picked; defaults to a string title. */
  value?: string;
}

/** Declares an option; Options reads its props and renders the picked one's children. */
export function Option(_props: OptionProps) {
  return null;
}

function valueOf({ title, value }: OptionProps) {
  if (value) return value;
  if (typeof title === "string") return title;
  throw new Error("An Option with a non-text title needs a value.");
}

export default function Options({ children, id, label }: {
  children: ReactNode;
  /** The control id; defaults to the label. Rename it only to reset the user's pick. */
  id?: string;
  /** Names the set for the user and for screen readers. */
  label: string;
}) {
  const options = Children.toArray(children).filter((child): child is ReactElement<OptionProps> => isValidElement(child) && child.type === Option);
  const values = options.map(option => valueOf(option.props));
  const [picked, setPicked] = useVisState(id ?? label, values[0] ?? "");
  const shown = Math.max(0, values.indexOf(picked));
  return (
    <section aria-label={label} className="space-y-2" data-vis-options={id ?? label}>
      <Tabs className="flex flex-wrap gap-1" label={label}>
        {options.map((option, index) => (
          <Tab as="button" key={values[index]} onClick={() => setPicked(values[index]!)} selected={index === shown} variant="inline">
            {option.props.title}
          </Tab>
        ))}
      </Tabs>
      <div>{options[shown]?.props.children}</div>
    </section>
  );
}
