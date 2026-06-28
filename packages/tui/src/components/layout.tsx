// @zaivim/tui — Layout: top split panels + bottom status bar
// Phase D (AC9): column layout with reserved status bar line.

import React, { type ReactNode } from 'react';
import { Box, Text } from 'ink';

interface LayoutProps {
  children: [ReactNode, ReactNode];
  focus: 'sessions' | 'chat';
  statusText: string;
}

export function Layout({ children, focus, statusText }: LayoutProps): React.JSX.Element {
  return (
    <Box flexDirection="column" height="100%">
      {/* Top — left/right split panels */}
      <Box flexDirection="row" height="100%-1">
        {/* Left panel — session list */}
        <Box width="30%" borderStyle="single" borderColor={focus === 'sessions' ? 'cyan' : 'gray'} overflowY="hidden">
          {children[0]}
        </Box>
        {/* Right panel — chat area */}
        <Box width="70%" borderStyle="single" borderColor={focus === 'chat' ? 'cyan' : 'white'} overflowY="hidden">
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
