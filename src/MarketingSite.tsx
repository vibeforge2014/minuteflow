/**
 * 产品官网（Apple 风格克制视觉，暖橙 #E76F51 点缀）：纯浏览器环境渲染的静态站点。
 * 路由：#hash + pathname 混合——首页（#/)、规格页（#/specs/<section>）、
 * 定价/条款/隐私/退款为独立路径页（/pricing/ 等，由托管层直接服务 HTML）。
 * 使用原生文档滚动（与 Electron 固定视口工作台隔离），不提供浏览器版会议演示。
 * 关键区块：Hero、特性信号条、工作区解剖（三栏）、三阶段演示、隐私图解、
 * 平台对比、结尾 CTA、规格页（七节）、政策页四件套、页脚。
 */
import { useEffect, useLayoutEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
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
  Desktop,
  DeviceMobile,
  Export,
  FileText,
  GithubLogo,
  HardDrive,
  List,
  LockKey,
  Microphone,
  ShieldCheck,
  Sparkle,
  Stack,
  Translate,
  UsersThree,
  Waveform,
  WindowsLogo,
  X
} from "@phosphor-icons/react";
import productWorkspace from "../implementation-1440x1024-final.png";
import { BrandMark } from "./components/BrandMark";

/** 站点路由：首页 / 规格 / 定价 / 条款 / 隐私 / 退款。 */
type SiteRoute = "home" | "specs" | "pricing" | "terms" | "privacy" | "refund";
/** 演示区块的三个阶段：会中记录 / 会中整理 / 会后行动。 */
type DemoMode = "record" | "organize" | "act";

/** 桌面版下载地址（GitHub Releases 最新版）。 */
const desktopReleaseUrl = "https://github.com/vibeforge2014/minuteflow/releases/latest";

