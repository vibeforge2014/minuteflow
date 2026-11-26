/**
 * 产品官网（Apple 风格克制视觉，暖橙 #E76F51 点缀）：纯浏览器环境渲染的静态站点。
 * 路由：#hash + pathname 混合——首页（#/)、规格页（#/specs/<section>）、
 * 定价/条款/隐私/退款为独立路径页（/pricing/ 等，由托管层直接服务 HTML）。
 * 使用原生文档滚动（与 Electron 固定视口工作台隔离），不提供浏览器版会议演示。
 * 关键区块：Hero、特性信号条、工作区解剖（三栏）、三阶段演示、隐私图解、
 * 平台对比、结尾 CTA、规格页（七节）、政策页四件套、页脚。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import QRCode from "qrcode";
import {
  AppleLogo,
  ArrowUp,
  ArrowRight,
  ArrowUpRight,
  BracketsCurly,
  Check,
  CheckCircle,
  ClockCountdown,
  CloudSlash,
  Copy,
  Cpu,
  Desktop,
  DeviceMobile,
  Export,
  FileText,
  GithubLogo,
  HardDrive,
  List,
  LockKey,
  MagicWand,
  Microphone,
  PlayCircle,
  QrCode,
  ShieldCheck,
  Sparkle,
  Stack,
  Translate,
  UsersThree,
  Waveform,
  WechatLogo,
  WindowsLogo,
  X
} from "@phosphor-icons/react";
import productWorkspace from "./assets/product-workspace.webp";
import productMinutes from "./assets/product-minutes.webp";
import productTranscript from "./assets/product-transcript.webp";
import productVisualSummary from "./assets/product-visual-summary.webp";
import { BrandMark } from "./components/BrandMark";

/** 站点路由：首页 / 规格 / 定价 / 购买 / 找回 / 条款 / 隐私 / 退款。 */
type SiteRoute = "home" | "specs" | "pricing" | "buy" | "recover" | "terms" | "privacy" | "refund";
/** 实机截图展示的四个核心视图：实时双栏 / 正式纪要 / 校对与声纹 / 视觉纪要。 */
type ShowcaseId = "live" | "minutes" | "transcript" | "visual";

/** 桌面版下载入口：按访客系统跳官网稳定下载页（安装包由 zensoft.top dl/ 自有承接）。 */
function desktopDownloadHref(): string {
  const windows = /Windows/i.test(navigator.userAgent) && !/Macintosh/i.test(navigator.userAgent);
  return siteHref(windows ? "/downloads/windows/latest/" : "/downloads/macos/latest/");
}

/** 首页四视图真实截图展示数据。 */
const showcaseViews: {
  id: ShowcaseId;
  tab: string;
  windowTitle: string;
  badge: string;
  title: string;
  description: string;
  points: string[];
  image: string;
  alt: string;
}[] = [
  {
    id: "live",
    tab: "实时双栏",
    windowTitle: "产品团队周会 · 双栏实时工作区",
    badge: "实时记录",
    title: "说话与导入，纪要同步成形。",
    description: "麦克风与系统音频双轨采集，左右双栏独立滚动：左侧逐句实时转写，右侧约每分钟滚动总结，并可随时针对当前会议发起 AI 问答。",
    points: ["8 秒音频块持续落盘 · 异常不丢块", "导入音频同样边转写边出滚动纪要", "悬浮录音栏与一键展开个人笔记"],
    image: productWorkspace,
    alt: "MinuteFlow 双栏实时工作区：左侧实时转写与悬浮录音工具栏，右侧实时总结与 AI 问答输入框"
  },
  {
    id: "minutes",
    tab: "正式纪要",
    windowTitle: "项目复盘：移动端体验优化 · AI 纪要",
    badge: "已核验",
    title: "长会不漏项，每条结论可回溯。",
    description: "自动识别复盘、评审、访谈等会议类型；长会议按语义全量分章提取，高精度模式独立核验数字与责任人，点击时间戳直达原声。",
    points: ["100% 语义分章提取 · 覆盖整场讨论", "独立事实核验 · 自动标注「已核验」", "单章节局部重生成 · 锁定人工编辑"],
    image: productMinutes,
    alt: "MinuteFlow 正式 AI 纪要视图：会议概览、已核验关键结论、结构化对比表与右侧 AI 问答"
  },
  {
    id: "transcript",
    tab: "校对与声纹",
    windowTitle: "项目复盘：移动端体验优化 · 会议转写",
    badge: "AI 校对",
    title: "听得清术语，认得出是谁。",
    description: "内置 5 大行业领域热词库与自定义同音别名，受控 AI 校对严守数值与否定护栏并保留原稿；本地声纹分离并行运行，跨会记忆说话人。",
    points: ["软件 / AI / 金融 / 医疗 / 法律领域热词", "自定义同音别名 · 保留原稿一键撤销", "本地声纹簿 + 单段局部重识别"],
    image: productTranscript,
    alt: "MinuteFlow 智能转写阅读视图：折叠纪要概览、AI 校对工具栏、已校对标记与发言人段落"
  },
  {
    id: "visual",
    tab: "视觉纪要",
    windowTitle: "产品团队周会 · 视觉纪要海报",
    badge: "原生排版",
    title: "一键生成可直接分享的视觉海报。",
    description: "把结构化会议结论自动编排为高可读性的原生视觉纪要，含对比表、状态卡片与重点定调；需要归档或二次编辑时，支持全格式开放导出。",
    points: ["对比表、状态卡与定调高亮自动排版", "支持 Markdown / PDF / DOCX 导出", "支持 SRT / VTT / JSON / ZIP 完整备份"],
    image: productVisualSummary,
    alt: "MinuteFlow 原生视觉纪要海报视图：顶部摘要横幅、方案与风险对比表、系统对接卡片"
  }
];

/** 首页 6 格能力矩阵（精炼呈现 v0.1.49 核心能力）。 */
const capabilityCards = [
  {
    icon: <Cpu size={21} weight="duotone" />,
    title: "多引擎本地转写",
    body: "统一内置 Whisper（whisper.cpp / MLX / Python）、Apple Speech、SenseVoice、Parakeet 与 Qwen3-ASR，模型自动发现与托管下载。"
  },
  {
    icon: <MagicWand size={21} weight="duotone" />,
    title: "领域热词与安全校对",
    body: "一键勾选 5 大行业热词并添加同音别名；受控 AI 语义校对绝不篡改金额、比例与否定词，随时一键还原原稿。"
  },
  {
    icon: <UsersThree size={21} weight="duotone" />,
    title: "并行声纹分离",
    body: "转写与说话人分离并行推进，分段即时回填；支持本地声纹注册，后续会议自动识别同事声音。"
  },
  {
    icon: <BracketsCurly size={21} weight="duotone" />,
    title: "自由自带任意模型",
    body: "本地直连 Ollama，在线原生预设 DeepSeek、Claude、Gemini、OpenAI、通义千问、豆包、智谱、Kimi、MiniMax 与 New API。"
  },
  {
    icon: <PlayCircle size={21} weight="duotone" />,
    title: "歌词级回放与导入队列",
    body: "拖入 MP3、M4A、WAV、MP4 等音视频即可后台队列处理；回放归档录音时，转写段落随进度自动高亮定位。"
  },
  {
    icon: <Stack size={21} weight="duotone" />,
    title: "全文搜索与 Markdown 笔记",
    body: "SQLite FTS5 毫秒级检索会议库，支持收藏置顶、软删除恢复与独立 Markdown 笔记导入编辑。"
  }
];

/** 规格页目录（左侧锚点导航，id 与各 SpecSection 一一对应）。 */
const specSections = [
  { id: "overview", label: "产品概览" },
  { id: "desktop", label: "桌面端" },
  { id: "ios", label: "iPhone 与 iPad" },
  { id: "intelligence", label: "转写与 AI" },
  { id: "data", label: "数据与隐私" },
  { id: "formats", label: "导入与导出" },
  { id: "requirements", label: "系统要求" }
];

