/* No production exports. Tests protect grouped context-menu semantics and selection dismissal behavior. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkbenchContextMenuSurface, { selectWorkbenchContextMenuControl } from "./WorkbenchContextMenuSurface";

test("context menu renders action, separator, checkbox, and radio semantics", () => {
  const icon = createElement("span", null, "icon");
  const html = renderToStaticMarkup(createElement(WorkbenchContextMenuSurface, {
    generation: 1,
    menu: {
      id: "thread",
      label: "Thread actions",
      items: [{ id: "open", label: "Open", onSelect: () => undefined }, {
        id: "separator",
        kind: "separator",
      }, {
        controls: [{ checked: true, icon, id: "pin", label: "Unpin thread", onSelect: () => undefined }, {
          checked: false, disabled: true, icon, id: "snooze", label: "Snooze thread", onSelect: () => undefined,
        }],
        id: "priority",
        kind: "control-group",
        label: "Priority",
        presentation: "independent",
      }, {
        controls: [{ checked: false, disabled: true, icon, id: "attention", label: "Needs attention", onSelect: () => undefined, tone: "needs-attention" }, {
          checked: true, icon, id: "completed", label: "Completed", onSelect: () => undefined, tone: "completed",
        }],
        id: "status",
        kind: "control-group",
        label: "Status",
        presentation: "connected",
      }],
    },
    onClose: () => undefined,
    x: 10,
    y: 20,
  }));

  assert.match(html, /role="menu" aria-label="Thread actions"/u);
  assert.match(html, /aria-label="Close context menu"/u);
  assert.match(html, /role="menuitem"[^>]*>[^<]*<span[^>]*>Open/u);
  assert.match(html, /role="separator"/u);
  assert.match(html, /role="group" aria-label="Priority"/u);
  assert.match(html, /role="menuitemcheckbox" aria-checked="true" aria-label="Unpin thread"/u);
  assert.match(html, /role="menuitemcheckbox" aria-checked="false" aria-label="Snooze thread"[^>]*disabled/u);
  assert.match(html, /role="group" aria-label="Status"/u);
  assert.match(html, /role="menuitemradio" aria-checked="true" aria-label="Completed"/u);
});

test("persistent controls dispatch without closing while default and disabled controls preserve dismissal semantics", () => {
  const events: string[] = [];
  const control = {
    checked: false,
    icon: createElement("span"),
    id: "pin",
    label: "Pin thread",
    onSelect: () => events.push("select"),
  };
  const group = {
    controls: [control],
    id: "priority",
    kind: "control-group" as const,
    label: "Priority",
    presentation: "independent" as const,
  };

  selectWorkbenchContextMenuControl({ ...group, closeOnSelect: false }, control, () => events.push("close"));
  assert.deepEqual(events, ["select"]);

  events.length = 0;
  selectWorkbenchContextMenuControl(group, control, () => events.push("close"));
  assert.deepEqual(events, ["close", "select"]);

  events.length = 0;
  selectWorkbenchContextMenuControl(group, { ...control, disabled: true }, () => events.push("close"));
  assert.deepEqual(events, []);
});
