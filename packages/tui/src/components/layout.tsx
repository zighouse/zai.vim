// @zaivim/tui — Two-panel layout: session list (left) + chat area (right)
// Uses ink Box with flex proportions — left 30%, right 70%.

import React, { type ReactNode } from 'react';
import { Box } from 'ink';

interface LayoutProps {
  children: [ReactNode, ReactNode];
  focus: 'sessions' | 'chat';
}

export function Layout({ children, focus }: LayoutProps): React.JSX.Element {
  return (
    <Box flexDirection="row" height="100%">
      {/* Left panel — session list */}
      <Box width="30%" borderStyle="single" borderColor={focus === 'sessions' ? 'cyan' : 'gray'}>
        {children[0]}
      </Box>
      {/* Right panel — chat area */}
      <Box width="70%" borderStyle="single" borderColor={focus === 'chat' ? 'cyan' : 'white'}>
        {children[1]}
      </Box>
    </Box>
  );
}
