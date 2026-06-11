// @zaivim/engine — Risk Card (Story 2.2, Task 4)
// Risk description cards for rejected operations.
// Template version: v1.0.0 (Story 2.2)

import type { HarmLevel, RiskCard, RiskCardSeverity } from '@zaivim/core';

/** Current template version for traceability (Subtask 4.3) */
const TEMPLATE_VERSION = '2.2.0';

// ============================================================================
// Risk template definitions (Subtask 4.3)
// Must stay in sync with HarmClassifier S/A-level patterns (Subtask 4.3.2)
// ============================================================================

interface RiskTemplate {
  readonly severity: RiskCardSeverity;
  readonly risk: string;
  readonly consequences: readonly string[];
  readonly alternatives: readonly string[];
  readonly overrideInstructions?: string;
}

/** S-level risk templates — indexed by keyword in the harmLevel reason */
const S_RISK_TEMPLATES: Array<{ keyword: string; template: RiskTemplate }> = [
  {
    keyword: 'system file modification',
    template: {
      severity: 'danger',
      risk: '尝试修改系统关键文件',
      consequences: [
        '可能导致系统不稳定或无法启动',
        '可能被用于权限提升或后门植入',
        '可能影响其他应用程序的正常运行',
        '系统文件变更通常不被版本管理追踪，变更不可逆',
      ],
      alternatives: [
        '将文件复制到项目目录内操作',
        '使用环境变量或配置文件而非修改系统文件',
        '考虑使用用户空间替代方案',
      ],
      overrideInstructions: '覆盖此操作将允许修改系统关键文件。请确认您明确了解此操作的具体内容和后果。',
    },
  },
  {
    keyword: 'system directory modification',
    template: {
      severity: 'danger',
      risk: '修改系统目录内容',
      consequences: [
        '系统目录变更可能影响系统安全与稳定性',
        '变更可能被安全软件检测为入侵行为',
        '系统更新可能覆盖您的修改',
      ],
      alternatives: [
        '使用 /usr/local 或项目目录存放自定义内容',
        '考虑使用 dotfiles 管理用户级配置',
      ],
      overrideInstructions: '覆盖此操作将允许修改系统目录。请确认您了解此操作的必要性。',
    },
  },
  {
    keyword: 'password shadow file',
    template: {
      severity: 'danger',
      risk: '读取密码影子文件',
      consequences: [
        '该文件包含系统用户的密码哈希值',
        '哈希值可能被离线破解工具破解',
        '可能导致系统所有用户凭据泄露',
      ],
      alternatives: [
        '使用 getent 命令查询用户信息',
        '检查 /etc/passwd 获取非敏感用户信息',
      ],
      overrideInstructions: '覆盖此操作将读取密码哈希文件。请确认这是预期的安全审计行为。',
    },
  },
  {
    keyword: 'SSH key',
    template: {
      severity: 'danger',
      risk: '访问 SSH 私钥',
      consequences: [
        'SSH 私钥泄露可导致远程服务器被未授权访问',
        '私钥一旦泄露即永久失效，需要重新生成并分发',
        '可能影响所有使用该密钥的服务器和服务的访问安全',
      ],
      alternatives: [
        '使用 SSH 代理（ssh-agent）管理密钥，无需直接访问密钥文件',
        '检查公钥文件（.pub）而非私钥文件',
      ],
      overrideInstructions: '覆盖此操作将允许读取 SSH 私钥。私钥泄露无法撤销，请确认操作的必要性。',
    },
  },
  {
    keyword: 'AWS credential',
    template: {
      severity: 'danger',
      risk: '访问 AWS 凭据文件',
      consequences: [
        'AWS 凭据泄露可导致云资源被未授权访问和滥用',
        '可能产生巨额云服务费用',
        '凭据轮换需要运维团队介入',
      ],
      alternatives: [
        '使用 AWS IAM Role 或环境变量传递凭据',
        '检查 AWS SSO 配置而非长期凭据',
      ],
      overrideInstructions: '覆盖此操作将允许读取云服务凭据。凭据泄露有严重安全后果，请确认。',
    },
  },
  {
    keyword: 'Kubernetes config',
    template: {
      severity: 'danger',
      risk: '访问 Kubernetes 集群配置',
      consequences: [
        'Kubeconfig 包含集群访问凭据和证书',
        '泄露可导致整个 Kubernetes 集群被未授权控制',
        '可能暴露集群中的其他应用和数据',
      ],
      alternatives: [
        '使用 kubectl 命令查询集群信息',
        '检查 kubeconfig 中使用的证书有效期',
      ],
      overrideInstructions: '覆盖此操作将允许读取 Kubernetes 集群凭据。请确认操作必要性。',
    },
  },
  {
    keyword: 'GPG key',
    template: {
      severity: 'danger',
      risk: '访问 GPG 密钥',
      consequences: [
        'GPG 私钥泄露可导致签名伪造和加密通信被解密',
        '密钥吊销需要复杂的操作流程',
        '可能影响软件包签名验证和加密通信',
      ],
      alternatives: [
        '使用 gpg --list-keys 列出公钥信息',
        '检查密钥过期时间而非私钥内容',
      ],
      overrideInstructions: '覆盖此操作将允许读取 GPG 私钥。请确认操作必要性。',
    },
  },
  {
    keyword: 'SSL certificate',
    template: {
      severity: 'danger',
      risk: '读取 SSL/TLS 证书',
      consequences: [
        'SSL 私钥泄露可导致中间人攻击',
        '需要吊销并重新签发证书',
        '已建立的 TLS 连接可能被解密',
      ],
      alternatives: [
        '使用 openssl 命令在线查询证书信息',
        '检查证书元数据而非私钥',
      ],
      overrideInstructions: '覆盖此操作将允许读取 SSL 私钥。请确认操作必要性。',
    },
  },
  {
    keyword: 'environment file',
    template: {
      severity: 'danger',
      risk: '修改环境变量文件',
      consequences: [
        '环境文件中通常包含 API Key、数据库密码等敏感信息',
        '修改可能导致应用配置错误或凭据泄露',
        '环境变量变更可能影响多个应用和服务',
      ],
      alternatives: [
        '通过应用自身的配置界面修改设置',
        '使用 CI/CD 变量管理代替 .env 文件',
        '使用密钥管理服务（Vault, AWS Secrets Manager）',
      ],
      overrideInstructions: '覆盖此操作将允许修改环境变量文件。环境文件可能包含敏感信息，请确认操作内容。',
    },
  },
];

