# Todo

A plain list for the day, per workspace and per machine. Type a line and press Enter to add it, tick it off, open it to read it in full, edit the title or write notes, remove it, or clear every completed one. The header counts progress. "Add a todo" is also in the command palette. It is deliberately nothing more than that: no due dates, priorities or projects.

## How it works

One JSON file per workspace under `.quiver/local/todos.json`, so the list is yours alone and never committed. Each item has a title, free-text notes, a done flag and its creation and completion times. Open items come first in the order they were added, then the completed ones, until "Clear completed" drops those. Notes and title edits save a moment after typing stops and when the field loses focus. Writes to a workspace's list are queued, so two quick edits cannot lose each other.

Long text stays readable in the narrow panel. A closed line wraps its title over up to three lines instead of cutting it at the panel's edge, and shows the first two lines of its notes underneath. Click it to open it: the whole title and the notes are then shown in fields that grow with their text, so nothing scrolls inside a small box (notes start scrolling at half the window's height). Both are edited right there; the title stays one line of text however many rows it wraps to, and Enter finishes editing it. The chevron closes the line again, and "Remove" sits under the notes next to the date the item was added or done.

## Agents

`todo_list`, `todo_add` and `todo_update` are allowed, so an agent can put "fix the failing test" on your list or tick it off when done; `todo_remove` and `todo_clear` are gated like other deletes.

## Verified by

The smoke adds, ticks, annotates and clears items through the commands, checks the gating for agents, and drives the panel: typing a line, ticking it, writing notes, clearing the done ones. With a long title and long notes it checks that the closed line wraps to three lines with a notes preview, that the open one shows all of both without inner scrolling or overflowing the panel, and that the title edits in place.
