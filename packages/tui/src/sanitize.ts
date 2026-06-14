// @zaivim/tui — Sanitize wrapper for TUI terminal display
// Re-exports sanitizeForTerminal from @zaivim/engine (B5.1).
// TUI uses stripAnsi=true, stripControl=true, stripLeadingColon=false (B5.2/B5.4).

export { sanitizeForTerminal } from '@zaivim/engine';
export type { SanitizeTerminalOptions } from '@zaivim/engine';
