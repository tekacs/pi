# Model status in the footer

Extensions use `ctx.ui.setStatus("model:<extension-name>", text)` to append a status after the model and reasoning effort in the built-in footer. For example, a fast-mode extension sets `FAST` or `normal`, yielding `gpt-6-astra • high • FAST`.

Model statuses are sorted by key, sanitized to one line, and included in the footer's existing width calculation. They do not also appear on the separate extension-status line. Other status keys retain their existing placement. Passing `undefined` removes a status. Statuses are runtime UI state; their extension owns updating them on startup, model selection, and mode changes. Custom footers receive the same unmodified status map and choose their own layout.
