import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  AppleLogo,
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

type SiteRoute = "home" | "specs";
type DemoMode = "record" | "organize" | "act";

const desktopReleaseUrl = "https://github.com/vibeforge2014/meeting-assistant/releases/latest";

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

const specSections = [
  { id: "overview", label: "产品概览" },
  { id: "desktop", label: "桌面端" },
  { id: "ios", label: "iPhone 与 iPad" },
  { id: "intelligence", label: "转写与 AI" },
  { id: "data", label: "数据与隐私" },
  { id: "formats", label: "导入与导出" },
  { id: "requirements", label: "系统要求" }
];

export function MarketingSite() {
  const [route, setRoute] = useState<SiteRoute>(() => getRoute());
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.body.classList.add("marketing-mode");
    return () => document.body.classList.remove("marketing-mode");
  }, []);

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
      <SiteHeader route={route} menuOpen={menuOpen} setMenuOpen={setMenuOpen} />
      {route === "specs" ? <SpecsPage /> : <LandingPage />}
      <SiteFooter />
    </div>
  );
}

function SiteHeader({
  route,
  menuOpen,
  setMenuOpen
}: {
  route: SiteRoute;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}) {
  return (
    <header className="site-header">
      <div className="site-nav">
        <a className="site-brand" href="#/" aria-label="会议助手首页">
          <BrandMark className="site-brand__mark" size={29} />
          <span>会议助手</span>
        </a>

        <nav className={`site-links ${menuOpen ? "is-open" : ""}`} aria-label="主导航">
          <a href="#/" aria-current={route === "home" ? "page" : undefined}>产品</a>
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
            <a href="#/specs">概览</a>
          )}
          <a href="#/specs" aria-current={route === "specs" ? "page" : undefined}>规格</a>
          <a href={desktopReleaseUrl} target="_blank" rel="noreferrer">
            下载 <ArrowUpRight size={13} />
          </a>
          <a
            href="https://github.com/vibeforge2014/meeting-assistant"
            target="_blank"
            rel="noreferrer"
          >
            GitHub <ArrowUpRight size={13} />
          </a>
        </nav>

        <div className="site-nav__actions">
          <a className="site-button site-button--compact site-button--dark" href="#/app">
            在线体验 <ArrowRight size={15} />
          </a>
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

function LandingPage() {
  const [demoMode, setDemoMode] = useState<DemoMode>("record");
  const demo = featureDemo[demoMode];

  return (
    <main>
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
            <a className="site-button site-button--ghost" href="#/app">
              体验在线演示 <ArrowRight size={16} />
            </a>
          </div>
          <div className="hero__meta" aria-label="平台与隐私特性">
            <span><AppleLogo size={17} weight="fill" /> macOS 14.2+</span>
            <span><WindowsLogo size={17} weight="fill" /> Windows 10 22H2+</span>
            <span><LockKey size={17} weight="fill" /> 数据默认留在本机</span>
          </div>
        </div>

        <div className="product-stage" aria-label="会议助手产品界面预览">
          <div className="product-stage__glow" />
          <div className="product-window">
            <div className="product-window__bar">
              <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
              <span>产品团队周会 · 正在记录</span>
              <span className="window-live"><i /> LIVE</span>
            </div>
            <img src={productWorkspace} alt="会议助手桌面端三栏会议工作区" />
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

      <section className="signal-strip" aria-label="核心特性">
        <div><Waveform size={21} /><span><strong>实时转写</strong> 中文与中英混合</span></div>
        <div><Sparkle size={21} /><span><strong>滚动纪要</strong> 两分钟持续更新</span></div>
        <div><CloudSlash size={21} /><span><strong>本地优先</strong> 由你决定是否联网</span></div>
        <div><Export size={21} /><span><strong>开放导出</strong> 文档、字幕与备份</span></div>
      </section>

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

      <section className="closing-cta">
        <div className="closing-cta__orb" />
        <span className="section-kicker">少一点整理，多一点推进</span>
        <h2>下一场会议，<br />让结果自然留下来。</h2>
        <p>无需注册即可打开浏览器演示。你的修改只保存在当前设备。</p>
        <div className="hero__actions">
          <a className="site-button site-button--primary" href={desktopReleaseUrl} target="_blank" rel="noreferrer">
            <Desktop size={17} weight="bold" /> 下载桌面版
          </a>
          <a className="site-button site-button--ghost" href="#/app">打开在线演示</a>
        </div>
      </section>
    </main>
  );
}

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

function SpecsPage() {
  const [activeSection, setActiveSection] = useState("overview");

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
    <main className="spec-page">
      <section className="spec-hero">
        <span className="eyebrow-chip"><FileText size={15} weight="fill" /> 产品规格 · v0.1</span>
        <h1>功能边界，<br />清清楚楚。</h1>
        <p>从支持的平台、采集方式到数据存储和模型连接，一页了解会议助手当前版本的完整能力。</p>
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
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(section.id)?.scrollIntoView({
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
            intro="会议助手是本地优先的跨平台会议工作台。它把会前目标、会中笔记、实时转录、滚动纪要和会后行动项放在一个连贯空间里。"
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
              ["本地模型", "权重与 FFmpeg 按需配置，不静默打包"],
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

function SpecMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="spec-metric">
      <span>{icon}</span>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

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

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__brand">
        <BrandMark className="site-brand__mark" size={29} />
        <div><strong>会议助手</strong><span>让每一次讨论，都有清晰的下一步。</span></div>
      </div>
      <div className="site-footer__links">
        <a href="#/">产品</a>
        <a href="#/specs">规格</a>
        <a href="#/app">在线体验</a>
        <a href={desktopReleaseUrl} target="_blank" rel="noreferrer">下载桌面版</a>
        <a href="https://github.com/vibeforge2014/meeting-assistant" target="_blank" rel="noreferrer">
          <GithubLogo size={16} /> GitHub
        </a>
      </div>
      <p>© 2026 会议助手 · 本地优先的会议工作台</p>
    </footer>
  );
}

function getRoute(): SiteRoute {
  return window.location.hash.startsWith("#/specs") ? "specs" : "home";
}

function scrollToSection(event: ReactMouseEvent<HTMLAnchorElement>, id: string) {
  event.preventDefault();
  window.history.replaceState(null, "", `#${id}`);
  document.getElementById(id)?.scrollIntoView({
    block: "start",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  });
}
