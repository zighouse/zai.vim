import type { SkillAdapter, SkillInput, SkillOutput } from '@zaivim/core';

const helloSkill: SkillAdapter = {
  name: 'hello',
  version: '1.0.0',
  description: 'A minimal example skill',
  execute: async (input: SkillInput): Promise<SkillOutput> => {
    return { content: `Hello from ${input.context?.name ?? 'zai.vim'}!` };
  },
};

export default helloSkill;
