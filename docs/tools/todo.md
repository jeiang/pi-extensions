# todo

The progress list the user sees: an approved plan's checklist, or the session's todo.md.

## Use instead of
- progress reported only in prose → todo add and toggle

## Examples
```js
await tools.todo({ action: "toggle", id: 2 });
```

## Errors
- toggle needs a step number from list.

## Related
propose, goal
