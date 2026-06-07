// @zaivim/gateway — Streaming Markdown → ANSI terminal renderer
// Zero external dependencies. State machine tracks code-block boundaries across chunks.

// ANSI escape sequences
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  bgYellow: '\x1b[43m',
  black: '\x1b[30m',
} as const;

type RenderState = 'NORMAL' | 'IN_CODE_BLOCK';

export interface MarkdownRenderer {
  /** Feed an incremental text chunk and return ANSI-formatted output. */
  push(chunk: string): string;
  /** Reset internal state (e.g., between sessions). */
  reset(): void;
  /** Current renderer state. */
  readonly state: RenderState;
}

export function createMarkdownRenderer(): MarkdownRenderer {
  let _state: RenderState = 'NORMAL';
  let _pending = '';

  return {
    get state() { return _state; },

    push(chunk: string): string {
      const input = _pending + chunk;
      _pending = '';
      let output = '';
      let i = 0;

      while (i < input.length) {
        if (_state === 'NORMAL') {
          // Check for code fence ```
          if (input[i] === '`') {
            // Count consecutive backticks from position i
            let backtickCount = 0;
            let j = i;
            while (j < input.length && input[j] === '`') {
              backtickCount++;
              j++;
            }

            if (backtickCount >= 3) {
              // Code fence opening
              _state = 'IN_CODE_BLOCK';
              output += '\n' + ANSI.cyan;
              const lineEnd = input.indexOf('\n', j);
              if (lineEnd === -1) {
                // Incomplete: language tag hasn't ended yet
                _pending = input.slice(i);
                return output;
              }
              const langTag = input.slice(j, lineEnd).trim();
              if (langTag) {
                output += ANSI.dim + langTag + ANSI.reset + '\n' + ANSI.cyan;
              } else {
                output += '\n';
              }
              i = lineEnd + 1;
              continue;
            }

            // 1 backtick: inline code
            if (backtickCount === 1) {
              const closeIdx = input.indexOf('`', i + 1);
              if (closeIdx === -1) {
                // Incomplete — buffer
                _pending = input.slice(i);
                return output;
              }
              const code = input.slice(i + 1, closeIdx);
              output += ANSI.bgYellow + ANSI.black + ' ' + code + ' ' + ANSI.reset;
              i = closeIdx + 1;
              continue;
            }

            // 2 backticks: could be start of ``` — buffer
            _pending = input.slice(i);
            return output;
          }

          // Bold **text**
          if (input[i] === '*' && i + 1 < input.length && input[i + 1] === '*') {
            const closeIdx = input.indexOf('**', i + 2);
            if (closeIdx === -1) {
              _pending = input.slice(i);
              return output;
            }
            const text = input.slice(i + 2, closeIdx);
            output += ANSI.bold + text + ANSI.reset;
            i = closeIdx + 2;
            continue;
          }

          // Italic *text*
          if (input[i] === '*') {
            const closeIdx = input.indexOf('*', i + 1);
            if (closeIdx === -1) {
              _pending = input.slice(i);
              return output;
            }
            if (closeIdx + 1 < input.length && input[closeIdx + 1] === '*') {
              output += input[i];
              i++;
              continue;
            }
            const text = input.slice(i + 1, closeIdx);
            output += ANSI.italic + text + ANSI.reset;
            i = closeIdx + 1;
            continue;
          }

          output += input[i];
          i++;
        } else {
          // IN_CODE_BLOCK state
          if (input.startsWith('```', i)) {
            _state = 'NORMAL';
            output += ANSI.reset + '\n';
            i += 3;
            continue;
          }
          // In code block, check for partial ``` at end of chunk
          if (input[i] === '`') {
            let backtickCount = 0;
            let j = i;
            while (j < input.length && input[j] === '`') {
              backtickCount++;
              j++;
            }
            // If at end of input and less than 3 backticks, buffer
            if (j === input.length && backtickCount < 3) {
              output += input.slice(i, i + backtickCount);
              i = j;
              continue;
            }
          }
          output += input[i];
          i++;
        }
      }

      return output;
    },

    reset(): void {
      _state = 'NORMAL';
      _pending = '';
    },
  };
}

/** Render a complete Markdown string (non-streaming convenience). */
export function renderMarkdownToTerminal(md: string): string {
  const renderer = createMarkdownRenderer();
  return renderer.push(md);
}