/** 三阶段演示的文案数据（LandingPage 的记录/整理/行动切换器使用）。 */
const featureDemo: Record<DemoMode, {
  eyebrow: string;
  title: string;
  description: string;
  points: string[];
}> = {
  record: {
    eyebrow: "会中",
    title: "说话的时候，纪要已经开始成形。",
    description: "麦克风与桌面系统音频分轨采集，中文与中英混合语音实时转写。你的手动笔记始终留在文档正中，不必被 AI 打断。",
    points: ["15 秒音频块安全落盘", "发言人标签与重点时间戳", "暂停、继续与迷你录音栏"]
  },
  organize: {
    eyebrow: "理解",
    title: "从逐字稿里提取真正重要的事。",
    description: "默认每两分钟滚动更新结构化纪要，持续整理关键结论、风险、开放问题与下一步，同时保留证据上下文。",
    points: ["增量纪要与最终总结", "手动内容锁定，避免被覆盖", "会议术语表与上下文续写"]
  },
  act: {
    eyebrow: "会后",
    title: "会议结束，行动已经可以开始。",
    description: "把讨论自动收束为有负责人、截止日期和状态的行动项。需要分享时，按团队习惯导出为文档、字幕或完整备份。",
    points: ["负责人、截止日期与状态", "Markdown / PDF / DOCX", "SRT / VTT / JSON / ZIP"]
  }
};

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

  // hash 路由变化（前进/后退/深链）时切换页面并回到顶部；同时收起移动端菜单。
  useEffect(() => {
    let currentRoute = getRoute();
    const handleRoute = () => {
      const nextRoute = getRoute();
      if (nextRoute !== currentRoute) {
        currentRoute = nextRoute;
        setRoute(nextRoute);
        window.scrollTo({ top: 0, behavior: "auto" });
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
      {route === "specs" ? <SpecsPage /> : route === "home" ? <LandingPage /> : <PolicyPage route={route} />}
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
  return (
    <header className={`site-header ${isScrolled ? "is-scrolled" : ""}`}>
      <div className="site-nav">
        <a className="site-brand" href={siteHref("/")} aria-label="MinuteFlow首页">
          <BrandMark className="site-brand__mark" size={29} />
          <span>MinuteFlow</span>
        </a>

        <nav className={`site-links ${menuOpen ? "is-open" : ""}`} aria-label="主导航">
          <a href={siteHref("/")} aria-current={route === "home" ? "page" : undefined}>产品</a>
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
            <a href={siteHref("/#/specs")}>概览</a>
          )}
          <a href={siteHref("/#/specs")} aria-current={route === "specs" ? "page" : undefined}>规格</a>
          <a href={siteHref("/pricing/")} aria-current={route === "pricing" ? "page" : undefined}>定价</a>
          <a href={desktopReleaseUrl} target="_blank" rel="noreferrer">
            下载 <ArrowUpRight size={13} />
          </a>
          <a
            href="https://github.com/vibeforge2014/minuteflow"
            target="_blank"
            rel="noreferrer"
          >
            GitHub <ArrowUpRight size={13} />
          </a>
        </nav>

        <div className="site-nav__actions">
          <button
            className="site-menu-button"
            type="button"
            aria-label={menuOpen ? "关闭菜单" : "打开菜单"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X size={20} /> : <List size={21} />}
          </button>
        </div>
      </div>
    </header>
  );
}

/** 首页：Hero（含产品截图舞台与浮动徽标）→ 特性信号条 → 工作区解剖 → 三阶段演示 → 隐私 → 平台 → 结尾 CTA。 */
function LandingPage() {
  // 演示区块当前阶段（记录/整理/行动），驱动文案与右侧示意图切换。
  const [demoMode, setDemoMode] = useState<DemoMode>("record");
  const demo = featureDemo[demoMode];

  return (
    <main id="main-content" tabIndex={-1}>
      {/* —— Hero：主张、下载按钮、平台徽标、产品截图与两枚浮动特性卡 —— */}
      <section className="hero">
        <div className="hero__ambient hero__ambient--one" />
        <div className="hero__ambient hero__ambient--two" />
        <div className="hero__content">
          <div className="eyebrow-chip">
            <span className="status-dot" />
            本地优先 · 为中文会议而生
          </div>
          <h1>会议在流动，<br />好想法不再溜走。</h1>
          <p className="hero__lede">
            一边录音，一边转写，一边把零散讨论整理成清晰的会议文档。
            从开会到行动，不必再切换工具。
          </p>
          <div className="hero__actions">
            <a className="site-button site-button--primary" href={desktopReleaseUrl} target="_blank" rel="noreferrer">
              <Desktop size={17} weight="bold" /> 下载桌面版
            </a>
          </div>
          <div className="hero__meta" aria-label="平台与隐私特性">
            <span><AppleLogo size={17} weight="fill" /> macOS 14.2+</span>
            <span><WindowsLogo size={17} weight="fill" /> Windows 10 22H2+</span>
            <span><LockKey size={17} weight="fill" /> 数据默认留在本机</span>
          </div>
        </div>

        <div className="product-stage" aria-label="MinuteFlow产品界面预览">
          <div className="product-stage__glow" />
          <div className="product-window">
            <div className="product-window__bar">
              <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
              <span>产品团队周会 · 正在记录</span>
              <span className="window-live"><i /> LIVE</span>
            </div>
            <img src={productWorkspace} alt="MinuteFlow桌面端三栏会议工作区" />
          </div>
          <div className="floating-note floating-note--summary">
            <span className="floating-note__icon"><Sparkle size={16} weight="fill" /></span>
            <span><strong>实时纪要已更新</strong><small>新增 3 条关键结论</small></span>
          </div>
          <div className="floating-note floating-note--private">
            <span className="floating-note__icon floating-note__icon--green"><ShieldCheck size={17} weight="fill" /></span>
            <span><strong>本地保存</strong><small>内容未上传</small></span>
          </div>
        </div>
      </section>

      {/* —— 特性信号条：实时转写 / 滚动纪要 / 本地优先 / 开放导出 —— */}
      <section className="signal-strip" aria-label="核心特性">
        <div><Waveform size={21} /><span><strong>实时转写</strong> 中文与中英混合</span></div>
        <div><Sparkle size={21} /><span><strong>滚动纪要</strong> 两分钟持续更新</span></div>
        <div><CloudSlash size={21} /><span><strong>本地优先</strong> 由你决定是否联网</span></div>
        <div><Export size={21} /><span><strong>开放导出</strong> 文档、字幕与备份</span></div>
      </section>

      {/* —— 工作区解剖：会议库 / 会议文档 / 实时侧栏 三张结构卡 —— */}
      <section className="site-section intro-section" id="features">
        <div className="section-heading section-heading--center">
          <span className="section-kicker">一个持续生长的会议文档</span>
          <h2>让记录跟上讨论，<br />让讨论自然变成行动。</h2>
          <p>会议库、可编辑文档、实时转录与 AI 纪要同时在场，各自清楚，彼此相连。</p>
        </div>

        <div className="workspace-anatomy">
          <div className="anatomy-card">
            <span className="anatomy-card__number">01</span>
            <div className="anatomy-card__visual anatomy-card__visual--library">
              <i /><i /><i className="is-selected" /><i />
            </div>
            <h3>会议库</h3>
            <p>搜索、收藏、标签与软删除，让每一次讨论都有清楚的归处。</p>
          </div>
          <div className="anatomy-card anatomy-card--featured">
            <span className="anatomy-card__number">02</span>
            <div className="anatomy-card__visual anatomy-card__visual--document">
              <b />
              <i /><i /><i />
              <span /><span />
            </div>
            <h3>会议文档</h3>
            <p>目标、手动笔记、滚动纪要与行动项，保持在同一条思考主线上。</p>
          </div>
          <div className="anatomy-card">
            <span className="anatomy-card__number">03</span>
            <div className="anatomy-card__visual anatomy-card__visual--transcript">
              <span><b>我</b><i /></span>
              <span><b>刘婷</b><i /></span>
              <span><b>周哲</b><i /></span>
            </div>
            <h3>实时侧栏</h3>
            <p>逐字稿和 AI 结论并排出现，回看上下文时不必离开当前文档。</p>
          </div>
        </div>
      </section>

      {/* —— 三阶段演示：记录/整理/行动 分段切换器 + 左文右图 —— */}
      <section className="site-section demo-section">
        <div className="demo-shell">
          <div className="demo-copy">
            <span className="section-kicker">从声音到结果</span>
            <div className="segmented-control" role="tablist" aria-label="产品阶段">
              {(["record", "organize", "act"] as DemoMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={demoMode === mode}
                  className={demoMode === mode ? "is-active" : ""}
                  onClick={() => setDemoMode(mode)}
                >
                  {mode === "record" ? "记录" : mode === "organize" ? "整理" : "行动"}
                </button>
              ))}
            </div>
            <div className="demo-copy__body" key={demoMode}>
              <span className="demo-eyebrow">{demo.eyebrow}</span>
              <h2>{demo.title}</h2>
              <p>{demo.description}</p>
              <ul>
                {demo.points.map((point) => (
                  <li key={point}><CheckCircle size={18} weight="fill" /> {point}</li>
                ))}
              </ul>
            </div>
          </div>
          <DemoVisual mode={demoMode} />
        </div>
      </section>

      {/* —— 隐私区块：本地优先数据流图（本机资料库 → 仅有配置后才发送） —— */}
      <section className="site-section privacy-section" id="privacy">
        <div className="privacy-card">
          <div className="privacy-card__copy">
            <span className="section-kicker section-kicker--light">隐私不是设置项，是默认值</span>
            <h2>你的会议，<br />首先属于你的设备。</h2>
            <p>
              会议内容、逐字稿、笔记、索引与录音默认存储在本机。
              未配置远程模型时，应用不会把会议内容发送到外部服务。
            </p>
            <a href="#/specs" className="text-link text-link--light">
              阅读数据与隐私规格 <ArrowRight size={16} />
            </a>
          </div>
          <div className="privacy-diagram" aria-label="本地优先数据流">
            <div className="privacy-device">
              <HardDrive size={31} weight="duotone" />
              <strong>本机资料库</strong>
              <span>录音 · 转录 · 笔记 · 索引</span>
            </div>
            <div className="privacy-flow">
              <span>仅在你配置后</span>
              <i><ArrowRight size={18} /></i>
            </div>
            <div className="privacy-provider">
              <BracketsCurly size={29} weight="duotone" />
              <strong>你选择的模型</strong>
              <span>按任务发送必要内容</span>
            </div>
          </div>
        </div>
      </section>

      {/* —— 平台对比：桌面三栏工作区 vs iPhone/iPad 原生 SwiftUI —— */}
      <section className="site-section platform-section">
        <div className="section-heading">
          <span className="section-kicker">桌面深度工作，移动随身捕捉</span>
          <h2>熟悉的工作方式，<br />适配每一块屏幕。</h2>
        </div>
        <div className="platform-grid">
          <article className="platform-card platform-card--desktop">
            <div className="platform-card__top">
              <span className="platform-icon"><Desktop size={24} weight="duotone" /></span>
              <span>Windows · macOS</span>
            </div>
            <h3>完整三栏工作区</h3>
            <p>系统音频与麦克风双轨采集，适合线上会议和长时间桌面工作。</p>
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
            <p>iPhone 快速记录，iPad 自适应三栏工作区；使用 Apple Speech 完成本地转写路径。</p>
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
        <p>下载桌面版即可开始记录，会议内容默认只保存在你的设备。</p>
        <div className="hero__actions">
          <a className="site-button site-button--primary" href={desktopReleaseUrl} target="_blank" rel="noreferrer">
            <Desktop size={17} weight="bold" /> 下载桌面版
          </a>
        </div>
      </section>
    </main>
  );
}