/** 官网根组件：按路由切换 首页 / 规格页 / 政策页，装配页头页脚与回顶按钮。 */
export function MarketingSite() {
  const [route, setRoute] = useState<SiteRoute>(() => getRoute());
  const [menuOpen, setMenuOpen] = useState(false);
  // 滚动超过 24px 后导航栏收缩为毛玻璃、回顶按钮出现。
  const [isScrolled, setIsScrolled] = useState(() => window.scrollY > 24);

  // 官网使用原生文档滚动：加 marketing-mode 类以解除桌面工作台的固定视口布局。
  useLayoutEffect(() => {
    document.documentElement.classList.add("marketing-mode");
    document.body.classList.add("marketing-mode");
    return () => {
      document.documentElement.classList.remove("marketing-mode");
      document.body.classList.remove("marketing-mode");
    };
  }, []);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 24);
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // 移动菜单打开时锁定文档滚动，Esc 与页面遮罩都走同一关闭路径。
  useEffect(() => {
    document.body.classList.toggle("site-menu-open", menuOpen);
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.classList.remove("site-menu-open");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  // hash 路由变化（前进/后退/深链）时切换页面并回到顶部；同时收起移动端菜单。
  useEffect(() => {
    let currentRoute = getRoute();
    const handleRoute = () => {
      const nextRoute = getRoute();
      if (nextRoute !== currentRoute) {
        currentRoute = nextRoute;
        setRoute(nextRoute);
        window.scrollTo({ top: 0, behavior: "auto" });
        requestAnimationFrame(() => document.getElementById("main-content")?.focus({ preventScroll: true }));
      }
      setMenuOpen(false);
    };
    window.addEventListener("hashchange", handleRoute);
    return () => window.removeEventListener("hashchange", handleRoute);
  }, []);

  return (
    <div className="marketing-site">
      <a className="site-skip-link" href="#main-content">跳到主要内容</a>
      <SiteHeader
        route={route}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        isScrolled={isScrolled}
      />
      {route === "specs" ? <SpecsPage /> : route === "home" ? <LandingPage /> : route === "buy" ? <BuyPage /> : route === "recover" ? <RecoverPage /> : <PolicyPage route={route} />}
      <SiteFooter />
      <button
        className={`site-scroll-top ${isScrolled ? "is-visible" : ""}`}
        type="button"
        aria-label="返回页面顶部"
        aria-hidden={!isScrolled}
        tabIndex={isScrolled ? 0 : -1}
        onClick={() => {
          window.scrollTo({
            top: 0,
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
          });
        }}
      >
        <ArrowUp size={18} weight="bold" />
      </button>
    </div>
  );
}

/** 顶部导航：品牌、主导航（含首页锚点滚动）、外链（下载/GitHub）、移动端汉堡菜单。 */
function SiteHeader({
  route,
  menuOpen,
  setMenuOpen,
  isScrolled
}: {
  route: SiteRoute;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  isScrolled: boolean;
}) {
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const wasMenuOpen = useRef(false);

  useEffect(() => {
    if (menuOpen) {
      wasMenuOpen.current = true;
      requestAnimationFrame(() => menuRef.current?.querySelector<HTMLAnchorElement>("a")?.focus());
    } else if (wasMenuOpen.current) {
      wasMenuOpen.current = false;
      menuButtonRef.current?.focus();
    }
  }, [menuOpen]);

  return (
    <>
      <header className={`site-header ${isScrolled ? "is-scrolled" : ""}`}>
        <div className="site-nav">
        <a className="site-brand" href={siteHref("/")} aria-label="MinuteFlow首页">
          <BrandMark className="site-brand__mark" size={29} />
          <span>MinuteFlow</span>
        </a>

        <nav ref={menuRef} id="site-navigation" className={`site-links ${menuOpen ? "is-open" : ""}`} aria-label="主导航">
          <a href={siteHref("/")} onClick={() => setMenuOpen(false)} aria-current={route === "home" ? "page" : undefined}>产品</a>
          {route === "home" ? (
            <>
              <a
                href="#features"
                onClick={(event) => {
                  setMenuOpen(false);
                  scrollToSection(event, "features");
                }}
              >
                功能
              </a>
              <a
                href="#privacy"
                onClick={(event) => {
                  setMenuOpen(false);
                  scrollToSection(event, "privacy");
                }}
              >
                隐私
              </a>
            </>
          ) : (
            <a href={siteHref("/#/specs")} onClick={() => setMenuOpen(false)}>概览</a>
          )}
          <a href={siteHref("/#/specs")} onClick={() => setMenuOpen(false)} aria-current={route === "specs" ? "page" : undefined}>规格</a>
          <a href={siteHref("/pricing/")} onClick={() => setMenuOpen(false)} aria-current={route === "pricing" ? "page" : undefined}>定价</a>
          <a href={desktopDownloadHref()} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>
            下载 <ArrowUpRight size={13} />
          </a>
          <a
            href="https://github.com/vibeforge2014/minuteflow"
            target="_blank"
            rel="noreferrer"
            onClick={() => setMenuOpen(false)}
          >
            GitHub <ArrowUpRight size={13} />
          </a>
        </nav>

        <div className="site-nav__actions">
          <button
            ref={menuButtonRef}
            className="site-menu-button"
            type="button"
            aria-label={menuOpen ? "关闭菜单" : "打开菜单"}
            aria-expanded={menuOpen}
            aria-controls="site-navigation"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X size={20} /> : <List size={21} />}
          </button>
        </div>
      </div>
      </header>
      {menuOpen && (
        <button className="site-menu-scrim" type="button" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />
      )}
    </>
  );
}

