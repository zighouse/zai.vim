// @zaivim/tui — Layout: top split panels + bottom status bar
// Phase D (AC9): column layout with reserved status bar line.
// Defensive heights via useStdout so content can never push the layout
// beyond the terminal viewport (flicker / left-panel-pushed-off fix).

import React, { type ReactNode } from 'react';
import { Box, Text, useStdout } from 'ink';

interface LayoutProps {
  children: [ReactNode, ReactNode];
  focus: 'sessions' | 'chat';
  statusText: string;
}

export function Layout({ children, focus, statusText }: LayoutProps): React.JSX.Element {
  const { stdout } = useStdout();
  const totalRows = stdout?.rows ?? 24;
  const panelHeight = Math.max(3, totalRows - 1); // reserve 1 line for status bar

  return (
    <Box flexDirection="column" height={totalRows}>
      {/* Top — left/right split panels */}
      <Box flexDirection="row" height={panelHeight}>
        {/* Left panel — session list */}
        <Box width="30%" height={panelHeight} borderStyle="single" borderColor={focus === 'sessions' ? 'cyan' : 'gray'} overflowY="hidden">
          {children[0]}
        </Box>
        {/* Right panel — chat area */}
        <Box width="70%" height={panelHeight} borderStyle="single" borderColor={focus === 'chat' ? 'cyan' : 'white'} overflowY="hidden">
          {children[1]}
        </Box>
      </Box>
      {/* Bottom — status bar (1 line) */}
      <Box height={1}>
        <Text dimColor>{statusText}</Text>
      </Box>
    </Box>
  );
}