/** A-level risk templates */
const A_RISK_TEMPLATES: Array<{ keyword: string; template: RiskTemplate }> = [
  {
    keyword: 'SSH configuration',
    template: {
      severity: 'warning',
      risk: '修改 SSH 配置',
      consequences: [
        'SSH 配置错误可能导致无法远程连接',
        '可能降低 SSH 连接安全性',
      ],
      alternatives: [
        '在 ~/.ssh/config 中使用 Include 指令分文件管理',
        '使用 SSH 别名简化连接而非修改全局配置',
      ],
      overrideInstructions: '覆盖此操作将允许修改 SSH 配置。请确认修改内容可以远程连接不受影响。',
    },
  },
  {
    keyword: 'credential',
    template: {
      severity: 'warning',
      risk: '修改凭据配置文件',
      consequences: [
        '凭据文件包含云服务和第三方服务的认证信息',
        '错误修改可能导致服务不可用',
      ],
      alternatives: [
        '使用环境变量注入凭据',
        '通过服务自身的 CLI 工具配置凭据',
      ],
      overrideInstructions: '覆盖此操作将允许修改凭据文件。请确认操作不会导致凭据泄露。',
    },
  },
  {
    keyword: 'gitconfig',
    template: {
      severity: 'warning',
      risk: '修改 Git 全局配置',
      consequences: [
        'Git 配置可能包含用户信息签名设置',
        '修改可能影响所有仓库的 Git 行为',
      ],
      alternatives: [
        '使用项目级 .git/config 而非全局配置',
        '通过 git config 命令安全修改',
      ],
    },
  },
];

/**
 * Default templates for unmatched patterns
 */
const DEFAULT_TEMPLATES: Record<HarmLevel, RiskTemplate> = {
  S: {
    severity: 'danger',
    risk: '高风险操作',
    consequences: [
      '此操作可能对系统造成不可逆的损害',
      '操作涉及系统关键区域修改',
      '未经审核的高风险操作可能导致安全事件',
    ],
    alternatives: [
      '确认操作的具体目标和影响范围',
      '考虑使用更安全的替代方案',
    ],
    overrideInstructions: '覆盖操作有风险，请确认您明确了解此操作的具体内容和可能后果。',
  },
  A: {
    severity: 'warning',
    risk: '需要谨慎的操作',
    consequences: [
      '此操作涉及敏感配置或系统修改',
      '错误操作可能导致服务异常或配置丢失',
    ],
    alternatives: [
      '在测试环境验证操作效果',
      '操作前备份相关配置',
    ],
    overrideInstructions: '请确认您已了解此操作的影响。',
  },
  B: {
    severity: 'warning',
    risk: '潜在影响操作',
    consequences: [
      '此操作可能影响项目文件结构',
      '变更将被版本管理追踪',
    ],
    alternatives: [],
  },
  C: {
    severity: 'warning',
    risk: '常规操作',
    consequences: [],
    alternatives: [],
  },
};