/** 首页：Hero（实机工作区舞台）→ 核心信号条 → 四视图实机展示 → 能力矩阵 → 隐私 → 平台 → 结尾 CTA。 */
function LandingPage() {
  const [activeView, setActiveView] = useState<ShowcaseId>("live");
  const tabRefs = useRef<Partial<Record<ShowcaseId, HTMLButtonElement | null>>>({});

  const selectShowcase = (id: ShowcaseId, focusTab = false) => {
    setActiveView(id);
    const button = tabRefs.current[id];
    if (button) {
      if (focusTab) button.focus();
      button.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const ids = showcaseViews.map((item) => item.id);
    const currentIndex = ids.indexOf(activeView);
    if (currentIndex < 0) return;
    let nextIndex = -1;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % ids.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + ids.length) % ids.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = ids.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    selectShowcase(ids[nextIndex], true);
  };

  return (
    <main id="main-content" tabIndex={-1}>
      {/* —— Hero：主张、下载与买断按钮、平台徽标、实机桌面端截图 —— */}
      <section className="hero">
        <div className="hero__ambient hero__ambient--one" />
        <div className="hero__ambient hero__ambient--two" />
        <div className="hero__content">
          <div className="eyebrow-chip">
            <span className="status-dot" />
            v0.1.49 · 本地优先 · 为中文会议而生
          </div>
          <h1>会议在流动，<br />好想法不再溜走。</h1>
          <p className="hero__lede">
            录音、导入、实时转写、AI 校对与多阶段核验纪要，都在同一份轻量文档里完成。
          </p>
          <div className="hero__actions">
            <a className="site-button site-button--primary" href={desktopDownloadHref()} target="_blank" rel="noreferrer">
              <Desktop size={17} weight="bold" /> 下载桌面版
            </a>
            <a className="site-button site-button--ghost" href={siteHref("/pricing/")}>
              ¥99 一次买断 <ArrowRight size={15} />
            </a>
          </div>
          <div className="hero__meta" aria-label="平台与隐私特性">
            <span><AppleLogo size={16} weight="fill" /> macOS 14.2+ 已公证</span>
            <span><WindowsLogo size={16} weight="fill" /> Windows 10 22H2+</span>
            <span><LockKey size={16} weight="fill" /> 数据默认留在本机</span>
          </div>
        </div>

        <div className="product-stage" aria-label="MinuteFlow 桌面端实机界面预览">
          <div className="product-stage__glow" />
          <div className="product-window">
            <div className="product-window__bar">
              <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
              <span>产品团队周会 · 双栏实时工作区</span>
              <span className="window-live"><i /> LIVE</span>
            </div>
            <img
              src={productWorkspace}
              alt="MinuteFlow 桌面端双栏实时会议工作区：左侧实时转写与悬浮录音栏，右侧实时总结与 AI 问答"
              width={1440}
              height={900}
              fetchPriority="high"
            />
          </div>
          <div className="floating-note floating-note--summary">
            <span className="floating-note__icon"><Sparkle size={16} weight="fill" /></span>
            <span><strong>多阶段 AI 纪要</strong><small>独立事实核验 · 时间戳回链</small></span>
          </div>
          <div className="floating-note floating-note--private">
            <span className="floating-note__icon floating-note__icon--green"><ShieldCheck size={17} weight="fill" /></span>
            <span><strong>本地优先存储</strong><small>未配置模型绝不上传</small></span>
          </div>
        </div>
      </section>

      {/* —— 特性信号条：多引擎转写 / 热词校对 / 核验纪要 / 一次买断 —— */}
      <section className="signal-strip" aria-label="核心特性">
        <div><Waveform size={21} /><span><strong>多引擎本地转写</strong> Whisper · Apple · SenseVoice</span></div>
        <div><MagicWand size={21} /><span><strong>热词与 AI 校对</strong> 5 大领域热词 · 留原稿</span></div>
        <div><Sparkle size={21} /><span><strong>多阶段核验纪要</strong> 长会分章 · 视觉海报</span></div>
        <div><CloudSlash size={21} /><span><strong>本地优先买断</strong> 数据存本机 · ¥99 无订阅</span></div>
      </section>

      {/* —— 四视图实机展示：实时双栏 / 正式纪要 / 校对与声纹 / 视觉纪要 —— */}
      <section className="site-section showcase-section" id="features">
        <div className="section-heading section-heading--center">
          <span className="section-kicker">实机界面一览</span>
          <h2>从第一句话到会议交付，<br />每个环节都清晰可见。</h2>
          <p>切换下方视图，查看实时双栏记录、独立核验纪要、AI 校对转写与原生视觉海报。</p>
        </div>

        <div className="showcase-tabs-wrap">
          <div
            className="showcase-tabs"
            role="tablist"
            aria-label="核心工作视图"
            onKeyDown={handleTabKeyDown}
          >
            {showcaseViews.map((item) => {
              const selected = activeView === item.id;
              return (
                <button
                  key={item.id}
                  ref={(node) => { tabRefs.current[item.id] = node; }}
                  type="button"
                  role="tab"
                  id={`showcase-tab-${item.id}`}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectShowcase(item.id)}
                >
                  {item.tab}
                </button>
              );
            })}
          </div>
        </div>

        <div className="showcase-panels">
          {showcaseViews.map((item) => {
            const selected = activeView === item.id;
            return (
              <div
                key={item.id}
                role="tabpanel"
                aria-labelledby={`showcase-tab-${item.id}`}
                hidden={!selected}
                tabIndex={selected ? 0 : undefined}
              >
                <div className="showcase-panel__inner">
                  <div className="showcase-panel__header">
                    <div className="showcase-panel__copy">
                      <span className="showcase-badge">{item.badge}</span>
                      <h3>{item.title}</h3>
                      <p>{item.description}</p>
                    </div>
                    <ul className="showcase-panel__points">
                      {item.points.map((point) => (
                        <li key={point}><CheckCircle size={17} weight="fill" /> {point}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="showcase-frame">
                    <div className="product-window__bar">
                      <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
                      <span>{item.windowTitle}</span>
                      <span className="showcase-frame__tag">{item.badge}</span>
                    </div>
                    <img
                      src={item.image}
                      alt={item.alt}
                      width={1440}
                      height={900}
                      loading="lazy"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* —— 6 格核心能力矩阵 —— */}
      <section className="site-section capabilities-section">
        <div className="section-heading">
          <span className="section-kicker">全链路质量增强</span>
          <h2>不是简单的录音转文字，<br />而是为准确度设计的流水线。</h2>
        </div>

        <div className="capability-grid">
          {capabilityCards.map((card) => (
            <article className="capability-card" key={card.title}>
              <span className="capability-card__icon">{card.icon}</span>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* —— 隐私区块：本地优先数据流图（本机资料库 → 仅有配置后才发送） —— */}
      <section className="site-section privacy-section" id="privacy">
        <div className="privacy-card">
          <div className="privacy-card__copy">
            <span className="section-kicker section-kicker--light">隐私不是设置项，是默认值</span>
            <h2>你的会议，<br />首先属于你的设备。</h2>
            <p>
              录音、逐字稿、声纹簿、个人笔记与全文索引全部默认存储在本地。
              支持全本地转写与 Ollama 离线总结；仅当你主动配置在线模型时，才按任务发送必要文本。
            </p>
            <a href="#/specs" className="text-link text-link--light">
              阅读数据与隐私规格 <ArrowRight size={16} />
            </a>
          </div>
          <div className="privacy-diagram" aria-label="本地优先数据流">
            <div className="privacy-device">
              <HardDrive size={31} weight="duotone" />
              <strong>本机资料库</strong>
              <span>录音 · 转录 · 声纹 · 笔记</span>
            </div>
            <div className="privacy-flow">
              <span>仅在你配置后</span>
              <i><ArrowRight size={18} /></i>
            </div>
            <div className="privacy-provider">
              <BracketsCurly size={29} weight="duotone" />
              <strong>你选择的模型</strong>
              <span>Ollama 或自有 API 密钥</span>
            </div>
          </div>
        </div>
      </section>

      {/* —— 平台对比：桌面双栏/三栏工作区 vs iPhone/iPad 原生 SwiftUI —— */}
      <section className="site-section platform-section">
        <div className="section-heading">
          <span className="section-kicker">桌面深度工作，移动随身捕捉</span>
          <h2>熟悉的工作方式，<br />适配每一块屏幕。</h2>
        </div>
        <div className="platform-grid">
          <article className="platform-card platform-card--desktop">
            <div className="platform-card__top">
              <span className="platform-icon"><Desktop size={24} weight="duotone" /></span>
              <span>macOS 已公证 · Windows x64</span>
            </div>
            <h3>双栏实时与会后整理</h3>
            <p>麦克风与系统音频双轨录制、非阻塞音频导入队列、本地多引擎转写、声纹分离与应用内自动更新。</p>
            <div className="desktop-mini">
              <i /><b /><span />
            </div>
          </article>
          <article className="platform-card platform-card--mobile">
            <div className="platform-card__top">
              <span className="platform-icon platform-icon--orange"><DeviceMobile size={24} weight="duotone" /></span>
              <span>iPhone · iPad</span>
            </div>
            <h3>原生 SwiftUI 体验</h3>
            <p>iPhone 极简记录、iPad 三栏工作区；支持后台连续录音、中断自动恢复与停录后 Apple Speech 断档补转。</p>
            <div className="mobile-mini">
              <i /><b /><span />
            </div>
          </article>
        </div>
      </section>

      {/* —— 结尾 CTA —— */}
      <section className="closing-cta">
        <div className="closing-cta__orb" />
        <span className="section-kicker">少一点整理，多一点推进</span>
        <h2>下一场会议，<br />让结果自然留下来。</h2>
        <p>下载桌面版即可开始本地记录；¥99 一次买断，最多激活 2 台个人设备。</p>
        <div className="hero__actions">
          <a className="site-button site-button--primary" href={desktopDownloadHref()} target="_blank" rel="noreferrer">
            <Desktop size={17} weight="bold" /> 下载桌面版
          </a>
          <a className="site-button site-button--ghost" href={siteHref("/pricing/")}>
            查看定价与授权
          </a>
        </div>
      </section>
    </main>
  );
}

/**
 * 规格页：左侧锚点目录 + 七个章节（概览/桌面端/iOS/转写与AI/数据与隐私/导入导出/系统要求）。
 * 支持 #/specs/<section> 深链直滚；滚动时目录联动高亮当前章节。
 */
function SpecsPage() {
  const [activeSection, setActiveSection] = useState("overview");

  // 进入页面时处理深链（#/specs/<id>），等一帧让布局完成再滚动定位。
  useEffect(() => {
    const requestedSection = window.location.hash.split("/")[2];
    if (!specSections.some(({ id }) => id === requestedSection)) return;
    window.requestAnimationFrame(() => {
      document.getElementById(requestedSection)?.scrollIntoView({ behavior: "auto", block: "start" });
    });
  }, []);

  // 滚动监听：把「顶部已滚过 150px 的最后一个章节」视为当前章节，驱动目录高亮。
  useEffect(() => {
    const onScroll = () => {
      const candidates = specSections
        .map(({ id }) => ({ id, element: document.getElementById(id) }))
        .filter((item): item is { id: string; element: HTMLElement } => Boolean(item.element));
      const current = [...candidates].reverse().find(({ element }) => element.getBoundingClientRect().top <= 150);
      if (current) setActiveSection(current.id);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <main className="spec-page" id="main-content" tabIndex={-1}>
      <section className="spec-hero">
        <span className="eyebrow-chip"><FileText size={15} weight="fill" /> 产品规格 · v0.1.49</span>
        <h1>功能边界，<br />清清楚楚。</h1>
        <p>从多引擎本地转写、领域热词校对、说话人声纹分离到多阶段核验纪要，一页了解 MinuteFlow 当前版本的完整能力。</p>
        <div className="spec-hero__meta">
          <span><CheckCircle size={17} weight="fill" /> 已发布并签名公证</span>
          <span><Stack size={17} weight="fill" /> 本地优先架构</span>
          <span><Translate size={17} weight="fill" /> 中文 / 中英混合优先</span>
        </div>
      </section>

      <div className="spec-layout">
        <aside className="spec-sidebar" aria-label="规格章节">
          <span>页面目录</span>
          {specSections.map((section) => (
            <a
              key={section.id}
              href={`#/specs/${section.id}`}
              className={activeSection === section.id ? "is-active" : ""}
              aria-current={activeSection === section.id ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                window.history.replaceState(null, "", `#/specs/${section.id}`);
                document.getElementById(section.id)?.scrollIntoView({
                  block: "start",
                  behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
                });
              }}
            >
              {section.label}
            </a>
          ))}
        </aside>

        <div className="spec-content">
          <SpecSection
            id="overview"
            index="01"
            kicker="产品概览"
            title="一份围绕会议持续生长的文档"
            intro="MinuteFlow 是本地优先的跨平台会议工作台，把双轨录音、音频导入、智能转写校对、声纹分离、核验纪要与 AI 问答统一在同一份文档里。"
          >
            <div className="spec-summary-grid">
              <SpecMetric icon={<Desktop />} label="桌面端" value="macOS + Windows" />
              <SpecMetric icon={<DeviceMobile />} label="移动端" value="iPhone + iPad" />
              <SpecMetric icon={<ClockCountdown />} label="滚动纪要" value="默认约每 60 秒" />
              <SpecMetric icon={<LockKey />} label="数据策略" value="默认只存本地" />
            </div>
            <SpecTable rows={[
              ["产品形态", "Electron 桌面应用（macOS 已公证支持应用内自动更新，Windows x64 安装包）；原生 SwiftUI iOS / iPadOS 应用"],
              ["首发语言", "简体中文；重点优化中文与中英混合会议"],
              ["核心工作流", "录音 / 拖拽导入 → 多引擎转写 → 热词与 AI 校对 → 声纹分离 → 滚动 & 正式核验纪要 → 视觉海报 / 导出"],
              ["账号要求", "无需云端账号，离线可完成录音、笔记、本地转写与检索"],
              ["授权方式", "¥99 一次性买断，支持最多 2 台个人设备，7 天退款保证"]
            ]} />
          </SpecSection>

          <SpecSection
            id="desktop"
            index="02"
            kicker="桌面端"
            title="为长时间会议设计的完整工作区"
            intro="现场录音与导入音频共用双栏实时工作区，会后自动切入轻量正式纪要与阅读层级转写视图，右侧随时唤出会议 AI 问答。"
          >
            <FeatureRows rows={[
              { icon: <Microphone />, title: "双轨录音与防丢块补转", body: "分别采集麦克风与桌面系统音频；8 秒音频块持续安全落盘，模型未就绪或短暂异常时自动排队补转不丢段。", badge: "Windows / macOS" },
              { icon: <Waveform />, title: "AI 校对与声纹识别", body: "内置 5 大领域热词与自定义同音别名；受控 AI 语义校对严守数值/否定护栏并留存原稿；后台并行声纹分离与本地声纹簿跨会匹配。", badge: "支持局部重识别" },
              { icon: <Sparkle />, title: "多阶段核验纪要与视觉海报", body: "自动识别会议类型，长会议 100% 语义分章提取并独立事实核验；支持单章节重生成、原文时间戳回链与一键原生视觉纪要海报。", badge: "已核验 + 海报" },
              { icon: <FileText />, title: "可编辑文档与 Markdown 笔记", body: "个人笔记完整保留 Markdown 源码并支持 .md 导入；归档音频播放器支持歌词式段落高亮联动。", badge: "自动保存" },
              { icon: <Stack />, title: "资料库与会议 AI 问答", body: "SQLite FTS5 全文搜索、收藏、软删除恢复；围绕当前会议纪要与转写直接提问并可按时间戳回看原声。", badge: "SQLite / FTS5" }
            ]} />
          </SpecSection>

          <SpecSection
            id="ios"
            index="03"
            kicker="iPhone 与 iPad"
            title="原生、随身，并尊重系统边界"
            intro="iOS 版采用 SwiftUI 与 SwiftData，iPhone 极简双栏导航，iPad 自适应三栏工作区，并针对移动场景做了后台稳录与断档补转。"
          >
            <div className="ios-callout">
              <ShieldCheck size={25} weight="duotone" />
              <div>
                <strong>清晰的录音边界</strong>
                <p>iOS 版仅录制麦克风，不会暗示或尝试捕获其他 App 的受保护系统音频。</p>
              </div>
            </div>
            <SpecTable rows={[
              ["最低系统", "iOS / iPadOS 18+"],
              ["界面", "iPhone 双标签导航与手势弹层问答；iPad 三栏工作区"],
              ["后台与恢复", "支持后台连续录音、通话/Siri 中断自动恢复及停录后断档补转"],
              ["本地数据", "SwiftData"],
              ["内置转写", "Apple Speech"],
              ["模型密钥", "Keychain"],
              ["移动端导出", "Markdown、TXT、SRT、JSON"],
              ["音频采集", "仅麦克风"]
            ]} />
          </SpecSection>

          <SpecSection
            id="intelligence"
            index="04"
            kicker="转写与 AI"
            title="模型由你选择，质量层层把关"
            intro="所有新生成的纪要、校对与问答均由你配置的本地或在线模型产出，不混入规则凑数；未配置远程服务时不向外部发送任何会议内容。"
          >
            <div className="provider-grid">
              <div>
                <span className="provider-grid__icon"><HardDrive size={22} /></span>
                <h3>本地转写</h3>
                <p>Whisper（whisper.cpp / MLX / Python）、Apple Speech、SenseVoice、Parakeet、Qwen3-ASR</p>
              </div>
              <div>
                <span className="provider-grid__icon"><BracketsCurly size={22} /></span>
                <h3>远程转写</h3>
                <p>OpenAI Whisper、New API 及兼容音频接口</p>
              </div>
              <div>
                <span className="provider-grid__icon"><Sparkle size={22} /></span>
                <h3>本机与在线总结</h3>
                <p>Ollama 本地模型；DeepSeek、Claude、Gemini、OpenAI、通义千问、豆包、智谱、Kimi、MiniMax、New API</p>
              </div>
              <div>
                <span className="provider-grid__icon"><MagicWand size={22} /></span>
                <h3>热词与事实核验</h3>
                <p>5 大行业热词、自定义同音别名、受控语义校对与高精度独立事实核验</p>
              </div>
            </div>
            <SpecTable rows={[
              ["转录上下文", "中英混合识别、5 大行业领域热词、自定义术语同音别名、单段局部重识别"],
              ["总结输入", "会议主题、参会人、个人笔记、转写逐字稿与长会语义分章上下文"],
              ["更新策略", "会中默认每 60 秒滚动更新，导入音频达阈值即刻出稿；会后按需生成正式纪要与视觉海报"],
              ["冲突保护", "支持单章节局部重生成，手动锁定内容与文档版本保护"],
              ["连接测试", "保存模型前可验证服务地址、模型名与凭据，支持识别 Base URL 自动套用预设"]
            ]} />
          </SpecSection>

          <SpecSection
            id="data"
            index="05"
            kicker="数据与隐私"
            title="默认本地，联网透明"
            intro="本地存储不是离线模式下的退路，而是产品的默认架构。远程能力是由用户明确开启的可选项。"
          >
            <FeatureRows rows={[
              { icon: <HardDrive />, title: "本地资料库", body: "会议、逐字稿、声纹簿、笔记、索引与录音默认保存在应用数据目录。", badge: "默认" },
              { icon: <LockKey />, title: "安全凭据", body: "桌面端使用系统安全存储（safeStorage），iOS 使用 Keychain 保存第三方 API 凭据。", badge: "密钥不入文档" },
              { icon: <CloudSlash />, title: "无静默上传", body: "未配置远程模型时不上传会议内容；配置后仅向所选服务发送对应任务所需输入。", badge: "用户控制" },
              { icon: <ShieldCheck />, title: "可管理保留周期", body: "可设置录音保留周期；删除使用软删除机制，避免误操作造成即时丢失。", badge: "可恢复" }
            ]} />
          </SpecSection>

          <SpecSection
            id="formats"
            index="06"
            kicker="导入与导出"
            title="信息进得来，也带得走"
            intro="拖拽或选择常见音视频文件即可进入非阻塞导入队列，处理期间仍可正常浏览其他会议；支持多格式开放导出。"
          >
            <div className="format-columns">
              <div>
                <span>可导入</span>
                <div>{["MP3", "M4A", "WAV", "FLAC", "OGG", "WebM", "MP4", "MOV", "Markdown (.md)"].map((item) => <b key={item}>{item}</b>)}</div>
              </div>
              <div>
                <span>桌面端可导出</span>
                <div>{["Markdown", "PDF", "DOCX", "SRT", "VTT", "JSON", "ZIP"].map((item) => <b key={item}>{item}</b>)}</div>
              </div>
            </div>
          </SpecSection>

          <SpecSection
            id="requirements"
            index="07"
            kicker="系统要求"
            title="当前版本支持范围"
            intro="macOS 发布包已完成 Developer ID 签名与 Apple 公证，支持应用内静默更新；Windows 提供标准 x64 安装程序。"
          >
            <SpecTable rows={[
              ["macOS", "14.2 或更高版本（Apple Silicon 签名公证，支持应用内自动更新）"],
              ["Windows", "Windows 10 22H2 或更高版本（Windows x64 安装包）"],
              ["iPhone / iPad", "iOS / iPadOS 18 或更高版本"],
              ["桌面运行时", "Electron"],
              ["本地模型", "支持自动发现与托管下载，音频与转写工具随应用引导就绪"],
              ["远程服务", "可选，由用户自行提供兼容服务地址与 API 凭据"]
            ]} />
            <div className="spec-endcap">
              <div>
                <span>准备好亲自试试了吗？</span>
                <strong>下载桌面版，用本地工作台开启下一场会议。</strong>
              </div>
              <a className="site-button site-button--primary" href={desktopDownloadHref()} target="_blank" rel="noreferrer">
                下载桌面版 <ArrowUpRight size={16} weight="bold" />
              </a>
            </div>
          </SpecSection>
        </div>
      </div>
    </main>
  );
}

/** 规格页章节骨架：编号 + kicker + 标题 + 引言 + 内容体（id 供锚点定位）。 */
function SpecSection({
  id,
  index,
  kicker,
  title,
  intro,
  children
}: {
  id: string;
  index: string;
  kicker: string;
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <section className="spec-section" id={id}>
      <div className="spec-section__heading">
        <span>{index}</span>
        <div>
          <small>{kicker}</small>
          <h2>{title}</h2>
          <p>{intro}</p>
        </div>
      </div>
      <div className="spec-section__body">{children}</div>
    </section>
  );
}

/** 规格页指标卡（图标 + 标签 + 值）。 */
function SpecMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="spec-metric">
      <span>{icon}</span>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

/** 规格页键值表格（label → value 两列行）。 */
function SpecTable({ rows }: { rows: string[][] }) {
  return (
    <div className="spec-table">
      {rows.map(([label, value]) => (
        <div className="spec-table__row" key={label}>
          <strong>{label}</strong>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

/** 特性行列表（图标 + 标题 + 描述 + 角标）。 */
function FeatureRows({
  rows
}: {
  rows: { icon: React.ReactNode; title: string; body: string; badge: string }[];
}) {
  return (
    <div className="feature-rows">
      {rows.map((row) => (
        <div className="feature-row" key={row.title}>
          <span className="feature-row__icon">{row.icon}</span>
          <div><strong>{row.title}</strong><p>{row.body}</p></div>
          <b>{row.badge}</b>
        </div>
      ))}
    </div>
  );
}

type PolicyRoute = Exclude<SiteRoute, "home" | "specs" | "buy" | "recover">;

// ---------------------------------------------------------------------------
// 购买页：选择通道 → 生成二维码 → 轮询订单 → 支付成功展示激活码
// ---------------------------------------------------------------------------
type BuyChannel = "wechat" | "alipay" | "mock";
type BuyOrder = {
  orderId: string;
  channel: BuyChannel;
  state: string;
  type?: string;
  payload: string;
  amountFen: number;
  discountCode?: string;
  listAmountFen?: number;
  discountFen?: number;
  expiresAt: string;
  licenseKey?: string;
  customerEmailMasked?: string;
  // 支付落账后异步发信：只有服务端确认发出才是 true。
  emailSent?: boolean;
};

/** 授权后端地址：生产与官网同域（nginx /api/license），本地联调直连 8787。 */
function licenseApiRoot(): string {
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
    ? "http://127.0.0.1:8787"
    : "";
}

/** 购买页：扫码收银台。订单金额由服务端固定（¥99），页面只负责发起与轮询。 */
function BuyPage() {
  const [channels, setChannels] = useState<{ wechat: boolean; alipay: boolean; mock: boolean } | null>(null);
  const [priceFen, setPriceFen] = useState(9_900);
  const [loadError, setLoadError] = useState(false);
  const [order, setOrder] = useState<BuyOrder | null>(null);
  const [qrSrc, setQrSrc] = useState("");
  const [busyChannel, setBusyChannel] = useState<BuyChannel | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  // 每个订单只盯一次发信结果，避免重试中的 setOrder 重新触发轮询。
  const emailWatchRef = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // 折扣码（ZenSoft 管理后台生成）：仅服务端校验与计价，这里只保存应用结果。
  const [discountsReady, setDiscountsReady] = useState(false);
  const [discount, setDiscount] = useState<{ code: string; listAmountFen: number; amountFen: number; discountFen: number } | null>(null);
  const [discountInput, setDiscountInput] = useState("");
  const [discountBusy, setDiscountBusy] = useState(false);
  const [discountError, setDiscountError] = useState("");
  // 选填购买邮箱：随订单存到服务端，用于激活码找回；本地记住，下次购买免填。
  const [email, setEmail] = useState(() => {
    try { return window.localStorage.getItem("mf:buy-email") ?? ""; } catch { return ""; }
  });

  // 回跳续单：支付宝电脑网站支付付款后经 return_url（?order=<id>）回到本页，
  // 直接恢复该订单的轮询；读完后立刻抹掉查询参数避免刷新/分享时重复进入。
  useEffect(() => {
    const resumeId = new URLSearchParams(window.location.search).get("order");
    if (!resumeId || !/^[0-9a-f-]{36}$/i.test(resumeId)) return;
    window.history.replaceState(null, "", window.location.pathname);
    let cancelled = false;
    fetch(`${licenseApiRoot()}/api/license/orders/${resumeId}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("bad status"))))
      .then((view) => {
        if (!cancelled && view?.orderId) setOrder(view);
        else if (!cancelled) setError("未找到对应的订单，请重新发起支付。");
      })
      .catch(() => {
        if (!cancelled) setError("暂时无法查询订单状态，请稍后刷新重试。");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 通道就绪态：决定渲染微信/支付宝按钮与沙箱徽标。
  useEffect(() => {
    let cancelled = false;
    fetch(`${licenseApiRoot()}/api/license/healthz`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("bad status"))))
      .then((payload) => {
        if (!cancelled) {
          setChannels(payload.channels ?? { wechat: false, alipay: false, mock: false });
          if (Number.isFinite(payload.amountFen) && payload.amountFen > 0) setPriceFen(payload.amountFen);
          // 折扣码后端未配置时隐藏输入，只按原价卖。
          setDiscountsReady(Boolean(payload.discounts));
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 二维码渲染（redirect 型订单跳收银台，不出二维码）。
  useEffect(() => {
    if (!order?.payload || order.type === "redirect") {
      setQrSrc("");
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(order.payload, { margin: 1, width: 464, color: { dark: "#1f1a17", light: "#ffffff" } })
      .then((url) => {
        if (!cancelled) setQrSrc(url);
      })
      .catch(() => {
        if (!cancelled) setQrSrc("");
      });
    return () => {
      cancelled = true;
    };
  }, [order?.payload]);

  // 2 秒轮询订单状态，直到 paid / expired。
  useEffect(() => {
    if (!order || order.state !== "created") return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${licenseApiRoot()}/api/license/orders/${order.orderId}`);
        if (!response.ok) return;
        const view = await response.json();
        if (!cancelled && view.state !== "created") setOrder(view);
      } catch {
        // 网络抖动：等待下一拍。
      }
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [order]);

  // 服务端发信失败会自行重试（5s/20s）：付款页短暂补拍，让提示反映真实结果。
  useEffect(() => {
    if (!order || order.state !== "paid" || !order.customerEmailMasked || order.emailSent) return;
    if (emailWatchRef.current === order.orderId) return;
    emailWatchRef.current = order.orderId;
    let attempts = 0;
    const timer = window.setInterval(async () => {
      attempts += 1;
      try {
        const response = await fetch(`${licenseApiRoot()}/api/license/orders/${order.orderId}`);
        if (response.ok) {
          const view = await response.json();
          if (view.state === "paid") {
            setOrder(view);
            if (view.emailSent) window.clearInterval(timer);
          }
        }
      } catch {
        // 网络抖动：等待下一拍。
      }
      if (attempts >= 6) window.clearInterval(timer);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [order]);

  // 倒计时心跳（created 状态下每秒刷新剩余时间）。
  useEffect(() => {
    if (!order || order.state !== "created") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [order]);

  // 折扣码试算：服务端按当前售价复算应付金额；下单时服务端会再次校验。
  async function requestQuote(code: string) {
    const response = await fetch(`${licenseApiRoot()}/api/license/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ discountCode: code })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.code || !Number.isFinite(payload?.amountFen)) {
      throw new Error(payload?.error ?? "折扣码校验失败，请稍后重试。");
    }
    return {
      code: String(payload.code),
      listAmountFen: Number(payload.listAmountFen ?? priceFen),
      amountFen: Number(payload.amountFen),
      discountFen: Number(payload.discountFen ?? 0)
    };
  }

  // 从桌面付费墙带 ?discount= 进入时自动套用，用户落地即看到折后应付金额。
  useEffect(() => {
    const fromApp = new URLSearchParams(window.location.search).get("discount");
    const code = String(fromApp ?? "").trim().toUpperCase();
    if (!code) return undefined;
    let cancelled = false;
    setDiscountInput(code);
    setDiscountBusy(true);
    setDiscountError("");
    requestQuote(code)
      .then((quote) => {
        if (cancelled) return;
        setDiscount(quote);
        setDiscountInput("");
      })
      .catch((caught: unknown) => {
        if (!cancelled) setDiscountError(caught instanceof Error ? caught.message : "折扣码校验失败，请稍后重试。");
      })
      .finally(() => {
        if (!cancelled) setDiscountBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // 仅在落地时执行一次；priceFen 变化不应重复套用同一折扣码。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function applyDiscount() {
    const code = discountInput.trim().toUpperCase();
    if (!code) {
      setDiscountError("请输入折扣码。");
      return;
    }
    setDiscountBusy(true);
    setDiscountError("");
    try {
      setDiscount(await requestQuote(code));
      setDiscountInput("");
    } catch (caught) {
      setDiscountError(caught instanceof Error ? caught.message : "折扣码校验失败，请稍后重试。");
    } finally {
      setDiscountBusy(false);
    }
  }

  async function createOrder(channel: BuyChannel) {
    setBusyChannel(channel);
    setError("");
    setCopied(false);
    try {
      const trimmedEmail = email.trim();
      try { window.localStorage.setItem("mf:buy-email", trimmedEmail); } catch { /* 隐私模式忽略 */ }
      const response = await fetch(`${licenseApiRoot()}/api/license/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, email: trimmedEmail, discountCode: discount?.code ?? "" })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.orderId) {
        setError(payload?.error ?? "下单失败，请稍后重试。");
        return;
      }
      setOrder(payload);
      // 支付宝电脑网站支付：整页跳转支付宝收银台，付款后经 return_url 带订单号回来续轮询。
      if (payload.type === "redirect" && payload.payload) {
        window.location.assign(payload.payload);
      }
    } catch {
      setError("暂时无法连接支付服务，请检查网络后重试。");
    } finally {
      setBusyChannel(null);
    }
  }

  async function copyLicenseKey() {
    if (!order?.licenseKey) return;
    try {
      await navigator.clipboard.writeText(order.licenseKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // 剪贴板被拒绝：用户可手动选中复制。
    }
  }

  const remainingMs = order?.state === "created" ? Math.max(0, Date.parse(order.expiresAt) - now) : 0;
  const remainingLabel = `${Math.floor(remainingMs / 60_000)}:${String(Math.floor((remainingMs % 60_000) / 1_000)).padStart(2, "0")}`;
  // 售价只信服务端：订单金额优先，折扣码试算结果次之，最后才是 healthz 下发的当前售价。
  const formatFen = (fen: number) => `¥${(fen / 100).toFixed(fen % 100 === 0 ? 0 : 2)}`;
  const amountLabel = formatFen(order?.amountFen ?? discount?.amountFen ?? priceFen);
  const channelLabel = order?.channel === "alipay" ? "支付宝" : order?.channel === "mock" ? "沙箱支付" : "微信支付";

  return (
    <main id="main-content" className="buy-page" tabIndex={-1}>
      <header className="buy-hero">
        <span className="section-kicker">购买 MinuteFlow</span>
        <h1>
          {formatFen(discount?.amountFen ?? priceFen)}，一次买断。
          {discount && <s className="buy-list-price" aria-label={`原价 ${formatFen(priceFen)}`}>{formatFen(priceFen)}</s>}
        </h1>
        <p>扫码支付后立即获得激活码，可在最多 2 台你个人的设备上使用。支付由微信支付 / 支付宝安全处理，7 天内支持退款。</p>
        {channels?.mock && <span className="buy-sandbox">沙箱模式 · 商户通道联调中，支付不会产生真实扣款</span>}
      </header>
      <div className="buy-card">
        {loadError && (
          <div className="buy-fallback">
            <p>支付服务暂时不可用，请稍后刷新重试。</p>
            <a className="site-button site-button--ghost" href={siteHref("/buy/")} onClick={(event) => {
              event.preventDefault();
              setLoadError(false);
              window.location.reload();
            }}>重新加载</a>
          </div>
        )}
        {!loadError && !order && (
          <>
          <div className="buy-email">
            <label htmlFor="buy-email">邮箱（选填）</label>
            <input
              id="buy-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="用于接收激活码和找回，可不填"
              value={email}
              maxLength={254}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          {discountsReady && (discount ? (
            <div className="buy-discount buy-discount--applied" role="status">
              <span>
                折扣码 <b>{discount.code}</b> 已应用，已减 {formatFen(discount.discountFen)}，应付 {formatFen(discount.amountFen)}
              </span>
              <button type="button" className="buy-discount-remove" onClick={() => setDiscount(null)}>取消</button>
            </div>
          ) : (
            <div className="buy-discount">
              <label htmlFor="buy-discount">折扣码（选填）</label>
              <div className="buy-discount-row">
                <input
                  id="buy-discount"
                  value={discountInput}
                  placeholder="输入折扣码立减"
                  maxLength={32}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={discountError ? true : undefined}
                  onChange={(event) => setDiscountInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void applyDiscount();
                    }
                  }}
                />
                <button type="button" onClick={() => void applyDiscount()} disabled={discountBusy || busyChannel !== null}>
                  {discountBusy ? "校验中…" : "使用"}
                </button>
              </div>
              {discountError && <p className="buy-discount-error" role="alert">{discountError}</p>}
            </div>
          ))}
          <div className="buy-channels" role="group" aria-label="选择支付方式">
            <button
              type="button"
              className="buy-channel"
              disabled={!channels?.wechat || busyChannel !== null}
              onClick={() => void createOrder("wechat")}
            >
              <WechatLogo size={30} weight="fill" aria-hidden />
              <span>微信支付</span>
              <small>{channels?.wechat ? `${amountLabel} · 扫码支付` : "暂未开通"}</small>
            </button>
            <button
              type="button"
              className="buy-channel buy-channel--alipay"
              disabled={!channels?.alipay || busyChannel !== null}
              onClick={() => void createOrder("alipay")}
            >
              <QrCode size={30} weight="bold" aria-hidden />
              <span>支付宝</span>
              <small>{channels?.alipay ? `${amountLabel} · 跳转支付宝收银台` : "暂未开通"}</small>
            </button>
            {channels?.mock && (
              <button
                type="button"
                className="buy-channel buy-channel--mock"
                disabled={busyChannel !== null}
                onClick={() => void createOrder("mock")}
              >
                <Sparkle size={26} weight="fill" aria-hidden />
                <span>沙箱通道</span>
                <small>联调用 · 3 秒自动支付</small>
              </button>
            )}
          </div>
          </>
        )}
        {!loadError && order && order.state === "created" && order.type === "redirect" && (
          <div className="buy-qr">
            <strong>支付宝 · {amountLabel}</strong>
            <p className="buy-status">
              <span className="buy-dots" aria-hidden><i /><i /><i /></span>
              已跳转支付宝收银台，付款完成后本页会自动显示激活码
            </p>
            <button type="button" className="buy-regenerate" onClick={() => window.location.assign(order.payload)}>
              没有跳转？重新打开支付宝收银台
            </button>
          </div>
        )}
        {!loadError && order && order.state === "created" && order.type !== "redirect" && (
          <div className="buy-qr">
            <strong>{channelLabel} · {amountLabel}</strong>
            {qrSrc ? <img src={qrSrc} alt={`${channelLabel}付款二维码`} width={232} height={232} /> : <span className="buy-qr--pending" aria-hidden />}
            <p className="buy-status">
              <span className="buy-dots" aria-hidden><i /><i /><i /></span>
              等待支付 · 二维码 <b className="buy-countdown">{remainingLabel}</b> 内有效
            </p>
            <button type="button" className="buy-regenerate" onClick={() => void createOrder(order.channel)}>
              二维码过期？重新生成
            </button>
          </div>
        )}
        {!loadError && order && order.state === "expired" && (
          <div className="buy-qr">
            <strong>{order.type === "redirect" ? "订单已过期" : "二维码已过期"}</strong>
            <p className="buy-status">订单超时未支付，点击下方重新发起支付。</p>
            <button type="button" className="site-button site-button--primary" onClick={() => void createOrder(order.channel)}>
              重新发起支付
            </button>
          </div>
        )}
        {!loadError && order && order.state === "refunded" && (
          <div className="buy-qr">
            <strong>订单已退款</strong>
            <p className="buy-status">该订单的授权已撤销。如有疑问请联系 xhdp123@126.com。</p>
          </div>
        )}
        {!loadError && order && order.state === "paid" && (
          <div className="buy-license">
            <CheckCircle size={34} weight="fill" aria-hidden />
            <strong>支付成功</strong>
            <code className="buy-license__key">{order.licenseKey || "激活码生成中…请稍后刷新"}</code>
            {order.customerEmailMasked && (
              <p className="buy-license__sent">
                {order.emailSent
                  ? <>激活码已发送至 {order.customerEmailMasked}，请查收（别忘检查垃圾箱）。</>
                  : <>激活码暂未发出。请先复制本页激活码；也可以稍后到 <a href={siteHref("/recover/")}>找回激活码</a> 页用购买邮箱重发。</>}
              </p>
            )}
            <button type="button" className="site-button site-button--primary" onClick={() => void copyLicenseKey()}>
              {copied ? <><Check size={16} weight="bold" /> 已复制</> : <><Copy size={16} weight="bold" /> 复制激活码</>}
            </button>
            <ol className="buy-steps">
              <li>打开 MinuteFlow 桌面应用，进入「设置 → 激活」。</li>
              <li>粘贴激活码并确认，授权立即生效。</li>
              <li>激活码请在本地妥善保存，也可随时回到本页查询订单。</li>
            </ol>
          </div>
        )}
        {error && <p className="buy-error" role="alert">{error}</p>}
        <p className="buy-legal">
          付款由绍兴市臻书科技有限公司（zensoft.top）直接收款 ·{" "}
          <a href={siteHref("/refund/")}>7 天退款</a> ·{" "}
          <a href={siteHref("/recover/")}>找回激活码</a> ·{" "}
          <a href={siteHref("/terms/")}>服务条款</a>
        </p>
      </div>
    </main>
  );
}

/** 找回页：输入购买邮箱 → 服务端把 active 激活码发回该邮箱（防枚举：无论是否命中都是同一句成功文案）。 */
function RecoverPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function sendRecovery() {
    const trimmed = email.trim();
    if (!trimmed) {
      setError("请输入购买时填写的邮箱地址。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${licenseApiRoot()}/api/license/recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? "发送失败，请稍后重试。");
        return;
      }
      setDone(true);
    } catch {
      setError("暂时无法连接服务，请检查网络后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" className="buy-page" tabIndex={-1}>
      <header className="buy-hero">
        <span className="section-kicker">激活码找回</span>
        <h1>激活码丢了？邮件找回。</h1>
        <p>输入购买时填写的邮箱，我们会把名下所有有效激活码发送到该邮箱。忘记邮箱或未填写，请联系 xhdp123@126.com。</p>
      </header>
      <div className="buy-card">
        {done ? (
          <div className="buy-license">
            <CheckCircle size={34} weight="fill" aria-hidden />
            <strong>请求已提交</strong>
            <p className="buy-status">如果该邮箱有购买记录，激活码邮件已发出，请查收（别忘检查垃圾箱）。</p>
            <button type="button" className="site-button site-button--ghost" onClick={() => setDone(false)}>
              换一个邮箱再试
            </button>
          </div>
        ) : (
          <div className="buy-email buy-email--block">
            <label htmlFor="recover-email">购买邮箱</label>
            <input
              id="recover-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              maxLength={254}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void sendRecovery();
              }}
            />
            <button type="button" className="site-button site-button--primary" disabled={busy} onClick={() => void sendRecovery()}>
              {busy ? "发送中…" : "发送激活码邮件"}
            </button>
          </div>
        )}
        {error && <p className="buy-error" role="alert">{error}</p>}
        <p className="buy-legal">
          每个邮箱每小时最多请求 3 次 ·{" "}
          <a href={siteHref("/buy/")}>返回购买页</a>
        </p>
      </div>
    </main>
  );
}

/** 政策四页（定价/条款/隐私/退款）的头部元信息。 */
const policyMeta: Record<PolicyRoute, { eyebrow: string; title: string; summary: string }> = {
  pricing: { eyebrow: "清晰定价", title: "一次购买，长期使用。", summary: "没有隐藏套餐，也没有自动续费。以人民币一次性购买 MinuteFlow 桌面版授权。" },
  terms: { eyebrow: "服务条款", title: "使用 MinuteFlow 前，请了解这些约定。", summary: "本条款说明软件许可、可接受的使用方式、交易关系和双方责任。" },
  privacy: { eyebrow: "隐私政策", title: "你的会议内容，默认留在你的设备上。", summary: "本政策说明 MinuteFlow 处理哪些信息、为什么处理，以及你可以如何联系我们行使权利。" },
  refund: { eyebrow: "退款政策", title: "购买后 7 天内，可申请退款。", summary: "如果 MinuteFlow 不适合你，可在符合以下条件时通过邮件申请，款项按原支付渠道退回。" }
};

/** 政策页骨架：头部元信息 + 左侧政策导航 + 对应内容组件。 */
function PolicyPage({ route }: { route: PolicyRoute }) {
  const meta = policyMeta[route];
  return (
    <main id="main-content" className="policy-page" tabIndex={-1}>
      <header className="policy-hero">
        <span className="section-kicker">{meta.eyebrow}</span>
        <h1>{meta.title}</h1>
        <p>{meta.summary}</p>
        {route !== "pricing" && <small>生效日期：2026 年 8 月 3 日</small>}
      </header>
      <div className="policy-layout">
        <aside className="policy-index" aria-label="政策页面">
          <a href={siteHref("/pricing/")} aria-current={route === "pricing" ? "page" : undefined}>定价</a>
          <a href={siteHref("/terms/")} aria-current={route === "terms" ? "page" : undefined}>服务条款</a>
          <a href={siteHref("/privacy/")} aria-current={route === "privacy" ? "page" : undefined}>隐私政策</a>
          <a href={siteHref("/refund/")} aria-current={route === "refund" ? "page" : undefined}>退款政策</a>
        </aside>
        {route === "pricing" ? <PricingContent /> : route === "terms" ? <TermsContent /> : route === "privacy" ? <PrivacyContent /> : <RefundContent />}
      </div>
    </main>
  );
}

/** 定价页内容：¥99 一次性购买价格卡 + 付款/授权/购买前说明。 */
function PricingContent() {
  return <article className="policy-document pricing-document">
    <section className="price-card">
      <div><span>MinuteFlow 桌面版</span><h2><b>¥99</b> 人民币</h2><p>一次性购买 · 非订阅 · 不自动续费</p></div>
      <ul><li><Check size={18} weight="bold" /> 完整桌面会议工作台</li><li><Check size={18} weight="bold" /> 本地录音、笔记与会议库</li><li><Check size={18} weight="bold" /> 自带模型或配置第三方 AI 服务</li><li><Check size={18} weight="bold" /> 7 天退款申请期</li></ul>
      <a className="site-button site-button--primary" href={siteHref("/buy/")}>立即购买 <ArrowUpRight size={16} /></a>
      <a className="price-card__secondary" href={desktopDownloadHref()} target="_blank" rel="noreferrer">先下载试用（免费版可录音与记笔记）</a>
    </section>
    <section><h2>付款与交付</h2><p>价格为人民币 99 元，支持微信支付与支付宝扫码付款，由绍兴市臻书科技有限公司（zensoft.top）直接收款。付款成功后，购买页会立即显示激活码；在应用中输入激活码即完成授权，无需注册账户。</p></section>
    <section><h2>授权范围</h2><p>购买后获得 MinuteFlow 桌面版的个人使用授权，可在最多 2 台你个人拥有的设备上激活使用。授权不包含第三方模型、云端转写或 API 的使用费用；如果你自行配置此类服务，相关费用由对应服务商收取。</p></section>
    <section><h2>购买前说明</h2><p>请先确认设备满足系统要求。当前支持 macOS 14.2+ 与 Windows 10 22H2+。购买即表示你同意我们的服务条款、隐私政策与退款政策。</p></section>
  </article>;
}

/** 服务条款内容：销售主体、购买支付、许可、责任等八节。 */
function TermsContent() {
  return <article className="policy-document">
    <section><h2>1. 适用范围与销售主体</h2><p>本条款适用于 MinuteFlow 软件及官网。MinuteFlow 由位于中国的个人开发者运营。联系邮箱：<a href="mailto:xhdp123@126.com">xhdp123@126.com</a>；联系电话：<a href="tel:+8618705850056">+86 187 0585 0056</a>。</p></section>
    <section><h2>2. 购买与支付</h2><p>订单通过官网购买页完成，支持微信支付与支付宝扫码付款，由绍兴市臻书科技有限公司直接收款。付款成功后发放激活码，激活码可在最多 2 台你个人拥有的设备上使用。支付通道本身的服务条款以微信支付及支付宝的相应协议为准。</p></section>
    <section><h2>3. 软件许可</h2><p>完成付款后，你获得一项个人、非独占、不可转让的 MinuteFlow 使用许可。你可以在本人拥有或控制的兼容设备上安装使用，但不得转售、出租、破解授权机制，或在法律禁止的范围外反向工程软件。</p></section>
    <section><h2>4. 用户责任</h2><p>你应确保录音和处理会议内容具有必要的知情同意与合法依据，并妥善保护设备、会议数据及第三方 API 凭据。不得使用 MinuteFlow 侵犯他人隐私、知识产权或从事违法活动。</p></section>
    <section><h2>5. 第三方服务</h2><p>你可以自行配置转写或 AI 服务商。此类服务由第三方独立提供，其可用性、费用和数据处理规则由对应服务商负责。MinuteFlow 不会代你向第三方提交内容，除非你主动完成配置并发起相关功能。</p></section>
    <section><h2>6. 更新、可用性与免责声明</h2><p>我们可能提供错误修复、安全更新和功能改进。软件按“现状”和“可用”基础提供；在法律允许的最大范围内，不保证转写或 AI 输出完全准确。重要决策前请人工核对会议内容。</p></section>
    <section><h2>7. 责任限制</h2><p>在适用法律允许的范围内，我们对间接、附带或后果性损失不承担责任。因本产品产生的累计责任不超过你为 MinuteFlow 支付的金额；法律不得排除或限制的责任不受此限制。</p></section>
    <section><h2>8. 终止与法律</h2><p>严重违反本条款可能导致许可终止。条款适用中华人民共和国法律，但不影响你所在地法律赋予且不可放弃的消费者权利。争议应先通过上述联系方式友好协商。</p></section>
  </article>;
}

/** 隐私政策内容：本地数据、第三方服务、付款信息等八节。 */
function PrivacyContent() {
  return <article className="policy-document">
    <section><h2>1. 谁负责处理信息</h2><p>MinuteFlow 由位于中国的个人开发者运营。隐私问题或权利请求请发送至 <a href="mailto:xhdp123@126.com">xhdp123@126.com</a>，或致电 <a href="tel:+8618705850056">+86 187 0585 0056</a>。</p></section>
    <section><h2>2. 本地会议数据</h2><p>会议录音、逐字稿、笔记、纪要、行动项与应用设置默认存储在你的设备上。我们不会运营一个用于收集这些内容的 MinuteFlow 云端账户或同步服务。卸载软件前请自行导出需要保留的数据。</p></section>
    <section><h2>3. 你主动配置的第三方服务</h2><p>当你配置并使用第三方转写或 AI 服务时，完成请求所需的音频、文本或提示词会直接发送给你选择的提供商。处理行为受该提供商的隐私政策约束。API 凭据保存在设备的安全存储中。</p></section>
    <section><h2>4. 购买与付款信息</h2><p>支付由微信支付与支付宝通道处理，我们不会接触或存储你的银行卡、支付账户等敏感资料。为履行许可、提供支持与处理退款，我们会保留订单编号、支付渠道、金额、时间与对应激活码的必要记录。相关处理同时受微信支付与支付宝的隐私政策约束。</p></section>
    <section><h2>5. 官网与支持</h2><p>本静态官网不要求登录，也不设置产品分析或广告跟踪 Cookie。托管服务可能为安全与运行目的处理常规访问日志。当你通过邮件或电话联系我们时，我们会处理你提供的联系方式、问题内容和必要的订单信息，以回应请求、排查故障或履行法律义务。</p></section>
    <section><h2>6. 保存、安全与披露</h2><p>本地内容的保存期限由你决定。支持记录仅在处理请求、履行交易和法律义务所需期间保存。除受托服务商、法律要求或保护合法权利所必需的情形外，我们不会出售或披露你的个人信息。</p></section>
    <section><h2>7. 你的权利</h2><p>根据适用法律，你可以请求访问、更正或删除我们持有的个人信息，或对特定处理提出异议。请通过上述邮箱联系；我们可能需要核验身份。设备上的本地数据可由你直接在应用内管理或删除。</p></section>
    <section><h2>8. 政策更新</h2><p>如处理方式或法律要求发生变化，我们会更新本页并标注新的生效日期。重大变化会以合理方式提示。</p></section>
  </article>;
}

/** 退款政策内容：7 天保证、申请方式、条件与例外。 */
function RefundContent() {
  return <article className="policy-document">
    <section className="refund-highlight"><h2>7 天退款保证</h2><p>自首次购买完成之日起 7 个自然日内，你可以申请退回 MinuteFlow 的一次性购买款项。</p></section>
    <section><h2>如何申请</h2><p>发送邮件至 <a href="mailto:xhdp123@126.com">xhdp123@126.com</a>，附上激活码或购买页显示的订单信息。我们核实后会通过微信支付或支付宝按原路退回款项。</p></section>
    <section><h2>适用条件</h2><p>申请需在 7 天期限内提交。退款按原支付渠道退回，实际到账时间由微信支付、支付宝及银行决定。退款完成后，对应激活码将被撤销，软件许可随之终止。</p></section>
    <section><h2>例外情况</h2><p>法律允许时，对于欺诈、滥用退款机制、已发起拒付或无法验证的订单，我们可能拒绝退款。由第三方 API、模型或其他服务商收取的费用不属于 MinuteFlow 购买款，无法通过本政策退还。</p></section>
    <section><h2>法定消费者权利</h2><p>本政策不限制适用法律赋予你的强制性消费者权利。如当地法律规定更长的撤销期、退款权或其他救济，以该法律为准。</p></section>
  </article>;
}

/** 全站页脚：品牌、全量链接与版权行。 */
function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__brand">
        <BrandMark className="site-brand__mark" size={29} />
        <div><strong>MinuteFlow</strong><span>让每一次讨论，都有清晰的下一步。</span></div>
      </div>
      <div className="site-footer__links">
        <a href={siteHref("/")}>产品</a>
        <a href={siteHref("/#/specs")}>规格</a>
        <a href={siteHref("/pricing/")}>定价</a>
        <a href={siteHref("/terms/")}>服务条款</a>
        <a href={siteHref("/privacy/")}>隐私政策</a>
        <a href={siteHref("/refund/")}>退款政策</a>
        <a href={desktopDownloadHref()} target="_blank" rel="noreferrer">下载桌面版</a>
        <a href="https://github.com/vibeforge2014/minuteflow" target="_blank" rel="noreferrer">
          <GithubLogo size={16} /> GitHub
        </a>
      </div>
      <p>
        © 2026 绍兴市臻书科技有限公司 · 版权所有 ·{" "}
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
          浙ICP备2026072549号
        </a>
      </p>
    </footer>
  );
}

/** 从 pathname + hash 解析当前路由：政策/购买页看路径尾部，specs 看 hash，其余为首页。 */
function getRoute(): SiteRoute {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/pricing")) return "pricing";
  if (path.endsWith("/buy")) return "buy";
  if (path.endsWith("/recover")) return "recover";
  if (path.endsWith("/terms")) return "terms";
  if (path.endsWith("/privacy")) return "privacy";
  if (path.endsWith("/refund")) return "refund";
  return window.location.hash.startsWith("#/specs") ? "specs" : "home";
}

function siteHref(path: string) {
  // GitHub Pages project sites are served under /<repo>/, and zensoft.top
  // serves this site under /minuteflow/; root-served hosts (custom domains)
  // need no prefix. Derive the leading path segment so the same build renders
  // correctly on any sub-path host.
  const base =
    window.location.hostname.endsWith(".github.io") ||
    window.location.hostname === "zensoft.top"
      ? `/${window.location.pathname.split("/").filter(Boolean)[0] ?? ""}`.replace(/\/+$/, "")
      : "";
  return `${base}${path}`;
}

/** 首页锚点滚动：改写地址栏 hash 并平滑滚到目标区块（尊重 prefers-reduced-motion）。 */
function scrollToSection(event: ReactMouseEvent<HTMLAnchorElement>, id: string) {
  event.preventDefault();
  window.history.replaceState(null, "", `#${id}`);
  document.getElementById(id)?.scrollIntoView({
    block: "start",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  });
}
