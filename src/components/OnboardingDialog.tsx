import { Brain, Microphone, ShieldCheck } from "@phosphor-icons/react";
import { api } from "../lib/api";

export function OnboardingDialog({
  open,
  onComplete,
  onConfigureModels
}: {
  open: boolean;
  onComplete(): Promise<void>;
  onConfigureModels(): Promise<void>;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop onboarding-backdrop">
      <section className="dialog onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <header>
          <div>
            <h2 id="onboarding-title">欢迎使用会议助手</h2>
            <p>开始前，用一分钟确认录音权限、隐私和模型配置。</p>
          </div>
        </header>
        <div className="onboarding-items">
          <article>
            <Microphone size={23} weight="duotone" />
            <div><strong>录音权限</strong><p>线上会议会分别采集麦克风和系统音频；线下会议只采集麦克风。</p></div>
            <button className="button button--small" onClick={() => api.system.openSettings()}>打开系统设置</button>
          </article>
          <article>
            <ShieldCheck size={23} weight="duotone" />
            <div><strong>本地优先</strong><p>会议、录音与索引默认只保存在本机。仅在配置远程模型后发送必要内容。</p></div>
          </article>
          <article>
            <Brain size={23} weight="duotone" />
            <div><strong>按需配置模型</strong><p>可以先只录音和记笔记，也可以配置远程服务或本地 whisper.cpp。</p></div>
            <button className="button button--small" onClick={onConfigureModels}>配置模型</button>
          </article>
        </div>
        <footer>
          <span>录音前请确认已获得参会者同意。</span>
          <button className="button button--primary" onClick={onComplete}>开始使用</button>
        </footer>
      </section>
    </div>
  );
}