/** 演示区右侧的静态示意图：按阶段渲染 文档+波形 / 时间线纪要 / 行动项表格 + 底部录音条。 */
function DemoVisual({ mode }: { mode: DemoMode }) {
  return (
    <div className={`demo-visual demo-visual--${mode}`} aria-hidden="true">
      <div className="demo-visual__top">
        <div><i /><i /><i /></div>
        <span>产品团队周会</span>
        <b>已自动保存</b>
      </div>
      <div className="demo-visual__content">
        <div className="demo-document">
          <small>2026 年 7 月 30 日 · 10:00</small>
          <h4>{mode === "act" ? "行动项" : mode === "organize" ? "实时纪要" : "产品团队周会"}</h4>
          {mode === "record" && (
            <>
              <p><span>会议目标</span></p>
              <ul><li>对齐本周重点进展与风险</li><li>决定登录流程改版的下一步</li></ul>
              <div className="recording-wave">
                {[12, 21, 15, 27, 19, 31, 14, 24, 18, 28, 16, 22].map((height, index) => (
                  <i key={index} style={{ height }} />
                ))}
              </div>
            </>
          )}
          {mode === "organize" && (
            <div className="summary-lines">
              <p><time>10:02</time><span>A 方案已完成可用性测试，整体反馈更好。</span></p>
              <p><time>10:06</time><span>登录失败原因需要再细分几个类型。</span><b>新增</b></p>
              <p><time>10:10</time><span>先灰度 5% 流量，验证转化和留存。</span><b>新增</b></p>
              <p><time>10:14</time><span>下周邀请客服共同完成需求评审。</span></p>
            </div>
          )}
          {mode === "act" && (
            <div className="action-rows">
              <p><i><Check size={12} /></i><span>输出登录流程 AB 测试方案</span><b>刘婷</b></p>
              <p><i /><span>补充失败原因埋点设计</span><b>周哲</b></p>
              <p><i /><span>完成第三方登录合规评估</span><b>王敏</b></p>
              <p><i /><span>整理高频问题处理方案</span><b>我</b></p>
            </div>
          )}
        </div>
        <div className="demo-transcript">
          <span>实时转写</span>
          <p><b>我</b> 我们先快速对齐议程。</p>
          <p><b>刘婷</b> A 方案的可用性测试已经完成。</p>
          <p><b>周哲</b> 有个补充，失败原因需要细分。</p>
        </div>
      </div>
      <div className="demo-recorder">
        <i />
        <strong>{mode === "record" ? "00:24:37" : "00:46:12"}</strong>
        <span><Microphone size={15} /> 麦克风</span>
        <span><Waveform size={15} /> 系统音频</span>
        <b>{mode === "record" ? "暂停" : "已记录"}</b>
      </div>
    </div>
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
        <span className="eyebrow-chip"><FileText size={15} weight="fill" /> 产品规格 · v0.1</span>
        <h1>功能边界，<br />清清楚楚。</h1>
        <p>从支持的平台、采集方式到数据存储和模型连接，一页了解MinuteFlow当前版本的完整能力。</p>
        <div className="spec-hero__meta">
          <span><CheckCircle size={17} weight="fill" /> 已实现</span>
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
            intro="MinuteFlow是本地优先的跨平台会议工作台。它把会前目标、会中笔记、实时转录、滚动纪要和会后行动项放在一个连贯空间里。"
          >
            <div className="spec-summary-grid">
              <SpecMetric icon={<Desktop />} label="桌面端" value="Windows + macOS" />
              <SpecMetric icon={<DeviceMobile />} label="移动端" value="iPhone + iPad" />
              <SpecMetric icon={<ClockCountdown />} label="纪要节奏" value="默认每 2 分钟" />
              <SpecMetric icon={<LockKey />} label="数据策略" value="默认只存本地" />
            </div>
            <SpecTable rows={[
              ["产品形态", "Electron 桌面应用；原生 SwiftUI iOS / iPadOS 应用"],
              ["首发语言", "简体中文；重点支持中文与中英混合会议"],
              ["核心工作流", "创建 / 导入 → 录音 → 转录 → 增量纪要 → 最终总结 → 导出"],
              ["账号要求", "核心本地功能不依赖云端账号"],
              ["模型策略", "本地模型与用户自带远程模型配置并存"]
            ]} />
          </SpecSection>

          <SpecSection
            id="desktop"
            index="02"
            kicker="桌面端"
            title="为长时间会议设计的完整工作区"
            intro="桌面端保留三栏信息架构：左侧会议库、中间可编辑文档、右侧实时转录与 AI 纪要，底部录音控制始终触手可及。"
          >
            <FeatureRows rows={[
              { icon: <Microphone />, title: "双轨录音", body: "分别采集麦克风与桌面系统音频；15 秒音频块持续落盘，支持暂停、继续与停止。", badge: "Windows / macOS" },
              { icon: <FileText />, title: "可编辑会议文档", body: "会议目标、个人笔记、实时纪要和行动项集中编辑，保留人工内容优先权。", badge: "自动保存" },
              { icon: <Waveform />, title: "实时逐字稿", body: "实时与最终转写状态分离，支持发言人改名、合并及“我 / 远端”声道初分。", badge: "说话人标签" },
              { icon: <Sparkle />, title: "结构化纪要", body: "提取议题、关键点、决策、风险、开放问题、下一步和行动项。", badge: "增量 + 最终" },
              { icon: <Stack />, title: "资料库管理", body: "全文搜索、标签、收藏、软删除与恢复；支持会议模板和术语表。", badge: "SQLite / FTS5" }
            ]} />
          </SpecSection>

          <SpecSection
            id="ios"
            index="03"
            kicker="iPhone 与 iPad"
            title="原生、随身，并尊重系统边界"
            intro="iOS 版使用 SwiftUI 与 SwiftData，围绕快速记录和移动查看重新组织交互，而不是缩小桌面界面。"
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
              ["界面", "iPhone 自适应导航栈；iPad 三栏工作区"],
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
            title="模型由你选择，体验保持一致"
            intro="应用提供本地与远程适配层。只有在用户主动配置远程服务后，相关任务才会连接外部模型。"
          >
            <div className="provider-grid">
              <div>
                <span className="provider-grid__icon"><HardDrive size={22} /></span>
                <h3>本地转写</h3>
                <p>whisper.cpp、sherpa-onnx</p>
              </div>
              <div>
                <span className="provider-grid__icon"><BracketsCurly size={22} /></span>
                <h3>远程转写</h3>
                <p>OpenAI 兼容音频接口</p>
              </div>
              <div>
                <span className="provider-grid__icon"><Sparkle size={22} /></span>
                <h3>远程总结</h3>
                <p>OpenAI、Azure OpenAI、DeepSeek、通义千问等兼容接口</p>
              </div>
              <div>
                <span className="provider-grid__icon"><CloudSlash size={22} /></span>
                <h3>离线基础纪要</h3>
                <p>未配置服务时仍保留本地工作流</p>
              </div>
            </div>
            <SpecTable rows={[
              ["转录上下文", "语言、术语表、前文上下文"],
              ["总结输入", "会议目标、手动笔记、逐字稿、上一版纪要"],
              ["更新策略", "默认每 120 秒增量更新；停止录音后生成最终版本"],
              ["冲突保护", "手动锁定内容与文档版本保护"],
              ["连接测试", "保存模型前可验证服务地址、模型名与凭据"]
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
              { icon: <HardDrive />, title: "本地资料库", body: "会议、逐字稿、笔记、索引与录音默认保存在应用数据目录。", badge: "默认" },
              { icon: <LockKey />, title: "安全凭据", body: "桌面端使用系统安全存储，iOS 使用 Keychain 保存第三方 API 凭据。", badge: "密钥不入文档" },
              { icon: <CloudSlash />, title: "无静默上传", body: "未配置远程模型时不上传会议内容；配置后仅向所选服务发送对应任务所需输入。", badge: "用户控制" },
              { icon: <ShieldCheck />, title: "可管理保留周期", body: "可设置录音保留周期；删除使用软删除机制，避免误操作造成即时丢失。", badge: "可恢复" }
            ]} />
          </SpecSection>

          <SpecSection
            id="formats"
            index="06"
            kicker="导入与导出"
            title="信息进得来，也带得走"
            intro="支持常见音视频来源，并提供面向阅读、字幕、数据迁移和完整备份的多种输出。"
          >
            <div className="format-columns">
              <div>
                <span>可导入</span>
                <div>{["MP3", "M4A", "WAV", "FLAC", "OGG", "WebM", "MP4", "MOV"].map((item) => <b key={item}>{item}</b>)}</div>
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
            intro="以下是原型与首发版本的目标环境。实际发布包仍需完成对应平台的签名与公证。"
          >
            <SpecTable rows={[
              ["macOS", "14.2 或更高版本"],
              ["Windows", "Windows 10 22H2 或更高版本"],
              ["iPhone / iPad", "iOS / iPadOS 18 或更高版本"],
              ["桌面运行时", "Electron"],
              ["本地模型", "模型可自主选择，音频工具随应用内置"],
              ["远程服务", "需要用户自行提供兼容服务地址与凭据"]
            ]} />
            <div className="spec-endcap">
              <div>
                <span>准备好亲自看看了吗？</span>
                <strong>打开一场示例会议，体验完整工作流。</strong>
              </div>
              <a className="site-button site-button--primary" href={desktopReleaseUrl} target="_blank" rel="noreferrer">
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

type PolicyRoute = Exclude<SiteRoute, "home" | "specs">;

/** 政策四页（定价/条款/隐私/退款）的头部元信息。 */
const policyMeta: Record<PolicyRoute, { eyebrow: string; title: string; summary: string }> = {
  pricing: { eyebrow: "清晰定价", title: "一次购买，长期使用。", summary: "没有隐藏套餐，也没有自动续费。以人民币一次性购买 MinuteFlow 桌面版授权。" },
  terms: { eyebrow: "服务条款", title: "使用 MinuteFlow 前，请了解这些约定。", summary: "本条款说明软件许可、可接受的使用方式、交易关系和双方责任。" },
  privacy: { eyebrow: "隐私政策", title: "你的会议内容，默认留在你的设备上。", summary: "本政策说明 MinuteFlow 处理哪些信息、为什么处理，以及你可以如何联系我们行使权利。" },
  refund: { eyebrow: "退款政策", title: "购买后 7 天内，可申请退款。", summary: "如果 MinuteFlow 不适合你，可在符合以下条件时通过 Paddle 申请退款。" }
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
      <a className="site-button site-button--primary" href={desktopReleaseUrl} target="_blank" rel="noreferrer">获取 MinuteFlow <ArrowUpRight size={16} /></a>
    </section>
    <section><h2>付款与交付</h2><p>价格为人民币 99 元。Paddle 是本产品订单的 Merchant of Record（记录商户），负责安全结账、税费计算、付款凭证、账单支持与退款处理。结账页会在付款前显示最终应付金额及适用税费。</p></section>
    <section><h2>授权范围</h2><p>购买后获得 MinuteFlow 桌面版的个人使用授权。授权不包含第三方模型、云端转写或 API 的使用费用；如果你自行配置此类服务，相关费用由对应服务商收取。</p></section>
    <section><h2>购买前说明</h2><p>请先确认设备满足系统要求。当前支持 macOS 14.2+ 与 Windows 10 22H2+。购买即表示你同意我们的服务条款、隐私政策与退款政策。</p></section>
  </article>;
}

/** 服务条款内容：销售主体、Paddle、许可、责任等八节。 */
function TermsContent() {
  return <article className="policy-document">
    <section><h2>1. 适用范围与销售主体</h2><p>本条款适用于 MinuteFlow 软件及官网。MinuteFlow 由位于中国的个人开发者运营。联系邮箱：<a href="mailto:xhdp123@126.com">xhdp123@126.com</a>；联系电话：<a href="tel:+8618705850056">+86 187 0585 0056</a>。</p></section>
    <section><h2>2. 购买与 Paddle</h2><p>我们的订单流程由在线转售商 Paddle.com 执行。Paddle 是所有订单的 Merchant of Record，负责付款、账单客服、税务处理及退款。购买交易还受 <a href="https://www.paddle.com/legal/buyer-terms" target="_blank" rel="noreferrer">Paddle 买家条款</a>约束。</p></section>
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
    <section><h2>4. 购买与付款信息</h2><p>Paddle 作为 Merchant of Record 处理结账、付款、税务、收据、反欺诈和退款。我们可能收到订单状态、产品、金额、国家/地区、交易标识及用于履行许可和提供支持的有限买家信息，但不会收到完整银行卡资料。详见 <a href="https://www.paddle.com/legal/privacy" target="_blank" rel="noreferrer">Paddle 隐私政策</a>。</p></section>
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
    <section><h2>如何申请</h2><p>打开 Paddle 发送的购买收据，使用其中的订单管理或退款入口；也可以访问 <a href="https://paddle.net" target="_blank" rel="noreferrer">paddle.net</a> 联系 Paddle 买家支持。为便于查询，请准备购买邮箱和交易编号。你也可以发送邮件至 <a href="mailto:xhdp123@126.com">xhdp123@126.com</a> 寻求协助。</p></section>
    <section><h2>适用条件</h2><p>申请需在 7 天期限内提交。退款通常退回原付款方式，实际到账时间由 Paddle、银行或支付机构决定。退款完成后，对应软件许可将终止。</p></section>
    <section><h2>例外情况</h2><p>法律允许时，对于欺诈、滥用退款机制、已发起拒付或无法验证的订单，我们可能拒绝退款。由第三方 API、模型或其他服务商收取的费用不属于 MinuteFlow 购买款，无法通过本政策退还。</p></section>
    <section><h2>法定消费者权利</h2><p>本政策不限制适用法律赋予你的强制性消费者权利。如当地法律规定更长的撤销期、退款权或其他救济，以该法律为准。Paddle 也可能依据其政策和适用法律处理退款。</p></section>
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
        <a href={desktopReleaseUrl} target="_blank" rel="noreferrer">下载桌面版</a>
        <a href="https://github.com/vibeforge2014/minuteflow" target="_blank" rel="noreferrer">
          <GithubLogo size={16} /> GitHub
        </a>
      </div>
      <p>© 2026 MinuteFlow · 本地优先的会议工作台</p>
    </footer>
  );
}

/** 从 pathname + hash 解析当前路由：政策页看路径尾部，specs 看 hash，其余为首页。 */
function getRoute(): SiteRoute {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/pricing")) return "pricing";
  if (path.endsWith("/terms")) return "terms";
  if (path.endsWith("/privacy")) return "privacy";
  if (path.endsWith("/refund")) return "refund";
  return window.location.hash.startsWith("#/specs") ? "specs" : "home";
}

function siteHref(path: string) {
  // GitHub Pages project sites are served under /<repo>/; root-served hosts
  // (chatgpt.site, custom domains) need no prefix. Derive the leading path
  // segment so the same build renders correctly on any github.io project page.
  const base = window.location.hostname.endsWith(".github.io")
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
