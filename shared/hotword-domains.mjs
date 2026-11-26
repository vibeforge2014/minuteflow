/**
 * 系统内置领域热词库与同音误识别别名映射（主进程与渲染层共享，纯数据 + 纯函数）。
 *
 * 设计原则：
 * 1. 分领域按需激活：默认根据会议标题、目标、笔记与转写自动匹配最相关的 1–2 个领域，
 *    或叠加用户在设置中手动常驻勾选的领域，绝不无差别全量塞进 Whisper 220 字 prompt。
 * 2. 双用途复用：
 *    - 转写阶段（ASR prompt）：补充高权专业术语（权重低于用户自定义术语与参会人姓名）；
 *    - 后处理语义纠错阶段：提供「同音误听 → 标准写法」别名提示，集中修复中英混说错字。
 */

/** @typedef {{ term: string, aliases?: string[], weight?: number }} DomainHotwordEntry */
/** @typedef {{ id: string, label: string, triggers: string[], terms: DomainHotwordEntry[] }} HotwordDomain */

/** @type {HotwordDomain[]} */
export const HOTWORD_DOMAINS = [
  {
    id: "software",
    label: "软件研发",
    triggers: [
      "架构", "接口", "API", "SDK", "微服务", "数据库", "缓存", "延迟", "并发", "部署",
      "上线", "发版", "联调", "提测", "压测", "重构", "迁移", "网关", "后端", "前端",
      "客户端", "灰度", "回滚", "故障", "排查", "性能", "代码", "研发", "技术"
    ],
    terms: [
      { term: "API", aliases: ["艾皮艾", "阿皮艾", "诶皮艾"], weight: 64 },
      { term: "SDK", aliases: ["艾斯迪凯", "斯迪凯"], weight: 62 },
      { term: "WebRTC", aliases: ["危波RTC", "伟博RTC", "微播RTC", "维波RTC", "韦伯RTC"], weight: 62 },
      { term: "Kafka", aliases: ["卡夫卡", "咔夫卡"], weight: 62 },
      { term: "Redis", aliases: ["瑞迪斯", "雷迪斯", "锐迪斯"], weight: 62 },
      { term: "Docker", aliases: ["多克", "道克", "道客"], weight: 60 },
      { term: "Kubernetes", aliases: ["库伯内蒂斯", "K八S", "开八斯"], weight: 60 },
      { term: "K8s", aliases: ["K八s", "K八S"], weight: 60 },
      { term: "MySQL", aliases: ["麦思扣", "买思扣", "迈思扣"], weight: 60 },
      { term: "PostgreSQL", aliases: ["波斯特格雷", "PG库"], weight: 58 },
      { term: "SQLite", aliases: ["思扣莱特", "塞扣莱特"], weight: 58 },
      { term: "Nginx", aliases: ["恩金克斯", "安金克斯"], weight: 58 },
      { term: "gRPC", aliases: ["吉RPC", "技RPC"], weight: 58 },
      { term: "GraphQL", aliases: ["格拉夫QL"], weight: 56 },
      { term: "WebSocket", aliases: ["伟博索克特", "微播索克特"], weight: 58 },
      { term: "JSON", aliases: ["杰森", "街森"], weight: 58 },
      { term: "OAuth", aliases: ["欧奥斯", "奥斯认证"], weight: 56 },
      { term: "JWT", aliases: ["吉WT"], weight: 56 },
      { term: "SSO", aliases: ["单点登录"], weight: 56 },
      { term: "CDN", aliases: ["西迪恩"], weight: 56 },
      { term: "QPS", aliases: ["丘PS"], weight: 60 },
      { term: "TPS", aliases: ["踢PS"], weight: 56 },
      { term: "P99", aliases: ["批99", "皮99"], weight: 58 },
      { term: "SLA", aliases: ["艾斯LA"], weight: 58 },
      { term: "CI/CD", aliases: ["西艾西迪"], weight: 56 },
      { term: "DevOps", aliases: ["戴夫奥普斯"], weight: 56 },
      { term: "TypeScript", aliases: ["泰普斯奎普特"], weight: 58 },
      { term: "React", aliases: ["瑞艾克特", "里艾克特"], weight: 56 },
      { term: "Electron", aliases: ["伊莱克创", "电创"], weight: 58 },
      { term: "SwiftUI", aliases: ["斯威夫特UI"], weight: 56 },
      { term: "FFmpeg", aliases: ["艾夫艾夫姆佩格", "FF佩格"], weight: 56 },
      { term: "灰度发布", aliases: ["回度发布"], weight: 58 },
      { term: "幂等", aliases: ["秘等", "密等", "蜜等"], weight: 58 },
      { term: "熔断", aliases: ["容断", "融断"], weight: 56 },
      { term: "压测", aliases: ["鸭测", "牙测"], weight: 56 },
      { term: "埋点", aliases: ["买点"], weight: 56 }
    ]
  },
  {
    id: "ai",
    label: "AI 与大模型",
    triggers: [
      "AI", "大模型", "模型", "LLM", "Agent", "智能体", "RAG", "Prompt", "提示词",
      "推理", "微调", "训练", "算力", "GPU", "向量", "检索", "语音识别", "ASR",
      "声纹", "转录", "转写", "评测", "幻觉", "Token", "MCP"
    ],
    terms: [
      { term: "LLM", aliases: ["艾尔艾尔艾姆"], weight: 64 },
      { term: "RAG", aliases: ["拉格", "瑞格", "雷格"], weight: 64 },
      { term: "Agent", aliases: ["艾真特", "阿真特"], weight: 62 },
      { term: "Prompt", aliases: ["普朗特", "普罗姆特"], weight: 62 },
      { term: "Token", aliases: ["托肯", "通肯", "头肯"], weight: 62 },
      { term: "Embedding", aliases: ["因贝丁", "安贝丁"], weight: 60 },
      { term: "LoRA", aliases: ["罗拉", "劳拉"], weight: 58 },
      { term: "MCP", aliases: ["艾姆西皮"], weight: 60 },
      { term: "Whisper", aliases: ["维斯珀", "微斯帕", "威斯珀", "伟斯帕"], weight: 62 },
      { term: "ASR", aliases: ["艾斯R", "阿斯R"], weight: 62 },
      { term: "TTS", aliases: ["踢踢艾斯"], weight: 58 },
      { term: "VAD", aliases: ["微AD", "维AD"], weight: 60 },
      { term: "ONNX", aliases: ["欧恩恩克斯", "奥尼克斯"], weight: 60 },
      { term: "Ollama", aliases: ["欧拉马", "奥拉马", "哦拉马"], weight: 62 },
      { term: "vLLM", aliases: ["微LLM", "维LLM"], weight: 58 },
      { term: "DeepSeek", aliases: ["迪普西克", "地普西克", "低普西克"], weight: 62 },
      { term: "Claude", aliases: ["克劳德", "可劳德"], weight: 60 },
      { term: "Gemini", aliases: ["杰米尼", "吉米尼", "哲米尼"], weight: 60 },
      { term: "OpenAI", aliases: ["欧盆AI", "欧喷AI"], weight: 60 },
      { term: "GPT", aliases: ["吉皮踢", "鸡皮踢"], weight: 60 },
      { term: "Qwen", aliases: ["丘文", "库文"], weight: 58 },
      { term: "PyTorch", aliases: ["派托奇", "拍托奇"], weight: 58 },
      { term: "CUDA", aliases: ["库达", "酷达"], weight: 58 },
      { term: "MLX", aliases: ["艾姆艾尔克斯"], weight: 58 },
      { term: "Transformer", aliases: ["传思福默"], weight: 56 },
      { term: "Benchmark", aliases: ["本驰马克"], weight: 56 },
      { term: "CER", aliases: ["西ER"], weight: 56 },
      { term: "WER", aliases: ["达布溜ER"], weight: 56 },
      { term: "声纹", aliases: ["声闻", "生纹", "深纹"], weight: 62 },
      { term: "说话人分离", aliases: ["说话人分理"], weight: 58 }
    ]
  },
  {
    id: "product",
    label: "产品与运营",
    triggers: [
      "产品", "需求", "PRD", "原型", "交互", "体验", "运营", "增长", "留存", "转化",
      "活跃", "拉新", "促活", "裂变", "私域", "活动", "投放", "渠道", "复盘", "OKR",
      "KPI", "版本", "改版", "MVP", "SaaS", "漏斗", "用户"
    ],
    terms: [
      { term: "PRD", aliases: ["皮R迪", "批R迪"], weight: 62 },
      { term: "MVP", aliases: ["艾姆VP"], weight: 60 },
      { term: "DAU", aliases: ["迪AU", "大优"], weight: 62 },
      { term: "MAU", aliases: ["艾姆AU"], weight: 60 },
      { term: "GMV", aliases: ["吉MV", "鸡MV"], weight: 62 },
      { term: "ROI", aliases: ["R欧艾", "阿欧艾"], weight: 62 },
      { term: "ARPU", aliases: ["阿普", "阿普值"], weight: 58 },
      { term: "LTV", aliases: ["艾尔TV"], weight: 58 },
      { term: "CAC", aliases: ["西AC"], weight: 58 },
      { term: "CTR", aliases: ["西TR"], weight: 58 },
      { term: "CVR", aliases: ["西VR"], weight: 58 },
      { term: "NPS", aliases: ["恩PS"], weight: 58 },
      { term: "OKR", aliases: ["欧KR"], weight: 60 },
      { term: "KPI", aliases: ["开PI", "凯PI"], weight: 60 },
      { term: "SOP", aliases: ["艾斯OP"], weight: 60 },
      { term: "SaaS", aliases: ["萨斯", "撒斯"], weight: 60 },
      { term: "CRM", aliases: ["西RM"], weight: 58 },
      { term: "A/B Test", aliases: ["AB测试", "A比测试"], weight: 58 },
      { term: "留存率", aliases: ["流存率"], weight: 58 },
      { term: "转化率", aliases: ["砖化率"], weight: 58 },
      { term: "复购率", aliases: ["副购率", "付购率"], weight: 58 },
      { term: "客单价", aliases: ["课单价"], weight: 58 },
      { term: "私域", aliases: ["思域", "司域"], weight: 58 }
    ]
  },
  {
    id: "finance",
    label: "经营与财务",
    triggers: [
      "营收", "收入", "毛利", "净利", "利润", "成本", "费用", "预算", "决算", "财报",
      "审计", "回款", "应收", "应付", "现金流", "经营", "业绩", "完成率", "达成率",
      "缺口", "同比", "环比", "账期", "开票", "税务", "SKU", "季度"
    ],
    terms: [
      { term: "SKU", aliases: ["艾斯KU", "思库"], weight: 62 },
      { term: "EBITDA", aliases: ["伊比达", "一比达"], weight: 60 },
      { term: "YoY", aliases: ["歪欧歪"], weight: 58 },
      { term: "MoM", aliases: ["艾姆欧艾姆"], weight: 58 },
      { term: "CapEx", aliases: ["凯佩克斯", "卡佩克斯"], weight: 58 },
      { term: "OpEx", aliases: ["欧佩克斯", "奥佩克斯"], weight: 58 },
      { term: "ERP", aliases: ["伊RP"], weight: 58 },
      { term: "BOM", aliases: ["博姆", "波姆"], weight: 58 },
      { term: "毛利率", aliases: ["冒利率"], weight: 60 },
      { term: "净利率", aliases: ["静利率", "竞利率"], weight: 60 },
      { term: "回款", aliases: ["汇款"], weight: 58 },
      { term: "应收账款", aliases: ["营收账款"], weight: 60 },
      { term: "现金流", aliases: ["现今流"], weight: 58 },
      { term: "达成率", aliases: ["大成率"], weight: 58 },
      { term: "坪效", aliases: ["平效", "屏效"], weight: 58 },
      { term: "人效", aliases: ["仁效"], weight: 56 },
      { term: "账期", aliases: ["涨期", "胀期"], weight: 58 }
    ]
  },
  {
    id: "business",
    label: "商务与法务",
    triggers: [
      "客户", "商务", "报价", "合同", "签约", "采购", "招标", "投标", "标书", "中标",
      "POC", "交付", "验收", "合规", "法务", "保密", "协议", "风控", "专利", "知识产权",
      "隐私", "等保", "甲方", "乙方", "尾款", "尽调", "整改"
    ],
    terms: [
      { term: "POC", aliases: ["皮欧西", "批欧西"], weight: 64 },
      { term: "NDA", aliases: ["恩DA", "恩迪A"], weight: 62 },
      { term: "RFP", aliases: ["R艾夫P"], weight: 58 },
      { term: "RFQ", aliases: ["R艾夫Q"], weight: 56 },
      { term: "SOW", aliases: ["艾斯OW"], weight: 58 },
      { term: "MSA", aliases: ["艾姆SA"], weight: 58 },
      { term: "GDPR", aliases: ["吉DPR"], weight: 58 },
      { term: "ISO27001", aliases: ["ISO两万七", "ISO二七零零一"], weight: 58 },
      { term: "SOC2", aliases: ["索克2", "索克二"], weight: 58 },
      { term: "等保三级", aliases: ["登保三级", "灯保三级"], weight: 60 },
      { term: "招投标", aliases: ["找投标"], weight: 58 },
      { term: "尽调", aliases: ["进调", "近调"], weight: 58 },
      { term: "背调", aliases: ["被调", "备调"], weight: 56 },
      { term: "软著", aliases: ["软住", "软助"], weight: 58 },
      { term: "验收单", aliases: ["延收单"], weight: 56 },
      { term: "数据出境", aliases: ["数据出镜"], weight: 58 }
    ]
  }
];

