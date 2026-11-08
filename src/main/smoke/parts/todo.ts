import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TodoItem } from '@quiver/core';
import { definePart } from '../part';

export default definePart({
  name: 'todo',
  summary: 'Todo list: commands, agent gating, the panel',
  async run(t) {
    const { host, check, run, ws, folder } = t;

    // Todo list: a per-machine list under .quiver/local; deleting is gated for agents, adding and ticking are not.
    const todoA = await run<TodoItem>('todo.add', { title: '  write the release notes ' }, ws.id);
    const todoB = await run<TodoItem>('todo.add', { title: 'review PR 42', notes: 'ask about the migration' }, ws.id);
    const todoDone = await run<TodoItem>('todo.update', { id: todoA.id, done: true }, ws.id);
    const todoNoted = await run<TodoItem>('todo.update', { id: todoB.id, notes: 'ask about the migration and the index' }, ws.id);
    const todoList = await run<TodoItem[]>('todo.list', {}, ws.id);
    const todoOnDisk = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'local', 'todos.json'), 'utf8')) as TodoItem[];
    check(
      'todo: add trims the title, update ticks and annotates, the list lives under .quiver/local',
      todoA.title === 'write the release notes' && todoDone.done && typeof todoDone.completedAt === 'string' && todoNoted.notes.endsWith('the index') && !todoNoted.done && todoList.length === 2 && todoOnDisk.length === 2,
      { todoDone, todoNoted, todoList: todoList.map((t) => `${t.title}:${t.done}`) },
    );
    const agentTodoAdd = await host.invoke('todo.add', { title: 'from an agent' }, { caller: 'mcp', workspaceId: ws.id });
    const agentTodoRemove = await host.invoke('todo.remove', { id: todoB.id }, { caller: 'mcp', workspaceId: ws.id });
    const agentTodoClear = await host.invoke('todo.clear', {}, { caller: 'mcp', workspaceId: ws.id });
    const todoCleared = await run<{ removed: number }>('todo.clear', {}, ws.id);
    const todoAfterClear = await run<TodoItem[]>('todo.list', {}, ws.id);
    check(
      'todo: agents may add and tick but not remove or clear; clear drops only the completed items',
      agentTodoAdd.ok && !agentTodoRemove.ok && agentTodoRemove.error.code === 'MUTATION_BLOCKED' && !agentTodoClear.ok && agentTodoClear.error.code === 'MUTATION_BLOCKED' && todoCleared.removed === 1 && todoAfterClear.length === 2 && todoAfterClear.every((t) => !t.done),
      { agentTodoAdd: agentTodoAdd.ok, agentTodoRemove: agentTodoRemove.ok || agentTodoRemove.error.code, agentTodoClear: agentTodoClear.ok || agentTodoClear.error.code, todoCleared, left: todoAfterClear.map((t) => t.title) },
    );
    for (const t of todoAfterClear) await run('todo.remove', { id: t.id }, ws.id);

    return {
      ui: async (u) => {
        const { js, wait, shot } = u;
        // Todo panel: type and Enter adds, ticking strikes through, a line opens for notes, long text stays readable, Clear completed empties the done ones.
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=todo]').click()`);
        await wait(400);
        const typeTodo = async (title: string) => {
          await js(
            `(() => { const i = document.querySelector('[data-testid=todo-input]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(i, ${JSON.stringify(title)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`,
          );
          await wait(300);
        };
        await typeTodo('Fix the flaky login test');
        await typeTodo('Reply to the design review');
        await typeTodo('Deploy staging');
        const todoTitles = () => js(`[...document.querySelectorAll('[data-testid=todo-item]')].map((r) => r.getAttribute('data-title') + (r.hasAttribute('data-done') ? ':done' : ''))`) as Promise<string[]>;
        const todosTyped = await todoTitles();
        const todoInputCleared = await js(`document.querySelector('[data-testid=todo-input]').value`);
        check('ui: todo: Enter adds the typed line and clears the box', JSON.stringify(todosTyped) === JSON.stringify(['Fix the flaky login test', 'Reply to the design review', 'Deploy staging']) && todoInputCleared === '', { todosTyped, todoInputCleared });
        await js(`document.querySelectorAll('[data-testid=todo-toggle]')[0].click()`);
        await wait(400);
        const todosTicked = await todoTitles();
        check('ui: todo: ticking a line marks it done and moves it below the open ones', JSON.stringify(todosTicked) === JSON.stringify(['Reply to the design review', 'Deploy staging', 'Fix the flaky login test:done']), todosTicked);
        await js(`document.querySelectorAll('[data-testid=todo-title]')[0].click()`);
        await wait(200);
        await js(
          `(() => { const t = document.querySelector('[data-testid=todo-notes]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(t, 'Waiting on Sam for the mockups'); t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); })()`,
        );
        await wait(500);
        const notedTodo = (await run<TodoItem[]>('todo.list', {}, ws.id)).find((t) => t.title === 'Reply to the design review');
        check('ui: todo: notes typed under a line are saved', notedTodo?.notes === 'Waiting on Sam for the mockups', notedTodo);
        // Long text: a closed line wraps its title (three lines at most) and shows the start of its notes; an open one shows all of both.
        const longTitle = 'Rewrite the billing reconciliation job so that retries are idempotent, then add a regression test for the double charge from https://status.example.com/incidents/2026-09-28-double-charge-on-retry';
        const longNotes = ['Steps:', '1. Reproduce with the fixture from the incident channel.', '2. Make the retry key part of the ledger row.', '3. Backfill the rows that were charged twice.', '', 'Ask Dana which customers were refunded by hand, so the backfill skips them.'].join('\n');
        await run('todo.add', { title: longTitle, notes: longNotes }, ws.id);
        await wait(500);
        const longRow = `[data-testid=todo-item][data-title^="Rewrite the billing"]`;
        const closedLong = (await js(
          `(() => { const row = document.querySelector('${longRow}'); const list = document.querySelector('[data-testid=todo-list]'); const title = row?.querySelector('[data-testid=todo-title] span'); const preview = row?.querySelector('[data-testid=todo-notes-preview]'); const other = document.querySelector('[data-testid=todo-item][data-title="Deploy staging"] [data-testid=todo-title] span'); if (!row || !list || !title || !preview || !other) return null; return { lines: Math.round(title.clientHeight / other.clientHeight), clipped: title.scrollHeight > title.clientHeight, wide: title.scrollWidth > title.clientWidth, previewLines: Math.round(preview.clientHeight / 18), overflow: list.scrollWidth > list.clientWidth }; })()`,
        )) as { lines: number; clipped: boolean; wide: boolean; previewLines: number; overflow: boolean } | null;
        check(
          'ui: todo: a long title wraps to three lines with the start of its notes underneath, inside the panel',
          closedLong !== null && closedLong.lines === 3 && closedLong.clipped && !closedLong.wide && closedLong.previewLines === 2 && !closedLong.overflow,
          closedLong,
        );
        await shot('26-todo-long-closed-light');
        await js(`document.querySelector('${longRow} [data-testid=todo-title]').click()`);
        await wait(400);
        const openLong = (await js(
          `(() => { const row = document.querySelector('${longRow}'); const title = row?.querySelector('[data-testid=todo-edit-title]'); const notes = row?.querySelector('[data-testid=todo-notes]'); const list = document.querySelector('[data-testid=todo-list]'); if (!title || !notes || !list) return null; return { title: title.value, titleHeight: title.clientHeight, titleScrolls: title.scrollHeight > title.clientHeight + 1, notesHeight: notes.clientHeight, notesScroll: notes.scrollHeight > notes.clientHeight + 1, overflow: list.scrollWidth > list.clientWidth, closedPreview: document.querySelector('[data-testid=todo-item][data-title="Reply to the design review"] [data-testid=todo-notes-preview]')?.textContent ?? null }; })()`,
        )) as { title: string; titleHeight: number; titleScrolls: boolean; notesHeight: number; notesScroll: boolean; overflow: boolean; closedPreview: string | null } | null;
        check(
          'ui: todo: an open line shows its whole title and notes without scrolling inside them',
          openLong !== null && openLong.title === longTitle && openLong.titleHeight > 80 && !openLong.titleScrolls && openLong.notesHeight > 150 && !openLong.notesScroll && !openLong.overflow && openLong.closedPreview === 'Waiting on Sam for the mockups',
          openLong,
        );
        await js(
          `(() => { const t = document.querySelector('${longRow} [data-testid=todo-edit-title]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(t, ${JSON.stringify('Rewrite the billing reconciliation job\n  so that retries are idempotent')}); t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); })()`,
        );
        await wait(500);
        const retitled = (await run<TodoItem[]>('todo.list', {}, ws.id)).find((t) => t.title.startsWith('Rewrite the billing'));
        check('ui: todo: the title is edited in place and stays one line of text', retitled?.title === 'Rewrite the billing reconciliation job so that retries are idempotent' && retitled.notes === longNotes, retitled?.title);
        await run('todo.update', { id: retitled?.id ?? '', title: longTitle }, ws.id);
        await js(`document.querySelector('[data-testid=todo-collapse]').click()`);
        await wait(300);
        await js(`document.querySelector('${longRow} [data-testid=todo-title]').click()`);
        await wait(400);
        check('ui: todo: the chevron collapses an open line', (await js(`document.querySelector('${longRow} [data-testid=todo-edit-title]')?.value`)) === longTitle);
        await shot('26a-todo-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(200);
        await shot('26b-todo-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`document.querySelector('[data-testid=todo-clear]').click()`);
        await wait(400);
        const todosCleared = await todoTitles();
        const todoHeader = await js(`document.querySelector('[data-testid=activity-item][data-drag-id=todo]') && [...document.querySelectorAll('span')].find((s) => /^List · /.test(s.textContent))?.textContent`);
        check('ui: todo: Clear completed removes the done lines and the header counts what is left', JSON.stringify(todosCleared) === JSON.stringify(['Reply to the design review', 'Deploy staging', longTitle]) && todoHeader === 'List · 0/3 done', { todosCleared, todoHeader });
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=api]').click()`);
        await wait(200);
      },
    };
  },
});