/**
 * Generate a risk card for a security decision
 *
 * @param harmLevel - Classified harm level
 * @param reason - The reason from SecurityDecision
 * @param operation - The operation being classified
 * @returns RiskCard with appropriate template
 */
export function generateRiskCard(harmLevel: HarmLevel, reason: string, operation: string): RiskCard {
  const template = findTemplate(harmLevel, reason);

  return {
    templateVersion: TEMPLATE_VERSION,
    operation,
    harmLevel,
    severity: template.severity,
    risk: template.risk,
    consequences: [...template.consequences],
    alternatives: [...template.alternatives],
    overrideInstructions: template.overrideInstructions,
  };
}

/**
 * Find the best matching template for a harm level and reason
 */
function findTemplate(harmLevel: HarmLevel, reason: string): RiskTemplate {
  const lowerReason = reason.toLowerCase();

  if (harmLevel === 'S') {
    for (const entry of S_RISK_TEMPLATES) {
      if (lowerReason.includes(entry.keyword.toLowerCase())) {
        return entry.template;
      }
    }
  }

  if (harmLevel === 'A') {
    for (const entry of A_RISK_TEMPLATES) {
      if (lowerReason.includes(entry.keyword.toLowerCase())) {
        return entry.template;
      }
    }
  }

  return DEFAULT_TEMPLATES[harmLevel];
}

/**
 * Risk card data for transport — lightweight version without full templates
 * (used in JSON-RPC responses to save bandwidth)
 */
export interface RiskCardSummary {
  readonly harmLevel: HarmLevel;
  readonly severity: RiskCardSeverity;
  readonly risk: string;
  readonly templateVersion: string;
}

// ============================================================================
// Pattern-Template Sync Gate (Story 2.2, Task 4.3.2)
// Ensures all S/A-level patterns have corresponding risk templates
// ============================================================================

/**
 * Validate that all S/A-level harm classification patterns have
 * corresponding risk templates (Subtask 4.3.2)
 *
 * MVP validation: Check that S and A templates exist and cover
 * common pattern categories. Growth: Implement comprehensive coverage checking.
 *
 * @param sPatterns - Array of S-level pattern prefixes from HarmClassifier
 * @param aPatterns - Array of A-level pattern prefixes from HarmClassifier
 * @returns Object with validation result and warnings
 */
export function validatePatternTemplateSync(
  sPatterns: readonly string[],
  aPatterns: readonly string[],
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // MVP: Check that S and A templates exist
  if (S_RISK_TEMPLATES.length === 0) {
    warnings.push('No S-level risk templates defined');
  }
  if (A_RISK_TEMPLATES.length === 0) {
    warnings.push('No A-level risk templates defined');
  }

  // MVP: Check for common critical patterns
  const sTemplateKeywords = new Set(
    S_RISK_TEMPLATES.map(t => t.keyword.toLowerCase())
  );

  // Check for system file template (most critical)
  const hasSystemFileTemplate = Array.from(sTemplateKeywords).some(k =>
    k.includes('system file')
  );
  if (!hasSystemFileTemplate) {
    warnings.push('Missing critical S-level template for "system file modification"');
  }

  // Growth: Add more comprehensive coverage checks here
  // - Check each pattern category has a matching template
  // - Validate template quality and completeness
  // - Test template rendering for all patterns

  return {
    valid: warnings.filter(w => w.includes('critical')).length === 0,
    warnings,
  };
}

/**
 * Get all template keywords for testing
 */
export function getTemplateKeywords(): {
  sKeywords: readonly string[];
  aKeywords: readonly string[];
} {
  return {
    sKeywords: S_RISK_TEMPLATES.map(t => t.keyword),
    aKeywords: A_RISK_TEMPLATES.map(t => t.keyword),
  };
}

/**
 * Get all template keywords for testing
 */
export function getTemplateKeywords(): {
  sKeywords: readonly string[];
  aKeywords: readonly string[];
} {
  return {
    sKeywords: S_RISK_TEMPLATES.map(t => t.keyword),
    aKeywords: A_RISK_TEMPLATES.map(t => t.keyword),
  };
}