export const HOTWORD_DOMAIN_IDS = HOTWORD_DOMAINS.map((domain) => domain.id);
const DOMAIN_BY_ID = new Map(HOTWORD_DOMAINS.map((domain) => [domain.id, domain]));

/**
 * 确定当前会议应激活的内置热词领域：
 * - 用户显式勾选的领域（selectedDomains）始终生效；
 * - 若允许自动检测（autoDetect !== false），额外按标题/目标/笔记/转写内容相关性补充至多 2 个领域。
 */
export function detectHotwordDomains({
  title = "",
  goals = [],
  notes = [],
  notesMarkdown = "",
  transcript = [],
  selectedDomains = [],
  autoDetect = true
} = {}) {
  const explicit = [...new Set(
    (Array.isArray(selectedDomains) ? selectedDomains : [])
      .filter((id) => typeof id === "string" && DOMAIN_BY_ID.has(id))
  )];
  if (!autoDetect) return explicit;

  const titleText = String(title || "").toLowerCase();
  const metaText = [
    ...(Array.isArray(goals) ? goals : []),
    ...(Array.isArray(notes) ? notes : []),
    String(notesMarkdown || "").slice(0, 1500)
  ].join(" ").toLowerCase();
  const transcriptText = (Array.isArray(transcript) ? transcript : [])
    .filter((seg) => seg && seg.status !== "provisional" && typeof seg.text === "string")
    .slice(0, 60)
    .map((seg) => seg.text)
    .join(" ")
    .slice(0, 3_000)
    .toLowerCase();

  const scored = [];
  for (const domain of HOTWORD_DOMAINS) {
    if (explicit.includes(domain.id)) continue;
    let score = 0;
    for (const rawTrigger of domain.triggers) {
      const trigger = rawTrigger.toLowerCase();
      if (titleText.includes(trigger)) score += 4;
      if (metaText.includes(trigger)) score += 2;
      if (transcriptText.includes(trigger)) score += 1.2;
    }
    // 转写中若直接命中该领域特有的同音误识别别名，也强力表明属于该领域。
    for (const entry of domain.terms) {
      for (const alias of entry.aliases ?? []) {
        const lower = alias.toLowerCase();
        if (lower.length >= 2 && (titleText.includes(lower) || transcriptText.includes(lower))) {
          score += 3.5;
        }
      }
    }
    if (score >= 3) scored.push({ id: domain.id, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const autoPicked = scored.slice(0, 2).map((item) => item.id);
  return [...explicit, ...autoPicked];
}

/**
 * 收集已激活领域的热词与同音别名映射。
 * 若提供 contextText（如待纠错转写或会议上下文），命中原文/别名的条目会被置顶优先返回。
 */
export function collectDomainHotwords(domainIds = [], { contextText = "", maxTerms = 24 } = {}) {
  const lowerContext = String(contextText || "").toLowerCase();
  const termMap = new Map();
  const aliasMap = new Map();

  for (const id of domainIds) {
    const domain = DOMAIN_BY_ID.get(id);
    if (!domain) continue;
    for (const entry of domain.terms) {
      const key = entry.term.toLowerCase();
      const baseWeight = entry.weight ?? 58;
      let bonus = 0;
      const matchedAliases = [];
      if (lowerContext) {
        if (lowerContext.includes(key)) bonus += 16;
        for (const alias of entry.aliases ?? []) {
          if (alias.length >= 2 && lowerContext.includes(alias.toLowerCase())) {
            bonus += 24;
            matchedAliases.push(alias);
          }
        }
      }
      const weight = baseWeight + bonus;
      const existing = termMap.get(key);
      if (!existing || weight > existing.weight) {
        termMap.set(key, { term: entry.term, weight, domainId: id });
      }
      for (const alias of entry.aliases ?? []) {
        const aliasKey = `${alias.toLowerCase()}=>${key}`;
        if (!aliasMap.has(aliasKey)) {
          aliasMap.set(aliasKey, {
            alias,
            canonical: entry.term,
            domainId: id,
            matchedInText: matchedAliases.includes(alias)
          });
        } else if (matchedAliases.includes(alias)) {
          aliasMap.get(aliasKey).matchedInText = true;
        }
      }
    }
  }

  const terms = [...termMap.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.max(1, maxTerms));
  const aliases = [...aliasMap.values()].sort(
    (a, b) => Number(b.matchedInText) - Number(a.matchedInText)
  );
  return { terms, aliases };
}

/**
 * 解析单条用户自定义术语：
 * - 普通术语："MinuteFlow" -> { term: "MinuteFlow", aliases: [] }
 * - 带同音别名（标准=误听）："MinuteFlow = 密尼特弗洛、迷你特弗洛" -> { term: "MinuteFlow", aliases: ["密尼特弗洛", "迷你特弗洛"] }
 * - 箭头写法（误听->标准）："密尼特弗洛 -> MinuteFlow" -> { term: "MinuteFlow", aliases: ["密尼特弗洛"] }
 */
export function parseGlossaryEntry(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const arrowMatch = text.match(/^(.+?)\s*(?:->|=>|→)\s*(.+)$/);
  if (arrowMatch) {
    const term = arrowMatch[2].trim();
    const aliases = arrowMatch[1]
      .split(/[、,，;；/]+/)
      .map((item) => item.trim())
      .filter((item) => item && item !== term && item.length <= 32);
    if (!term || term.length > 40) return null;
    return { term, aliases: [...new Set(aliases)] };
  }
  const eqMatch = text.match(/^([^=＝｜]+?)\s*[=＝｜]\s*(.+)$/);
  if (eqMatch) {
    const term = eqMatch[1].trim();
    const aliases = eqMatch[2]
      .split(/[、,，;；/]+/)
      .map((item) => item.trim())
      .filter((item) => item && item !== term && item.length <= 32);
    if (!term || term.length > 40) return null;
    return { term, aliases: [...new Set(aliases)] };
  }
  if (text.length > 40) return null;
  return { term: text, aliases: [] };
}

/** 将结构化的术语条目序列化回 preferences.glossary 字符串（向后兼容旧格式）。 */
export function formatGlossaryEntry({ term, aliases = [] }) {
  const cleanTerm = String(term ?? "").trim();
  if (!cleanTerm) return "";
  const cleanAliases = [...new Set(
    (Array.isArray(aliases) ? aliases : [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item && item !== cleanTerm)
  )];
  return cleanAliases.length ? `${cleanTerm} = ${cleanAliases.join("、")}` : cleanTerm;
}
